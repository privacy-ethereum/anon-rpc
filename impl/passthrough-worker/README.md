# anon-rpc passthrough worker

The **minimal** [anon-rpc](../../SPEC.md) worker — the §3.2 conformance target,
reduced to its essence: an `acceptCall` loop that fulfils every fetch call with
a plain `fetch` passthrough. That plain `fetch` is the single seam a production
anon-client replaces with anonymized routing (e.g. over `anonRpcWorker.kps`).

**To write your own anon-client, copy this directory.** It is self-contained on
purpose:

- [src/spec-types.ts](src/spec-types.ts) is a *copy* of the worker-facing spec
  types (§7–§13), not an import from the harness — a worker is a standalone
  artifact identified by the hash of its bytes (§4), with no build-time
  dependency on any harness.
- The only platform a worker may rely on is the global `anonRpcWorker`
  capability object (§7). This template also uses ambient `fetch`, which is
  the part you replace.

For a worker that exercises the wider capability surface (KPS streams,
persistent storage), see [../test-worker](../test-worker), which the repo's
e2e drives.

```sh
npm run build       # esbuild → dist/passthrough-worker.js (the hashable §4 artifact)
npm run typecheck
```

The bundle is a single IIFE file; `keccak256` of its bytes is what a specifier
contract's `workerHash()` pins.
