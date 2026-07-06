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
  // fetch caller aborts (the call's signal originates host-side). An abort can
  // race the acceptCall response across the port, so aborts for calls not yet
  // registered are remembered and applied on delivery.
  const callAborts = new Map<number, AbortController>();
  const preAborted = new Set<number>();
  rpc.onEvent("call-abort", ({ callId }: { callId: number }) => {
    const ac = callAborts.get(callId);
    if (ac) ac.abort(new DOMException("aborted", "AbortError"));
    else preAborted.add(callId);
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

  function makeConn(connId: number): KpsConn {
    let closed: Promise<KpsConnCloseInfo> | undefined;
    return {
      openStream: async (opts) =>
        makeStream(await rpc.call<StreamParts>("conn.openStream", { connId }, sigOpt(opts))),
      acceptStream: async (opts) =>
        makeStream(await rpc.call<StreamParts>("conn.acceptStream", { connId }, sigOpt(opts))),
      close: (reason?: KpsReason) => rpc.call("conn.close", { connId, reason }),
      sendDatagram: (data, opts) => rpc.call("conn.sendDatagram", { connId, data }, sigOpt(opts)),
      receiveDatagram: (opts) => rpc.call<Uint8Array>("conn.receiveDatagram", { connId }, sigOpt(opts)),
      get closed() {
        return (closed ??= rpc.call<KpsConnCloseInfo>("conn.awaitClosed", { connId }));
      },
    };
  }

  const kps: KpsApi = {
    dial: async (addr, opts) => {
      const { connId } = await rpc.call<{ connId: number }>("kps.dial", { addr }, sigOpt(opts));
      return makeConn(connId);
    },
    openStream: async (addr, opts) =>
      makeStream(await rpc.call<StreamParts>("kps.openStream", { addr }, sigOpt(opts))),
  };

  const storage: StorageApi = {
    get: (key, opts) => rpc.call("storage.get", { key }, sigOpt(opts)),
    set: (key, value, opts) => rpc.call("storage.set", { key, value }, sigOpt(opts)),
    delete: (key, opts) => rpc.call("storage.delete", { key }, sigOpt(opts)),
    has: (key, opts) => rpc.call("storage.has", { key }, sigOpt(opts)),
    clear: (opts) => rpc.call("storage.clear", { prefix: opts?.prefix }, sigOpt(opts)),
    list: (opts) => listKeys(rpc, opts?.prefix, opts?.signal),
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
      return makeFetchCall(rpc, callAborts, preAborted, callId, url, requestInit);
    },
    kps,
    storage,
    log,
  };
}

function makeFetchCall(
  rpc: PortRpc,
  callAborts: Map<number, AbortController>,
  preAborted: Set<number>,
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
      // The host's abort may have crossed the port before this call arrived.
      if (preAborted.delete(callId)) ac.abort(new DOMException("aborted", "AbortError"));
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
          // Carry name/code across the boundary (§12): host logic may branch
          // on code, never on message text.
          rpc.call("respond", { callId, ok: false, error: serializeRespondError(e) }),
        )
        .catch(() => {}) // the failure respond itself may be refused (e.g. call already aborted)
        .finally(() => callAborts.delete(callId));
    },
  };
}

function serializeRespondError(e: unknown): { name?: string; message: string; code?: string } {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return {
      name: e.name,
      message: e.message,
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { message: String(e) };
}

async function* listKeys(rpc: PortRpc, prefix?: string, signal?: AbortSignal): AsyncIterable<StorageKey> {
  const keys = await rpc.call<StorageKey[]>("storage.list", { prefix }, signal ? { signal } : undefined);
  for (const k of keys) yield k;
}

function sigOpt(opts?: { signal?: AbortSignal }): { signal?: AbortSignal } | undefined {
  return opts?.signal ? { signal: opts.signal } : undefined;
}
