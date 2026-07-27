// Host side of the KPS bridge.
//
// The harness runs the REAL kps client (WebRTC) on the host, and exposes it to
// the worker over the capability port. This is the whole point of the `kps`
// capability (§10, draft rationale): worker code never touches WebRTC, so it is
// not locked to the web. Connections and streams are referenced by opaque ids;
// stream readable/writable are transferred to the worker (transferable
// streams, per the WHATWG Streams standard), so byte flow + backpressure ride
// the platform pipe and only lifecycle calls cross as RPC.

import { dial, openStream } from "@kpstreams/webrtc-client";
import type { Connection, Stream } from "@kpstreams/webrtc-client";
import type { KpsReason } from "../spec-types.js";
import type { PortRpc, RpcResult } from "../protocol.js";

export function registerKpsBridge(rpc: PortRpc): () => void {
  const conns = new Map<number, Connection>();
  const streams = new Map<number, Stream>();
  let nextId = 1;

  const addStream = (s: Stream): RpcResult => {
    const streamId = nextId++;
    streams.set(streamId, s);
    // Close info is PUSHED to the worker (rather than pulled via an RPC): the
    // settlement is also the registry-prune point, so retired streams — half-
    // closed, reset by the peer, or closed explicitly — never pin map entries.
    void s.closed.then((info) => {
      streams.delete(streamId);
      rpc.emit("stream.closed", { streamId, info });
    });
    // Transfer the live readable/writable to the worker. Host keeps the Stream
    // for lifecycle calls (those act on the data channel, not these objects).
    return {
      value: { streamId, readable: s.readable, writable: s.writable },
      transfer: [s.readable as unknown as Transferable, s.writable as unknown as Transferable],
    };
  };

  const conn = (id: number): Connection => {
    const c = conns.get(id);
    if (!c) throw new Error(`unknown connId ${id}`);
    return c;
  };
  const stream = (id: number): Stream => {
    const s = streams.get(id);
    if (!s) throw new Error(`unknown streamId ${id}`);
    return s;
  };

  rpc.on("kps.dial", async ({ addr }, { signal }) => {
    const c = await dial(addr, { signal });
    const connId = nextId++;
    conns.set(connId, c);
    void c.closed.then((info) => {
      conns.delete(connId);
      rpc.emit("conn.closed", { connId, info });
    });
    // remoteAddress crosses once, at establishment — a compliant snapshot
    // (§10.1: it reflects the endpoint observed at establishment; on the dial
    // side, the dialed endpoint).
    return { value: { connId, remoteAddress: c.remoteAddress } };
  });

  rpc.on("kps.openStream", async ({ addr }, { signal }) => {
    const s = await openStream(addr, { signal });
    return addStream(s);
  });

  rpc.on("conn.openStream", async ({ connId }, { signal }) => {
    return addStream(await conn(connId).openStream({ signal }));
  });

  rpc.on("conn.acceptStream", async ({ connId }, { signal }) => {
    return addStream(await conn(connId).acceptStream({ signal }));
  });

  rpc.on("conn.close", async ({ connId, reason }: { connId: number; reason?: KpsReason }) => {
    await conn(connId).close(reason);
    conns.delete(connId); // the closed handler above also deletes; both are safe
    return { value: undefined };
  });

  rpc.on("conn.sendDatagram", async ({ connId, data }, { signal }) => {
    await conn(connId).sendDatagram(data, { signal });
    return { value: undefined };
  });

  rpc.on("conn.receiveDatagram", async ({ connId }, { signal }) => {
    return { value: await conn(connId).receiveDatagram({ signal }) };
  });

  rpc.on("stream.closeWrite", async ({ streamId }) => {
    await stream(streamId).closeWrite();
    return { value: undefined };
  });
  rpc.on("stream.cancelRead", async ({ streamId, reason }: { streamId: number; reason?: KpsReason }) => {
    await stream(streamId).cancelRead(reason);
    return { value: undefined };
  });
  rpc.on("stream.resetWrite", async ({ streamId, reason }: { streamId: number; reason?: KpsReason }) => {
    await stream(streamId).resetWrite(reason);
    return { value: undefined };
  });
  rpc.on("stream.close", async ({ streamId, reason }: { streamId: number; reason?: KpsReason }) => {
    await stream(streamId).close(reason);
    streams.delete(streamId); // the closed handler above also deletes; both are safe
    return { value: undefined };
  });

  return () => {
    // Streams first: a stream from kps.openStream owns a hidden dedicated
    // connection that is only torn down when the stream itself closes — the
    // conns map never saw it.
    for (const s of streams.values()) void s.close({ code: "closed" }).catch(() => {});
    for (const c of conns.values()) void c.close({ code: "closed" });
    streams.clear();
    conns.clear();
  };
}
