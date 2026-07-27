import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseKpsResolver,
  buildKpsHttpRequest,
  parseKpsHttpResponse,
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
