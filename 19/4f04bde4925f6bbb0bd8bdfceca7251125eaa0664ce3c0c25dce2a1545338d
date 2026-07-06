"use strict";
(() => {
  // src/passthrough-worker.ts
  (async () => {
    anonRpcWorker.signalReady();
    for (; ; ) {
      let call;
      try {
        call = await anonRpcWorker.acceptCall();
      } catch (e) {
        anonRpcWorker.log.error("acceptCall failed:", e?.message ?? String(e));
        return;
      }
      if (call.kind !== "fetch") continue;
      call.respond(passthrough(call.url, call.requestInit));
    }
  })();
  async function passthrough(url, init) {
    const resp = await fetch(url, await toFetchInit(init));
    const headers = [];
    resp.headers.forEach((v, k) => headers.push([k, v]));
    return {
      status: resp.status,
      headers,
      body: new Uint8Array(await resp.arrayBuffer()),
      url: resp.url
    };
  }
  async function toFetchInit(init) {
    if (!init) return void 0;
    const out = {};
    if (init.method) out.method = init.method;
    if (init.headers) out.headers = init.headers;
    if (init.body) {
      out.body = init.body instanceof ReadableStream ? await readAll(init.body) : init.body;
    }
    if (init.redirect) out.redirect = init.redirect;
    if (init.signal) out.signal = init.signal;
    return out;
  }
  async function readAll(body) {
    if (body instanceof Uint8Array) return body;
    const chunks = [];
    let total = 0;
    const reader = body.getReader();
    for (; ; ) {
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
})();
