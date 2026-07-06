// Host side of the KPS bridge.
//
// The harness runs the REAL kps client (WebRTC) on the host, and exposes it to
// the worker over the capability port. This is the whole point of the `kps`
// capability (§10, draft rationale): worker code never touches WebRTC, so it is
// not locked to the web. Connections and streams are referenced by opaque ids;
// stream readable/writable are transferred to the worker (Chromium transfers
// WHATWG streams), so byte flow + backpressure ride the platform pipe and only
// lifecycle calls cross as RPC.

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
    return { value: { connId } };
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
    conns.delete(connId);
    return { value: undefined };
  });

  rpc.on("conn.awaitClosed", async ({ connId }) => {
    return { value: await conn(connId).closed };
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
    streams.delete(streamId);
    return { value: undefined };
  });
  rpc.on("stream.awaitClosed", async ({ streamId }) => {
    return { value: await stream(streamId).closed };
  });

  return () => {
    for (const c of conns.values()) void c.close({ code: "closed" });
    conns.clear();
    streams.clear();
  };
}
