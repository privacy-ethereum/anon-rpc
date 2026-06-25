// Worker side of the capability API. Builds the `anonRpcWorker` object that
// untrusted worker code sees as its entire platform (§7). Every method is a thin
// proxy across the capability port; KPS stream byte flow rides transferred
// WHATWG streams, so only lifecycle calls round-trip.

import type {
  AnonRpcWorkerApi,
  FetchCall,
  AnonFetchResponse,
  AnonRequestInit,
  KpsApi,
  KpsConn,
  KpsStream,
  KpsConnCloseInfo,
  KpsStreamCloseInfo,
  KpsReason,
  KpsDialOptions,
  StorageApi,
  StorageKey,
  LogApi,
  LogArg,
} from "../spec-types.js";
import { PortRpc } from "../protocol.js";

type StreamParts = {
  streamId: number;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

export function makeWorkerApi(rpc: PortRpc): AnonRpcWorkerApi {
  // AbortControllers for delivered calls; host emits "call-abort" when its
  // fetch caller aborts (the call's signal originates host-side).
  const callAborts = new Map<number, AbortController>();
  rpc.onEvent("call-abort", ({ callId }: { callId: number }) => {
    callAborts.get(callId)?.abort(new DOMException("aborted", "AbortError"));
  });

  function makeStream(p: StreamParts): KpsStream {
    let closed: Promise<KpsStreamCloseInfo> | undefined;
    return {
      readable: p.readable,
      writable: p.writable,
      closeWrite: () => rpc.call("stream.closeWrite", { streamId: p.streamId }),
      cancelRead: (reason?: KpsReason) => rpc.call("stream.cancelRead", { streamId: p.streamId, reason }),
      resetWrite: (reason?: KpsReason) => rpc.call("stream.resetWrite", { streamId: p.streamId, reason }),
      close: (reason?: KpsReason) => rpc.call("stream.close", { streamId: p.streamId, reason }),
      get closed() {
        return (closed ??= rpc.call<KpsStreamCloseInfo>("stream.awaitClosed", { streamId: p.streamId }));
      },
    };
  }

  function makeConn(connId: number, datagramsIncoming: ReadableStream<Uint8Array>): KpsConn {
    let closed: Promise<KpsConnCloseInfo> | undefined;
    return {
      openStream: async (opts) =>
        makeStream(await rpc.call<StreamParts>("conn.openStream", { connId }, sigOpt(opts))),
      acceptStream: async (opts) =>
        makeStream(await rpc.call<StreamParts>("conn.acceptStream", { connId }, sigOpt(opts))),
      close: (reason?: KpsReason) => rpc.call("conn.close", { connId, reason }),
      datagrams: {
        send: (data, opts) => rpc.call("conn.dgram.send", { connId, data }, sigOpt(opts)),
        incoming: datagramsIncoming,
      },
      get closed() {
        return (closed ??= rpc.call<KpsConnCloseInfo>("conn.awaitClosed", { connId }));
      },
    };
  }

  const kps: KpsApi = {
    dial: async (addr, opts) => {
      const { connId, datagramsIncoming } = await rpc.call<{
        connId: number;
        datagramsIncoming: ReadableStream<Uint8Array>;
      }>("kps.dial", { addr, opts: serializeDialOpts(opts) }, sigOpt(opts));
      return makeConn(connId, datagramsIncoming);
    },
    openStream: async (addr, opts) =>
      makeStream(await rpc.call<StreamParts>("kps.openStream", { addr, opts: serializeDialOpts(opts) }, sigOpt(opts))),
  };

  const storage: StorageApi = {
    get: (key) => rpc.call("storage.get", { key }),
    set: (key, value) => rpc.call("storage.set", { key, value }),
    delete: (key) => rpc.call("storage.delete", { key }),
    has: (key) => rpc.call("storage.has", { key }),
    clear: (opts) => rpc.call("storage.clear", { prefix: opts?.prefix }),
    list: (opts) => listKeys(rpc, opts?.prefix),
  };

  const log: LogApi = {
    debug: (...args: LogArg[]) => rpc.emit("log", { level: "debug", args }),
    info: (...args: LogArg[]) => rpc.emit("log", { level: "info", args }),
    warn: (...args: LogArg[]) => rpc.emit("log", { level: "warn", args }),
    error: (...args: LogArg[]) => rpc.emit("log", { level: "error", args }),
  };

  return {
    signalReady: () => rpc.emit("ready", {}),
    acceptCall: async (opts) => {
      const { callId, url, requestInit } = await rpc.call<{
        callId: number;
        url: string;
        requestInit?: AnonRequestInit & { hasSignal?: boolean };
      }>("acceptCall", {}, sigOpt(opts));
      return makeFetchCall(rpc, callAborts, callId, url, requestInit);
    },
    kps,
    storage,
    log,
  };
}

function makeFetchCall(
  rpc: PortRpc,
  callAborts: Map<number, AbortController>,
  callId: number,
  url: string,
  wireInit?: AnonRequestInit & { hasSignal?: boolean },
): FetchCall {
  let requestInit: AnonRequestInit | undefined;
  if (wireInit) {
    const { hasSignal, ...rest } = wireInit;
    requestInit = rest;
    if (hasSignal) {
      const ac = new AbortController();
      callAborts.set(callId, ac);
      requestInit = { ...rest, signal: ac.signal };
    }
  }

  let responded = false;
  return {
    kind: "fetch",
    url,
    ...(requestInit ? { requestInit } : {}),
    respond(response: AnonFetchResponse | Promise<AnonFetchResponse>) {
      if (responded) throw new Error("respond() called more than once");
      responded = true;
      Promise.resolve(response)
        .then((r) => {
          const transfer = r.body instanceof ReadableStream ? [r.body as unknown as Transferable] : [];
          return rpc.call("respond", { callId, ok: true, response: r }, { transfer });
        })
        .catch((e: unknown) =>
          rpc.call("respond", { callId, ok: false, error: { message: (e as Error)?.message ?? String(e) } }),
        )
        .finally(() => callAborts.delete(callId));
    },
  };
}

async function* listKeys(rpc: PortRpc, prefix?: string): AsyncIterable<StorageKey> {
  const keys = await rpc.call<StorageKey[]>("storage.list", { prefix });
  for (const k of keys) yield k;
}

function serializeDialOpts(opts?: KpsDialOptions): { timeoutMs?: number } | undefined {
  if (opts?.timeoutMs == null) return undefined;
  return { timeoutMs: opts.timeoutMs };
}

function sigOpt(opts?: { signal?: AbortSignal }): { signal?: AbortSignal } | undefined {
  return opts?.signal ? { signal: opts.signal } : undefined;
}
