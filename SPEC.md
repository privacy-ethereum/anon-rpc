# anon-rpc Specification

- **Status:** Draft
- **Version:** 0.1.0
- **Date:** 2026-06-24

This document is the normative specification for **anon-rpc**, a standard that lets a wallet or application make anonymized RPC requests by running untrusted, hash-pinned client code inside a sandboxed worker, and granting that code a small, explicit, transport-neutral capability API.

`draft-worker-api.md` accompanies this document as non-normative API design and examples. Where the two disagree, **this document is authoritative**.

## 1. Introduction and scope

A wallet that wants to read from or write to a chain must reach an RPC endpoint. Doing so through a fixed gateway concentrates observation: the gateway learns who asks for what. anon-rpc lets the wallet instead run a pluggable **anon-client** that routes requests through an anonymity network, while keeping that client code from touching wallet secrets, cookies, or the DOM.

This specification covers the full system:

- how anon-client worker code is identified, located, and integrity-checked (§5);
- how a host bootstraps and integrates an anon-client (§6);
- the isolation properties a worker runs under (§7);
- the **worker capability API** the worker is granted: inbound calls, KPS transport, storage, and logging (§8–§14);
- the error model (§13) and security considerations (§15).

The KPS wire protocol itself is **out of scope** and is defined by the KPS project (see §16). This document specifies only the worker-facing KPS API and the harness obligations behind it.

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119 and RFC 8174 when, and only when, they appear in all capitals.

- **Worker** — the anon-client program, distributed as a bundle of bytes, that performs anonymized requests. It is the conformance target of §3.2.
- **Harness** — the runtime that loads a worker, enforces its isolation, and implements the capability API the worker is granted. It is the conformance target of §3.1. A *browser harness* runs the worker in a Web Worker inside a null-origin iframe.
- **Host** — the wallet or application that integrates a harness and consumes the anonymized `fetch` it produces.
- **Specifier Contract** — an on-chain definition (an `IWorkerSpecifier`, §5) that specifies a worker bundle by hash and where to obtain it.
- **Capability API** — the object exposed to worker code as its entire platform interface (`AnonRpcWorkerApi`, §8).
- **KPS** — Key Pinned Streams: secure multiplexed byte streams to a peer identified by a certificate hash rather than a CA-signed domain (§11).
- **Call** — a request made by the host *into* the worker (e.g. a `fetch` call), as opposed to a capability the worker invokes.

## 3. Conformance classes

### 3.1 Conforming harness

A conforming harness MUST:

- verify worker-bundle integrity before execution as specified in §5;
- implement `AnonRpcWorker` for the host (using the same name) (§6);
- enforce the worker isolation properties of §7;
- implement `AnonRpcWorkerApi` for the worker under the name `anonRpcWorker` (§8);
- implement the semantics of every capability it exposes as specified in §8–§12.

### 3.2 Conforming worker

A conforming worker MUST:

- use `anonRpcWorker.acceptCall` to respond to calls of type `fetch`;
- enable ethereum RPC in at least one of the following ways:
  - providing general web request access OR
  - serve ethereum RPC at a nominated special url such as `/ethereum-rpc`.

The worker SHOULD minimize its usage of ambient APIs other than the capability API (§8). Usage of other APIs will prevent the worker from functioning on platforms which do not provide them.

A conforming worker MUST NOT depend on the messaging protocol used to implement the capability API.

### 3.3 Secondary roles

A **Specifier Contract** MUST conform to §5.

## 4. Admitted web-platform types

To keep workers idiomatic without coupling them to a browser, this specification admits exactly three web-platform types into the capability API: `ReadableStream<Uint8Array>`, `WritableStream<Uint8Array>`, and `AbortSignal`. A conforming worker MUST NOT assume any other web-platform global. A native harness MUST provide conforming implementations of these three types to the worker.

All bytes crossing the capability API are `Uint8Array`. The API is binary-first; the worker is responsible for its own text encoding, framing, and serialization.

## 5. Worker identity and integrity

> The contents of §5–§6 are derived from the anon-rpc proposal article (§16).

A worker bundle MUST be identified by content hash, not by location. A specifier contract is an on-chain object exposing at least:

```solidity
interface IWorkerSpecifier {
  // keccak256 hash of the canonical worker bundle bytes.
  function workerHash() external view returns (bytes32);
  // Suggested locations from which the bundle MAY be retrieved.
  function workerResolvers() external view returns (string[] memory);
}
```

A harness MAY obtain the bundle bytes by any means. Any bytes matching the hash are equally acceptable regardless of source; `workerResolvers()` is advisory only.

If the bundle hash does not equal `workerHash()`, the harness MUST reject it.

## 6. Host-side harness API

The harness code MUST implement `AnonRpcWorker` for the host:

```ts
export class AnonRpcWorker {
  constructor(init: WorkerInit);

  // Resolves when the worker is loaded and has called its signalReady() method.
  ready: Promise<void>;

  // Implements the web's fetch API. This field MUST be this-bound; it MUST work
  // normally when used as a free function. This means a function accepting
  // fetch as a parameter can accept it as `useFetch(worker.fetch)` and not
  // require `useFetch(worker.fetch.bind(worker))`.
  fetch: typeof fetch;

  // Clean up resources. For a web harness this means the iframe and its web worker
  // are removed.
  close(): void;
}

export type WorkerInit = {
  // The contract specifier address
  address: string;

  preExisting?: {
    // An ethereum rpc provider used to break the circular dependency: we need
    // to read the chain in order to instantiate our anonymous system for reading
    // the chain.
    rpcProvider?: RpcProvider;
  };
};
```

## 7. Worker isolation

A conforming harness MUST run the worker such that it has no ambient access to:

- the host's DOM, storage, or cookies;
- wallet private keys or signing capability;
- the origin or identity of the host beyond what the host passes in calls.

A browser harness MUST run the worker in a Web Worker whose owning context is a null-origin (sandboxed, `allow-scripts` only) iframe, and MUST mediate all capability traffic across the `postMessage` boundary.

## 8. The capability API

The harness MUST implement `AnonRpcWorkerApi` for the worker:

```ts
export type AnonRpcWorkerApi = {
  signalReady(): void;
  acceptCall(opts?: { signal?: AbortSignal }): Promise<IncomingCall>;
  kps: KpsApi;
  storage: StorageApi;
  log: LogApi;
};

export const anonRpcWorker: AnonRpcWorkerApi;
```

The worker MUST call `signalReady()` when it is ready to fulfil fetch calls.

The worker MAY accept calls to fetch before it calls `signalReady()`. The harness MUST buffer incoming calls so that this is not necessary.

## 9. Inbound calls

```ts
export type IncomingCall =
  | FetchCall;
// future call kinds are added here, discriminated by `kind`

export type FetchCall = {
  kind: "fetch";
  url: string;
  requestInit?: AnonRequestInit;
  respond(response: AnonFetchResponse | Promise<AnonFetchResponse>): void;
};
```

- `acceptCall()` MUST resolve with the next inbound call and MUST NOT deliver a subsequent call until it is invoked again. Backpressure is therefore implicit: the harness MUST NOT drop or reorder calls while the worker has not asked for the next one; it MUST queue them in arrival order. (This mirrors `KpsConn.acceptStream`, §11.)
- Calls MUST be delivered in the order the host issued them.
- If the `opts.signal` passed to `acceptCall()` aborts, the pending `acceptCall()` MUST reject with an abort error and MUST NOT consume a call.
- `respond()` MUST be called at most once per call. A second invocation MUST throw. Passing a rejected promise (or a promise that rejects) MUST fail the call and propagate failure to the host.
- New call kinds MUST be added as new members of the `IncomingCall` union with a distinct `kind`; a worker MUST ignore (and MUST NOT crash on) a `kind` it does not recognize, leaving such a call unanswered or explicitly failed.

## 10. Fetch call payloads

### 10.1 Requests

```ts
export type HeaderList = [name: string, value: string][];

export type ByteBody = Uint8Array | ReadableStream<Uint8Array>;

export type AnonRequestInit = {
  method?: string;                      // defaults to "GET"
  headers?: HeaderList;
  body?: ByteBody;
  redirect?: "follow" | "manual" | "error";  // defaults to "follow"
  signal?: AbortSignal;
};
```

- `HeaderList` preserves header order and duplicates.
- A `ByteBody` that is a `ReadableStream<Uint8Array>` is single-consumption, applies normal stream backpressure, and MUST error if the underlying transfer fails or `signal` aborts.
- `signal`, when supplied, aborts the in-flight call (as in `fetch(url, { signal })`).

### 10.2 Responses

```ts
export type AnonFetchResponse = {
  status: number;
  headers: HeaderList;
  body: ByteBody;
  url?: string;         // final URL after followed redirects
};
```

- When `body` is a streaming `ByteBody`, the call is **not complete** until the body stream closes or errors; `respond()` returning does not mark completion. A harness MUST keep the transfer alive until the body is fully drained or aborted.

## 11. KPS transport

KPS provides secure, multiplexed byte streams to a peer identified by a certificate hash. The worker-facing API is connection-first.

```ts
export type KpsAddr = string;  // "<ip>:<port>:<certhash>", e.g. "192.0.2.1:4242:uEi..."

export type KpsApi = {
  dial(addr: KpsAddr, opts?: KpsDialOptions): Promise<KpsConn>;
  openStream(addr: KpsAddr, opts?: KpsDialOptions): Promise<KpsStream>;
};
```

- A `KpsAddr` pins the peer's self-signed certificate by hash; no certificate authority or domain name is involved. A harness MUST authenticate the peer against the pinned hash and MUST fail the dial if it does not match.
- `dial()` MUST establish a secure multiplexed connection. `openStream(addr)` is convenience sugar similar to `dial(addr).then(c => c.openStream())`, but also closes the underlying connection when the stream is closed.
- A harness MAY implement KPS over WebRTC (browser) or QUIC (native). The worker SHOULD NOT be affected by the underlying transport.

### 11.1 Connections

```ts
export type KpsConn = {
  openStream(opts?: KpsOpenStreamOptions): Promise<KpsStream>;
  acceptStream(opts?: { signal?: AbortSignal }): Promise<KpsStream>;
  datagrams: KpsDatagrams;
  close(reason?: KpsReason): Promise<void>;
  closed: Promise<KpsConnCloseInfo>;
};
```

- `acceptStream()` accepts a stream opened by the peer, following the same one-at-a-time, ordered, no-drop discipline as `acceptCall` (§9).
- `datagrams` MUST always be present: every connection supports datagrams, so a worker need not feature-detect.
- `close()` MUST invalidate all streams and datagram operations on the connection. `closed` MUST resolve (not reject) on orderly or failed shutdown, carrying `KpsConnCloseInfo`.

### 11.2 Streams

A KPS stream is an unnamed, reliable, ordered, bidirectional byte stream. Write boundaries are **not** preserved: if one side writes `hello` then `world`, the peer observes the bytes `helloworld` in arbitrary chunking. Application protocols, routing, framing, and request/response semantics are the worker's responsibility, layered on top of the stream bytes.

```ts
export type KpsStream = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  closeWrite(): Promise<void>;
  cancelRead(reason?: KpsReason): Promise<void>;
  resetWrite(reason?: KpsReason): Promise<void>;
  close(reason?: KpsReason): Promise<void>;
  closed: Promise<KpsStreamCloseInfo>;
};
```

The lifecycle is QUIC-inspired but is not a QUIC API mapping:

- `closeWrite()` — gracefully finish the local write half; the peer MUST eventually observe EOF after all previously written bytes. It is equivalent to closing `writable`.
- `cancelRead(reason?)` — stop wanting inbound bytes; not graceful EOF. Where the transport supports it, the peer SHOULD be told to stop sending.
- `resetWrite(reason?)` — abort the local write half; the peer observes a stream error rather than EOF, and previously buffered bytes MAY be lost.
- `close(reason?)` — clean up both halves using the best available transport semantics.

A harness MUST NOT expose stream IDs, connection IDs, QUIC transport parameters, 0-RTT, connection migration, version negotiation, or detailed flow-control knobs.

### 11.3 Datagrams

```ts
export type KpsDatagrams = {
  send(data: Uint8Array, opts?: { signal?: AbortSignal }): Promise<void>;
  incoming: ReadableStream<Uint8Array>;
};
```

Datagrams are connection-level, unreliable, unordered, message-oriented, and size-limited, and are kept entirely separate from streams. There is no notion of an "unreliable stream".

- `send()` resolving means the harness accepted the datagram for best-effort sending, not that the peer received it.
- `incoming` MUST be delivered against a bounded buffer with a defined overflow policy (for example, drop-oldest); a harness MUST NOT rely on a single racing receive call.

## 12. Storage

```ts
export type StorageKey = string;

export type StorageApi = {
  get(key: StorageKey, opts?: StorageReadOptions): Promise<Uint8Array | undefined>;
  set(key: StorageKey, value: Uint8Array, opts?: StorageWriteOptions): Promise<void>;
  delete(key: StorageKey, opts?: StorageWriteOptions): Promise<void>;
  has(key: StorageKey, opts?: StorageReadOptions): Promise<boolean>;
  list(opts?: StorageListOptions): AsyncIterable<StorageKey>;
  clear(opts?: StorageClearOptions): Promise<void>;
};
```

Storage is asynchronous and binary-first.

- A harness MUST scope storage to the address of the worker's specifier contract. A worker MUST NOT be able to read or write other storage.
- `get()` MUST resolve to `undefined` for an absent key.
- Keys are plain strings with no harness-imposed structure. A worker MAY adopt a delimiter convention (e.g. `"/"`) and use it with the `prefix` option of `list()` and `clear()`.
- `list()` is async-iterable so a harness MAY page internally. `clear({ prefix })` MUST remove only matching keys; `clear()` with no prefix MUST clear the worker's entire namespace and nothing outside it.

## 13. Error model

- Operation failures surface as rejected promises, and as errors on the relevant `readable`/`writable` streams.
- Where a structured reason is available it MUST carry a `KpsErrorCode` and MAY carry a human-readable `message`. `message` is diagnostic and MUST NOT be parsed for control flow.

```ts
export type KpsErrorCode =
  | "cancelled" | "closed" | "reset" | "timeout" | "network-error"
  | "protocol-error" | "unsupported" | "too-large" | "queue-full"
  | "permission-denied" | "internal-error";

export type KpsReason = { code?: KpsErrorCode; message?: string };
export type KpsConnCloseInfo = { ok: boolean; reason?: KpsReason };
export type KpsStreamCloseInfo = { ok: boolean; reason?: KpsReason };
```

- The `closed` promises on connections and streams MUST resolve (not reject) so that orderly shutdown is observable distinctly from operation failure; `ok` indicates whether shutdown was clean.

## 14. Logging

```ts
export type LogApi = {
  debug(...args: LogArg[]): void;
  info(...args: LogArg[]): void;
  warn(...args: LogArg[]): void;
  error(...args: LogArg[]): void;
};

export type LogArg =
  | string | number | boolean | null | undefined
  | Uint8Array
  | LogArg[]
  | { [key: string]: LogArg };
```

The log API is console-like but does not promise browser `console` semantics.

- Log calls are best-effort diagnostics. A worker's correctness MUST NOT depend on log delivery, ordering, formatting, or side effects.
- Arguments MUST be treated as serialized or snapshotted at call time. A worker MUST NOT assume object identity, prototypes, getters, stack capture, or live inspection.

## 15. Security considerations

- The isolation in §7 is load-bearing: a compromised worker bundle must not be able to exfiltrate wallet secrets or browser state. Harness authors MUST treat worker code as untrusted.
- Hash pinning (§5) is the supply-chain control. A host that executes bytes without verifying `workerHash()` voids the security model.
- Because KPS pins peers by certificate hash (§11), trust derives from the pinned hash, not from CA/DNS; the source distributing an address is untrusted.
- Log arguments may carry sensitive bytes; §14 permits redaction precisely so harnesses can avoid leaking secrets into host logs.

## 16. References

- anon-rpc proposal article: https://privreads.ethereum.foundation/feed/anon-rpc/
- KPS (Key Pinned Streams): https://github.com/voltrevo/kps — see its `SPEC.md` for the wire protocol.
- `draft-worker-api.md` (this repository) — non-normative design rationale and examples.
- RFC 2119, RFC 8174 — requirement-level keywords.
