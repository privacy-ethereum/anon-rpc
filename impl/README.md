# anon-rpc prototype

A working prototype of the [anon-rpc](../SPEC.md) harness and a conforming
worker, as two npm workspaces:

- [harness/](harness/) — the wallet-side runtime (the §3.1 conformance target).
- [passthrough-worker/](passthrough-worker/) — a template worker (the §3.2
  conformance target). **Copy that directory to write your own anon-client**;
  it deliberately copies the worker-facing spec types instead of importing
  them, so it stands alone.
It runs untrusted, hash-pinned worker code inside a Web Worker in a null-origin
sandboxed iframe (§6), and exposes the `AnonRpcWorkerApi` capability surface
(§7–§13) across the `postMessage` boundary — including a **real KPS transport**
([`@kpstreams/webrtc-client`](https://www.npmjs.com/package/@kpstreams/webrtc-client),
from [privacy-ethereum/kps](https://github.com/privacy-ethereum/kps)) bridged
from the host to the worker.

## Architecture

```
 host page ─────────────────────────────┐
  AnonRpcWorker (§5)                      │  null-origin iframe (sandbox=allow-scripts)
   • reads specifier, verifies keccak     │   iframe-boot: blob-spawns the Worker,
     hash of bundle bytes (§4)            │   relays the entangled port
   • runs real KPS client (WebRTC)        │        │
   • bridges kps / storage / log / calls  │        ▼
   • exposes worker.fetch                 │   Web Worker
                                          │    worker-runtime (harness): builds
        MessageChannel port ──────────────┼──▶  anonRpcWorker, importScripts the
        (relayed once through the iframe,  │     verified bundle
         then host↔worker direct)         │    passthrough-worker (untrusted,
                                          │     hash-pinned): acceptCall loop,
                                          │     fetch passthrough, kps+echo://
                                          │     routing
```

The capability port carries a small request/response + event RPC
([harness/src/protocol.ts](harness/src/protocol.ts)). KPS stream byte flow rides **transferred**
WHATWG `ReadableStream`/`WritableStream` objects (Chromium transfers them over a
`MessagePort`), so backpressure is handled by the platform pipe and only
lifecycle calls (`closeWrite`, `cancelRead`, …) round-trip as RPC. This is why
the worker never needs WebRTC itself — the harness owns the transport.

### Source map

| File | Role |
| --- | --- |
| [harness/src/spec-types.ts](harness/src/spec-types.ts) | Spec type surface (§5, §7–§13) |
| [harness/src/protocol.ts](harness/src/protocol.ts) | `PortRpc`: request/response + events + transfer + cross-boundary abort |
| [harness/src/host/AnonRpcWorker.ts](harness/src/host/AnonRpcWorker.ts) | Host class (§5): boot, iframe, fetch/acceptCall queue, storage, log |
| [harness/src/host/specifier.ts](harness/src/host/specifier.ts) | §4: specifier read (eth_call + ABI decode) + keccak verify |
| [harness/src/host/kps-bridge-host.ts](harness/src/host/kps-bridge-host.ts) | Host side of KPS, using real `@kpstreams/webrtc-client` |
| [harness/src/iframe/iframe-boot.ts](harness/src/iframe/iframe-boot.ts) | Null-origin iframe: spawns worker, relays port |
| [harness/src/worker/worker-runtime.ts](harness/src/worker/worker-runtime.ts) | Harness code in the Worker: builds `anonRpcWorker`, loads bundle |
| [harness/src/worker/anon-rpc-worker-api.ts](harness/src/worker/anon-rpc-worker-api.ts) | Worker-side capability proxies |
| [passthrough-worker/src/passthrough-worker.ts](passthrough-worker/src/passthrough-worker.ts) | The §3.2 conforming worker template (own copy of the worker-facing types) |

## Prerequisites

- Node 20+. Everything KPS comes from npm: the harness uses
  `@kpstreams/webrtc-client`, and the e2e runs its echo peer in-process via
  `@kpstreams/server` — no Go toolchain or
  [kps](https://github.com/privacy-ethereum/kps) checkout required.

All commands below are run from this `impl/` directory.

## Build & test

```sh
npm install            # installs both workspaces
npm run build          # harness/dist/{host,worker-runtime,iframe-boot}.js + passthrough-worker/dist/passthrough-worker.js
npm run typecheck      # tsc --noEmit in each workspace
npm run test:e2e       # builds, starts the Go kps echo server, drives headless Chromium
```

The e2e test ([test/run-e2e.mjs](test/run-e2e.mjs)) asserts, end to end:

1. the iframe is null-origin (`sandbox="allow-scripts"`) — §6;
2. a plain `worker.fetch()` passes through the boundary and returns the body;
3. a `kps+echo://<addr>` fetch is routed over a **real KPS stream** to the Go
   echo server and the bytes round-trip — proving the bridged transport.

The §4 integrity path is real: the mock specifier returns an ABI-encoded
`workerHash()`/`workerResolvers()`, the harness fetches the bundle and rejects
it unless `keccak256(bytes)` matches.
