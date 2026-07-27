import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, deflateSync } from "node:zlib";
import {
  parseKpsResolver,
  buildKpsHttpRequest,
  parseKpsHttpResponse,
  ambientCodings,
  decodeBody,
} from "../src/host/kps-http.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

test("parseKpsResolver splits at the first slash (§4.1)", () => {
  const r = parseKpsResolver("kps:198.51.100.7:12298:uEiAxk9Qw/keccak/19/4f04");
  assert.deepEqual(r, { addr: "198.51.100.7:12298:uEiAxk9Qw", path: "/keccak/19/4f04" });
});

test("parseKpsResolver handles bracketed IPv6 addresses", () => {
  const r = parseKpsResolver("kps:[2001:db8::7]:12298:uEiAxk9Qw/w.js");
  assert.deepEqual(r, { addr: "[2001:db8::7]:12298:uEiAxk9Qw", path: "/w.js" });
});

test("parseKpsResolver returns undefined for non-kps entries", () => {
  assert.equal(parseKpsResolver("https://r.test/w.js"), undefined);
  assert.equal(parseKpsResolver("ipfs://bafy…"), undefined);
});

test("parseKpsResolver throws on kps entries missing a path", () => {
  assert.throws(() => parseKpsResolver("kps:1.2.3.4:1:uEiA"), /missing \/path/);
});

test("buildKpsHttpRequest emits the §4.2 request with certhash Host", () => {
  const req = dec.decode(buildKpsHttpRequest("/keccak/ab/cd", "uEiAxk9Qw"));
  assert.equal(req, "GET /keccak/ab/cd HTTP/1.1\r\nHost: uEiAxk9Qw\r\n\r\n");
});

test("parseKpsHttpResponse parses status, headers, and EOF-delimited body", () => {
  const body = new Uint8Array([1, 2, 3, 13, 10, 13, 10, 4]); // body may contain CRLFCRLF
  const head = enc.encode("HTTP/1.1 200 OK\r\ncontent-type: text/javascript\r\ncontent-length: 999\r\n\r\n");
  const all = new Uint8Array([...head, ...body]);
  const r = parseKpsHttpResponse(all);
  assert.equal(r.status, 200);
  assert.deepEqual(r.headers[0], ["content-type", "text/javascript"]);
  assert.deepEqual([...r.body], [...body]); // Content-Length is advisory: body is EOF-delimited
});

test("parseKpsHttpResponse abandons on Transfer-Encoding (§4.2)", () => {
  const all = enc.encode("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n");
  assert.throws(() => parseKpsHttpResponse(all), /Transfer-Encoding/);
});

test("parseKpsHttpResponse rejects malformed responses", () => {
  assert.throws(() => parseKpsHttpResponse(enc.encode("not http")), /header terminator/);
  assert.throws(() => parseKpsHttpResponse(enc.encode("SIP/2.0 200 OK\r\n\r\n")), /status line/);
  assert.throws(() => parseKpsHttpResponse(enc.encode("HTTP/1.1 200 OK\r\nbroken line\r\n\r\n")), /header line/);
});

test("ambientCodings advertises what DecompressionStream can decode (§4.2)", () => {
  const codings = ambientCodings();
  // node ships gzip + deflate; whatever else appears must still be a real
  // HTTP coding we probed (never something undecodable).
  assert.ok(codings.includes("gzip"));
  assert.ok(codings.includes("deflate"));
  for (const c of codings) assert.ok(["zstd", "br", "gzip", "deflate"].includes(c));
});

test("buildKpsHttpRequest advertises codings; omits the header when none", () => {
  const withCodings = dec.decode(buildKpsHttpRequest("/w.js", "uEiA", ["gzip", "deflate"]));
  assert.equal(withCodings, "GET /w.js HTTP/1.1\r\nHost: uEiA\r\nAccept-Encoding: gzip, deflate\r\n\r\n");
  const bare = dec.decode(buildKpsHttpRequest("/w.js", "uEiA"));
  assert.equal(bare, "GET /w.js HTTP/1.1\r\nHost: uEiA\r\n\r\n");
});

test("decodeBody round-trips gzip and deflate", async () => {
  const original = enc.encode("// the worker bundle bytes ".repeat(50));
  const cases: [string, (b: Uint8Array) => Uint8Array][] = [
    ["gzip", gzipSync],
    ["deflate", deflateSync],
  ];
  for (const [coding, compress] of cases) {
    const decoded = await decodeBody(coding, new Uint8Array(compress(original)), 1 << 20);
    assert.deepEqual(decoded, original);
  }
});

test("decodeBody enforces the cap on DECODED bytes (zip bomb, §4.2)", async () => {
  // ~1 MiB of zeros compresses to ~1 KiB: the wire size passes any cap the
  // decoded size violates.
  const bomb = new Uint8Array(gzipSync(new Uint8Array(1 << 20)));
  assert.ok(bomb.byteLength < 8192);
  await assert.rejects(decodeBody("gzip", bomb, 64 * 1024), /decoded body exceeds/);
});

test("decodeBody rejects undecodable codings", async () => {
  await assert.rejects(decodeBody("x-magic", new Uint8Array([1]), 1024), /undecodable/);
});
