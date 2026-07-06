// §5 — Host-side harness API: `AnonRpcWorker`.
//
// Responsibilities (§3.1): verify bundle integrity (§4), run the worker under
// §6 isolation (Web Worker inside a null-origin sandboxed iframe), implement the
// capability API for the worker, and expose `fetch` to the host.

import type {
  WorkerInit,
  AnonRequestInit,
  AnonFetchResponse,
  HeaderList,
} from "../spec-types.js";
import { PortRpc, RpcError } from "../protocol.js";
import { readSpecifier, fetchAndVerifyBundle } from "./specifier.js";
import { registerKpsBridge } from "./kps-bridge-host.js";

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

type WireRequestInit = {
  method?: string;
  headers?: HeaderList;
  body?: Uint8Array | ReadableStream<Uint8Array>;
  redirect?: AnonRequestInit["redirect"];
  hasSignal?: boolean;
};

type CallRecord = {
  callId: number;
  url: string;
  requestInit?: WireRequestInit;
  bodyTransfer?: Transferable[];
  hostSignal?: AbortSignal;
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
};

export class AnonRpcWorker {
  ready: Promise<void>;
  fetch: typeof fetch;

  #init: WorkerInit;
  #rpc?: PortRpc;
  #iframe?: HTMLIFrameElement;
  #disposeKps?: () => void;
  #onWindowMessage?: (ev: MessageEvent) => void;

  // FIFO of calls awaiting acceptCall (§8: ordered, no drop, backpressured).
  #queue: CallRecord[] = [];
  #waiter?: { resolve: (c: CallRecord) => void; reject: (e: unknown) => void; signal?: AbortSignal };
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

    rpc.onEvent("log", ({ level, args }: { level: string; args: unknown[] }) => {
      const fn = (console as any)[level] ?? console.log;
      fn.call(console, "[worker]", ...args.map(renderLogArg));
    });

    rpc.on("acceptCall", async (_args, { signal }) => {
      const rec = await this.#takeCall(signal);
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
      error?: { message: string };
    }) => {
      const rec = this.#calls.get(msg.callId);
      if (!rec) throw new Error(`respond for unknown callId ${msg.callId}`);
      this.#calls.delete(msg.callId);
      if (msg.ok && msg.response) rec.resolve(toResponse(msg.response));
      else rec.reject(new Error(msg.error?.message ?? "worker failed the call"));
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

  #takeCall(signal: AbortSignal): Promise<CallRecord> {
    const next = this.#queue.shift();
    if (next) return Promise.resolve(next);
    return new Promise<CallRecord>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiter = { resolve, reject, signal };
    });
  }

  #enqueue(rec: CallRecord): void {
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = undefined;
      w.resolve(rec);
    } else {
      this.#queue.push(rec);
    }
  }

  async #fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const { url, requestInit, transfer } = await normalizeRequest(input, init);
    const callId = this.#nextCallId++;
    const hostSignal = (init?.signal ?? undefined) as AbortSignal | undefined;

    return new Promise<Response>((resolve, reject) => {
      const rec: CallRecord = {
        callId,
        url,
        requestInit,
        bodyTransfer: transfer,
        ...(hostSignal ? { hostSignal } : {}),
        resolve,
        reject,
      };
      this.#calls.set(callId, rec);

      if (hostSignal) {
        const onAbort = () => {
          this.#rpc?.emit("call-abort", { callId });
          if (this.#calls.delete(callId)) reject(hostSignal.reason ?? new DOMException("aborted", "AbortError"));
        };
        if (hostSignal.aborted) return onAbort();
        hostSignal.addEventListener("abort", onAbort, { once: true });
      }
      this.#enqueue(rec);
    });
  }

  close(): void {
    this.#disposeKps?.();
    if (this.#onWindowMessage) window.removeEventListener("message", this.#onWindowMessage);
    this.#iframe?.remove();
    const err = new Error("worker closed");
    for (const rec of this.#calls.values()) rec.reject(err);
    this.#calls.clear();
    this.#waiter?.reject(err);
  }
}

function renderLogArg(a: unknown): unknown {
  if (a instanceof Uint8Array) return `<${a.byteLength} bytes>`;
  return a;
}

function headersToList(h: HeadersInit | undefined): HeaderList | undefined {
  if (!h) return undefined;
  const out: HeaderList = [];
  if (h instanceof Headers) h.forEach((v, k) => out.push([k, v]));
  else if (Array.isArray(h)) for (const [k, v] of h) out.push([k, v]);
  else for (const [k, v] of Object.entries(h)) out.push([k, String(v)]);
  return out;
}

async function normalizeRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ url: string; requestInit?: WireRequestInit; transfer?: Transferable[] }> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!init && typeof input !== "object") return { url };

  const src = init ?? {};
  const transfer: Transferable[] = [];
  let body: WireRequestInit["body"];
  if (src.body != null) {
    if (src.body instanceof ReadableStream) {
      body = src.body;
      transfer.push(src.body as unknown as Transferable);
    } else if (typeof src.body === "string") {
      body = new TextEncoder().encode(src.body);
    } else if (src.body instanceof Uint8Array) {
      body = src.body;
    } else if (src.body instanceof ArrayBuffer) {
      body = new Uint8Array(src.body);
    } else {
      body = new Uint8Array(await new Response(src.body as BodyInit).arrayBuffer());
    }
  }

  const requestInit: WireRequestInit = {};
  if (src.method) requestInit.method = src.method;
  const headers = headersToList(src.headers);
  if (headers) requestInit.headers = headers;
  if (body !== undefined) requestInit.body = body;
  if (src.redirect) requestInit.redirect = src.redirect;
  if (src.signal) requestInit.hasSignal = true;

  return { url, requestInit, transfer };
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
