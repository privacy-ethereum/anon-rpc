// §5 — Host-side harness API: `AnonRpcWorker`.
//
// Responsibilities (§3.1): verify bundle integrity (§4), run the worker under
// §6 isolation (Web Worker inside a null-origin sandboxed iframe), implement the
// capability API for the worker, and expose `fetch` to the host.

import type { WorkerInit, AnonFetchResponse } from "../spec-types.js";
import { PortRpc, RpcError } from "../protocol.js";
import { readSpecifier, fetchAndVerifyBundle } from "./specifier.js";
import { registerKpsBridge } from "./kps-bridge-host.js";
import { CallQueue } from "./call-queue.js";
import { normalizeRequest, type WireRequestInit } from "./normalize-request.js";

// Injected at build time (see build.mjs): source text the null-origin iframe
// blob-spawns, since an opaque-origin iframe cannot load host-origin scripts.
declare const __WORKER_RUNTIME_SRC__: string;
declare const __IFRAME_BOOT_SRC__: string;

// Storage namespaces, scoped by specifier address (§11). In-memory for the
// prototype; a real harness would back this with persistent storage.
const STORE = new Map<string, Map<string, Uint8Array>>();
function storeFor(address: string): Map<string, Uint8Array> {
  let m = STORE.get(address);
  if (!m) STORE.set(address, (m = new Map()));
  return m;
}

type CallRecord = {
  callId: number;
  url: string;
  requestInit?: WireRequestInit;
  bodyTransfer?: Transferable[];
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
  // Detaches the host-signal abort listener; called when the call settles.
  cleanup?: () => void;
};

export class AnonRpcWorker {
  ready: Promise<void>;
  fetch: typeof fetch;

  #init: WorkerInit;
  #rpc?: PortRpc;
  #iframe?: HTMLIFrameElement;
  #disposeKps?: () => void;
  #onWindowMessage?: (ev: MessageEvent) => void;

  // Calls awaiting acceptCall (§8: ordered, no drop, backpressured).
  #queue = new CallQueue<CallRecord>();
  #calls = new Map<number, CallRecord>();
  #nextCallId = 1;
  #readyResolve!: () => void;
  #readyReject!: (e: unknown) => void;

  constructor(init: WorkerInit) {
    this.#init = init;
    this.ready = new Promise<void>((res, rej) => {
      this.#readyResolve = res;
      this.#readyReject = rej;
    });
    // A caller need not await `ready` (e.g. close() before boot finishes);
    // this branch absorbs the rejection so it is never "unhandled", while
    // awaiting callers still observe it.
    this.ready.catch(() => {});
    // §5: `fetch` MUST be this-bound so it works as a free function.
    this.fetch = this.#fetch.bind(this);
    this.#boot().catch((e) => this.#readyReject(e));
  }

  async #boot(): Promise<void> {
    const provider = this.#init.preExisting?.rpcProvider;
    if (!provider) throw new Error("preExisting.rpcProvider is required to read the specifier");

    const spec = await readSpecifier(provider, this.#init.address);
    const bundleBytes = await fetchAndVerifyBundle(spec);

    const channel = new MessageChannel();
    const rpc = new PortRpc(channel.port1);
    this.#rpc = rpc;
    this.#registerHandlers(rpc);

    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts"); // §6: null origin, scripts only
    iframe.style.display = "none";
    iframe.srcdoc = `<!doctype html><meta charset="utf-8"><script>${__IFRAME_BOOT_SRC__}</script>`;
    this.#iframe = iframe;

    const ready = new Promise<void>((resolve) => {
      const onMessage = (ev: MessageEvent) => {
        if (ev.source !== iframe.contentWindow) return;
        if (ev.data?.kind === "iframe-ready") resolve();
        // Worker script-level errors (e.g. the runtime itself failing) must
        // surface instead of leaving `ready` pending forever.
        if (ev.data?.kind === "worker-error") {
          this.#readyReject(new Error(`worker error: ${ev.data.message}`));
        }
      };
      this.#onWindowMessage = onMessage;
      window.addEventListener("message", onMessage);
    });
    document.body.appendChild(iframe);
    await ready;

    iframe.contentWindow!.postMessage(
      { kind: "init", runtimeSource: __WORKER_RUNTIME_SRC__, bundleBytes },
      "*",
      [channel.port2],
    );

    // `this.ready` resolves when the worker emits "ready" (signalReady, §7).
  }

  #registerHandlers(rpc: PortRpc): void {
    this.#disposeKps = registerKpsBridge(rpc);

    rpc.onEvent("ready", () => this.#readyResolve());

    // The worker runtime reports a bundle that failed to load (§4-valid bytes
    // can still throw at top level); without this, `ready` would hang.
    rpc.onEvent("boot-error", ({ message }: { message: string }) => {
      this.#readyReject(new Error(`worker bundle failed to load: ${message}`));
    });

    rpc.onEvent("log", ({ level, args }: { level: string; args: unknown[] }) => {
      const fn = (console as any)[level] ?? console.log;
      fn.call(console, "[worker]", ...args.map(renderLogArg));
    });

    rpc.on("acceptCall", async (_args, { signal }) => {
      const rec = await this.#queue.take(signal);
      const value = {
        callId: rec.callId,
        url: rec.url,
        requestInit: rec.requestInit,
      };
      return { value, transfer: rec.bodyTransfer ?? [] };
    });

    rpc.on("respond", async (msg: {
      callId: number;
      ok: boolean;
      response?: AnonFetchResponse;
      error?: { name?: string; message?: string; code?: string };
    }) => {
      const rec = this.#calls.get(msg.callId);
      // Unknown callId is expected when the host aborted the call after the
      // worker had already accepted it — the late respond is dropped quietly.
      if (!rec) return { value: undefined };
      this.#calls.delete(msg.callId);
      rec.cleanup?.();
      if (msg.ok && msg.response) {
        rec.resolve(toResponse(msg.response));
      } else {
        // Preserve name/code across the boundary (§12: message is diagnostic
        // only; code is what host logic may branch on).
        const err = new Error(msg.error?.message ?? "worker failed the call");
        if (msg.error?.name) err.name = msg.error.name;
        if (msg.error?.code) (err as { code?: string }).code = msg.error.code;
        rec.reject(err);
      }
      return { value: undefined };
    });

    const store = storeFor(this.#init.address);
    rpc.on("storage.get", async ({ key }) => ({ value: store.get(key) }));
    rpc.on("storage.set", async ({ key, value }) => {
      store.set(key, value);
      return { value: undefined };
    });
    rpc.on("storage.delete", async ({ key }) => {
      store.delete(key);
      return { value: undefined };
    });
    rpc.on("storage.has", async ({ key }) => ({ value: store.has(key) }));
    rpc.on("storage.list", async ({ prefix }: { prefix?: string }) => ({
      value: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)),
    }));
    rpc.on("storage.clear", async ({ prefix }: { prefix?: string }) => {
      if (!prefix) store.clear();
      else for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
      return { value: undefined };
    });
  }

  async #fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const { url, requestInit, transfer, signal: hostSignal } = await normalizeRequest(input, init);
    const callId = this.#nextCallId++;

    return new Promise<Response>((resolve, reject) => {
      const rec: CallRecord = {
        callId,
        url,
        requestInit,
        bodyTransfer: transfer,
        resolve,
        reject,
      };
      this.#calls.set(callId, rec);

      if (hostSignal) {
        const onAbort = () => {
          // Not yet delivered: withdraw it from the queue so the worker never
          // sees a dead call. Already delivered: tell the worker to abort it.
          if (!this.#queue.remove(rec)) this.#rpc?.emit("call-abort", { callId });
          if (this.#calls.delete(callId)) {
            reject(hostSignal.reason ?? new DOMException("aborted", "AbortError"));
          }
        };
        if (hostSignal.aborted) {
          this.#calls.delete(callId);
          reject(hostSignal.reason ?? new DOMException("aborted", "AbortError"));
          return;
        }
        hostSignal.addEventListener("abort", onAbort, { once: true });
        rec.cleanup = () => hostSignal.removeEventListener("abort", onAbort);
      }
      this.#queue.push(rec);
    });
  }

  close(): void {
    this.#disposeKps?.();
    if (this.#onWindowMessage) window.removeEventListener("message", this.#onWindowMessage);
    this.#iframe?.remove();
    const err = new Error("worker closed");
    this.#readyReject(err); // no-op if ready already resolved
    for (const rec of this.#calls.values()) {
      rec.cleanup?.();
      rec.reject(err);
    }
    this.#calls.clear();
    this.#queue.rejectAll(err);
  }
}

function renderLogArg(a: unknown): unknown {
  if (a instanceof Uint8Array) return `<${a.byteLength} bytes>`;
  return a;
}

function toResponse(r: AnonFetchResponse): Response {
  const headers = new Headers();
  for (const [k, v] of r.headers) headers.append(k, v);
  const status = r.status;
  // 204/205/304 must have a null body.
  const body = status === 204 || status === 205 || status === 304 ? null : (r.body as BodyInit);
  return new Response(body, { status, headers });
}

export { RpcError };
