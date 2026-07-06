# anon-rpc passthrough worker

A template [anon-rpc](../../SPEC.md) worker — the §3.2 conformance target. It
answers `fetch` calls with a plain `fetch` passthrough (the single seam a real
anon-client replaces with anonymized routing), and routes `kps+echo://<addr>`
URLs over a real KPS stream to demonstrate the transport.

**To write your own anon-client, copy this directory.** It is self-contained on
purpose:

- [src/spec-types.ts](src/spec-types.ts) is a *copy* of the worker-facing spec
  types (§7–§13), not an import from the harness — a worker is a standalone
  artifact identified by the hash of its bytes (§4), with no build-time
  dependency on any harness.
- The only platform a worker may rely on is the global `anonRpcWorker`
  capability object (§7). This template also uses ambient `fetch`, which is the
  part you replace.

```sh
npm run build       # esbuild → dist/passthrough-worker.js (the hashable §4 artifact)
npm run typecheck
```

The bundle is a single IIFE file; `keccak256` of its bytes is what a specifier
contract's `workerHash()` pins.
