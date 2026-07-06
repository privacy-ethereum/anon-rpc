// The passthrough worker: the minimal anon-rpc worker template (the §3.2
// conformance target, hash-pinned). Copy this directory to start your own
// anon-client.
//
// This is untrusted third-party code from the harness's point of view: its
// only platform is the global `anonRpcWorker` capability object (§7) plus the
// ambient `fetch` the worker environment happens to provide. It imports
// nothing at runtime — it is bundled to a standalone IIFE whose bytes are
// hashed (§4).
//
// It does exactly one thing: fulfil every fetch call with a plain `fetch`
// passthrough. That plain `fetch` is the single seam a production anon-client
// replaces with anonymized routing (e.g. over `anonRpcWorker.kps`).

import type {
  AnonRpcWorkerApi,
  AnonFetchResponse,
  AnonRequestInit,
  ByteBody,
  HeaderList,
} from "./spec-types.js";

declare const anonRpcWorker: AnonRpcWorkerApi;

(async () => {
  anonRpcWorker.signalReady();

  for (;;) {
    let call;
    try {
      call = await anonRpcWorker.acceptCall();
    } catch (e) {
      anonRpcWorker.log.error("acceptCall failed:", (e as Error)?.message ?? String(e));
      return;
    }
    if (call.kind !== "fetch") continue; // ignore unknown kinds (§8)
    call.respond(passthrough(call.url, call.requestInit));
  }
})();

async function passthrough(url: string, init?: AnonRequestInit): Promise<AnonFetchResponse> {
  const resp = await fetch(url, await toFetchInit(init));
  const headers: HeaderList = [];
  resp.headers.forEach((v, k) => headers.push([k, v]));
  return {
    status: resp.status,
    headers,
    body: new Uint8Array(await resp.arrayBuffer()),
    url: resp.url,
  };
}

async function toFetchInit(init?: AnonRequestInit): Promise<RequestInit | undefined> {
  if (!init) return undefined;
  const out: RequestInit = {};
  if (init.method) out.method = init.method;
  if (init.headers) out.headers = init.headers as [string, string][];
  if (init.body) {
    // A streaming body is buffered before handing it to fetch: Chromium
    // rejects stream bodies without `duplex: "half"`, and even with it only
    // supports upload streaming over HTTP/2 — buffering works everywhere.
    out.body = init.body instanceof ReadableStream ? ((await readAll(init.body)) as BodyInit) : (init.body as BodyInit);
  }
  if (init.redirect) out.redirect = init.redirect;
  if (init.signal) out.signal = init.signal;
  return out;
}

async function readAll(body: ByteBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
