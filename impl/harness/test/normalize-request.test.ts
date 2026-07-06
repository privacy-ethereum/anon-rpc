import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRequest } from "../src/host/normalize-request.js";

const dec = new TextDecoder();

async function drain(body: Uint8Array | ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!body) return "";
  if (body instanceof Uint8Array) return dec.decode(body);
  return dec.decode(new Uint8Array(await new Response(body).arrayBuffer()));
}

test("bare string URL produces no requestInit", async () => {
  const n = await normalizeRequest("http://x.test/a");
  assert.equal(n.url, "http://x.test/a");
  assert.equal(n.requestInit, undefined);
  assert.equal(n.signal, undefined);
});

test("URL object input", async () => {
  const n = await normalizeRequest(new URL("http://x.test/b?q=1"));
  assert.equal(n.url, "http://x.test/b?q=1");
});

test("init with method/headers/string body", async () => {
  const n = await normalizeRequest("http://x.test/", {
    method: "POST",
    headers: { "x-a": "1" },
    body: "hello",
  });
  assert.equal(n.requestInit?.method, "POST");
  assert.deepEqual(n.requestInit?.headers, [["x-a", "1"]]);
  assert.ok(n.requestInit?.body instanceof Uint8Array);
  assert.equal(await drain(n.requestInit?.body), "hello");
  assert.equal(n.requestInit?.hasSignal, undefined);
});

test("init signal is surfaced and flagged", async () => {
  const ac = new AbortController();
  const n = await normalizeRequest("http://x.test/", { signal: ac.signal });
  assert.equal(n.signal, ac.signal);
  assert.equal(n.requestInit?.hasSignal, true);
});

test("ReadableStream body is passed through for transfer, not buffered", async () => {
  const stream = new Blob(["streamed"]).stream();
  const n = await normalizeRequest("http://x.test/", { method: "POST", body: stream });
  assert.equal(n.requestInit?.body, stream);
  assert.ok(n.transfer?.includes(stream as unknown as Transferable));
});

test("Request input carries method/headers/body/signal (§5 typeof fetch)", async () => {
  const req = new Request("http://x.test/req", {
    method: "POST",
    headers: { "x-b": "2" },
    body: "req-body",
  });
  const n = await normalizeRequest(req);
  assert.equal(n.url, "http://x.test/req");
  assert.equal(n.requestInit?.method, "POST");
  assert.ok(n.requestInit?.headers?.some(([k, v]) => k === "x-b" && v === "2"));
  assert.equal(n.requestInit?.hasSignal, true);
  assert.equal(n.signal, req.signal);
  // Request bodies are streams; it must be transferred, and carry the bytes.
  assert.ok(n.requestInit?.body instanceof ReadableStream);
  assert.ok(n.transfer?.length === 1);
  assert.equal(await drain(n.requestInit?.body), "req-body");
});

test("init overrides a Request input's fields", async () => {
  const req = new Request("http://x.test/req", { method: "POST", body: "orig" });
  const n = await normalizeRequest(req, { method: "PUT", body: "override" });
  assert.equal(n.requestInit?.method, "PUT");
  assert.equal(await drain(n.requestInit?.body), "override");
});
