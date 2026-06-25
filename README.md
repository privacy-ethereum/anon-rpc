# anon-rpc prototype

A working prototype of the [anon-rpc](./SPEC.md) harness and a conforming worker.
It runs untrusted, hash-pinned worker code inside a Web Worker in a null-origin
sandboxed iframe (§6), and exposes the `AnonRpcWorkerApi` capability surface
(§7–§13) across the `postMessage` boundary — including a **real KPS transport**
([voltrevo/kps](https://github.com/voltrevo/kps)) bridged from the host to the
worker.

## Architecture

```
 host page ─────────────────────────────┐
  AnonRpcWorker (§5)                      │  null-origin iframe (sandbox=allow-scripts)
   • reads specifier, verifies keccak     │   iframe-boot: blob-spawns the Worker,
     hash of bundle bytes (§4)            │   relays the entangled port
   • runs real @kps/client (WebRTC)       │        │
   • bridges kps / storage / log / calls  │        ▼
   • exposes worker.fetch                 │   Web Worker
                                          │    worker-runtime (harness): builds
        MessageChannel port ──────────────┼──▶  anonRpcWorker, importScripts the
        (relayed once through the iframe,  │     verified bundle
         then host↔worker direct)         │    demo-worker (untrusted, hash-pinned):
                                          │     acceptCall loop, fetch passthrough,
                                          │     kps+echo:// routing
```

The capability port carries a small request/response + event RPC
([src/protocol.ts](src/protocol.ts)). KPS stream byte flow rides **transferred**
WHATWG `ReadableStream`/`WritableStream` objects (Chromium transfers them over a
`MessagePort`), so backpressure is handled by the platform pipe and only
lifecycle calls (`closeWrite`, `cancelRead`, …) round-trip as RPC. This is why
the worker never needs WebRTC itself — the harness owns the transport.

### Source map

| File | Role |
| --- | --- |
| [src/spec-types.ts](src/spec-types.ts) | Spec type surface (§5, §7–§13) |
| [src/protocol.ts](src/protocol.ts) | `PortRpc`: request/response + events + transfer + cross-boundary abort |
| [src/host/AnonRpcWorker.ts](src/host/AnonRpcWorker.ts) | Host class (§5): boot, iframe, fetch/acceptCall queue, storage, log |
| [src/host/specifier.ts](src/host/specifier.ts) | §4: specifier read (eth_call + ABI decode) + keccak verify |
| [src/host/kps-bridge-host.ts](src/host/kps-bridge-host.ts) | Host side of KPS, using real `@kps/client` |
| [src/iframe/iframe-boot.ts](src/iframe/iframe-boot.ts) | Null-origin iframe: spawns worker, relays port |
| [src/worker/worker-runtime.ts](src/worker/worker-runtime.ts) | Harness code in the Worker: builds `anonRpcWorker`, loads bundle |
| [src/worker/anon-rpc-worker-api.ts](src/worker/anon-rpc-worker-api.ts) | Worker-side capability proxies |
| [src/demo-worker/demo-worker.ts](src/demo-worker/demo-worker.ts) | The §3.2 conforming worker bundle |

## Prerequisites

- Node 18+, Go 1.21+ (for the KPS echo peer), and a checkout of
  [voltrevo/kps](https://github.com/voltrevo/kps) at `../kps` (the `@kps/client`
  `file:` dependency). Build it once: `cd ../kps/libs/js && npm install && npm run build`.

## Build & test

```sh
npm install
npm run build          # esbuild → dist/{host,worker-runtime,iframe-boot,demo-worker}.js
npm run typecheck      # tsc --noEmit
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
