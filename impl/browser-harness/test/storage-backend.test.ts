// openStorageBackend returns the memory fallback in Node (no indexedDB); the
// IndexedDB implementation behind the same interface is exercised by the e2e
// (including persistence across page reloads).

import { test } from "node:test";
import assert from "node:assert/strict";
import { openStorageBackend } from "../src/host/idb-storage.js";

const A = "0xaaa";
const B = "0xbbb";
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : undefined);

test("get/set/has/delete round-trip", async () => {
  const s = await openStorageBackend();
  assert.equal(await s.get(A, "k"), undefined);
  assert.equal(await s.has(A, "k"), false);
  await s.set(A, "k", bytes("v1"));
  assert.equal(text(await s.get(A, "k")), "v1");
  assert.equal(await s.has(A, "k"), true);
  await s.set(A, "k", bytes("v2")); // replace
  assert.equal(text(await s.get(A, "k")), "v2");
  await s.delete(A, "k");
  assert.equal(await s.get(A, "k"), undefined);
});

test("namespaces are isolated by address (§11)", async () => {
  const s = await openStorageBackend();
  await s.set(A, "shared-key", bytes("from-A"));
  await s.set(B, "shared-key", bytes("from-B"));
  assert.equal(text(await s.get(A, "shared-key")), "from-A");
  assert.equal(text(await s.get(B, "shared-key")), "from-B");
  await s.clear(A);
  assert.equal(await s.get(A, "shared-key"), undefined);
  assert.equal(text(await s.get(B, "shared-key")), "from-B");
});

test("listKeys honors prefix", async () => {
  const s = await openStorageBackend();
  await s.set(A, "peers/1", bytes("x"));
  await s.set(A, "peers/2", bytes("x"));
  await s.set(A, "stats/count", bytes("x"));
  assert.deepEqual((await s.listKeys(A, "peers/")).sort(), ["peers/1", "peers/2"]);
  assert.equal((await s.listKeys(A)).length, 3);
});

test("clear with prefix removes only matching keys (§11)", async () => {
  const s = await openStorageBackend();
  await s.set(A, "peers/1", bytes("x"));
  await s.set(A, "stats/count", bytes("x"));
  await s.clear(A, "peers/");
  assert.deepEqual(await s.listKeys(A), ["stats/count"]);
});
