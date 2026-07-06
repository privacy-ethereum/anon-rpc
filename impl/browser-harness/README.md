# @anon-rpc/browser-harness

A browser harness for [anon-rpc](https://github.com/privacy-ethereum/anon-rpc)
— a standard that lets a wallet or application make **anonymized RPC requests**
by running untrusted, hash-pinned anon-client code inside a sandboxed worker.

The harness:

- resolves the anon-client bundle from an on-chain specifier contract and
  verifies `keccak256(bytes) == workerHash()` before executing a single byte
  (trust the hash, not the URL);
- runs it in a **Web Worker inside a null-origin sandboxed iframe**, with no
  ambient access to your DOM, storage, cookies, or keys;
- grants it a small, explicit capability API — inbound fetch calls, a
  [KPS](https://github.com/privacy-ethereum/kps) key-pinned transport
  (bridged so the worker never touches WebRTC), scoped storage, and logging;
- hands you back one thing: an anonymized `fetch`.

## Install

```sh
npm install @anon-rpc/browser-harness
```

## Use

```ts
import { AnonRpcWorker } from "@anon-rpc/browser-harness";

const worker = new AnonRpcWorker({
  // The IWorkerSpecifier contract identifying the anon-client by hash.
  address: "0x…",
  // Bootstrap provider used only to read the specifier (breaks the circular
  // "need the chain to reach the chain" dependency).
  preExisting: { rpcProvider },
});

await worker.ready;

// A standard fetch, routed through the sandboxed anon-client.
// It is this-bound, so passing it around as a free function is fine.
const res = await worker.fetch("https://rpc.example/", {
  method: "POST",
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }),
});

worker.close(); // tears down the iframe and worker
```

## Notes

- Browser-only: the isolation model is a null-origin iframe and the KPS
  transport runs over WebRTC. A native/Node harness would be a separate
  package.
- The worker-facing capability API (`anonRpcWorker`) and all conformance
  requirements are defined in the
  [specification](https://github.com/privacy-ethereum/anon-rpc/blob/main/SPEC.md).
  A template anon-client to copy lives in
  [`impl/passthrough-worker`](https://github.com/privacy-ethereum/anon-rpc/tree/main/impl/passthrough-worker).
- Status: prototype-grade reference implementation of a draft spec; interfaces
  track the spec and may change.

## License

MIT © Ethereum Foundation
