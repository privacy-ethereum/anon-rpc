import { test } from "node:test";
import assert from "node:assert/strict";
import { PortRpc, RpcError } from "../src/protocol.js";

function pair(): { a: PortRpc; b: PortRpc; close: () => void } {
  const ch = new MessageChannel();
  return {
    a: new PortRpc(ch.port1 as unknown as MessagePort),
    b: new PortRpc(ch.port2 as unknown as MessagePort),
    close: () => {
      ch.port1.close();
      ch.port2.close();
    },
  };
}

test("request/response round-trip", async () => {
  const { a, b, close } = pair();
  try {
    b.on("add", ({ x, y }) => ({ value: x + y }));
    assert.equal(await a.call("add", { x: 2, y: 3 }), 5);
  } finally {
    close();
  }
});

test("handler errors preserve name and code (§12)", async () => {
  const { a, b, close } = pair();
  try {
    b.on("boom", () => {
      const e = new Error("kaput");
      e.name = "KpsError";
      (e as { code?: string }).code = "network-error";
      throw e;
    });
    const err = await a.call("boom").then(
      () => assert.fail("should reject"),
      (e: unknown) => e as RpcError,
    );
    assert.ok(err instanceof RpcError);
    assert.equal(err.name, "KpsError");
    assert.equal(err.message, "kaput");
    assert.equal(err.code, "network-error");
  } finally {
    close();
  }
});

test("unknown method rejects", async () => {
  const { a, close } = pair();
  try {
    await assert.rejects(a.call("nope"), /no handler/);
  } finally {
    close();
  }
});

test("events are delivered", async () => {
  const { a, b, close } = pair();
  try {
    const got = new Promise((resolve) => b.onEvent("ping", resolve));
    a.emit("ping", { n: 7 });
    assert.deepEqual(await got, { n: 7 });
  } finally {
    close();
  }
});

test("abort rejects locally even if the peer never answers", async () => {
  const { a, b, close } = pair();
  try {
    let handlerSignalAborted = false;
    b.on("hang", (_args, { signal }) => {
      return new Promise(() => {
        signal.addEventListener("abort", () => {
          handlerSignalAborted = true;
        });
      });
    });
    const ac = new AbortController();
    const p = a.call("hang", {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(p, (e: Error) => e.name === "AbortError");
    // give the abort wire message a beat to reach the peer handler
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(handlerSignalAborted, true);
  } finally {
    close();
  }
});

test("pre-aborted signal rejects without posting", async () => {
  const { a, close } = pair();
  try {
    await assert.rejects(
      a.call("anything", {}, { signal: AbortSignal.abort() }),
      (e: Error) => e.name === "AbortError",
    );
  } finally {
    close();
  }
});

test("late response after abort is ignored and later calls still work", async () => {
  const { a, b, close } = pair();
  try {
    b.on("slow", async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { value: "late" };
    });
    b.on("echo", (args) => ({ value: args }));
    const ac = new AbortController();
    const p = a.call("slow", {}, { signal: ac.signal });
    ac.abort();
    await assert.rejects(p, (e: Error) => e.name === "AbortError");
    await new Promise((r) => setTimeout(r, 50)); // late "res" arrives, must be dropped
    assert.equal(await a.call("echo", "still-alive"), "still-alive");
  } finally {
    close();
  }
});
