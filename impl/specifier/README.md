# anon-rpc specifier

The on-chain half of [SPEC.md §4](../../SPEC.md): `WorkerSpecifier`, a
reference `IWorkerSpecifier` contract that pins a worker bundle by
`keccak256` hash and suggests resolver URLs, plus the script that publishes a
worker with it.

## Trust model

The contract is **fully owner-updatable** so one stable address can track
worker versions — which makes the owner key the supply chain for every host
pinned to that address: whoever holds it can point them at new code. Guard it
accordingly (hardware wallet / multisig for anything real), and call
`renounceOwnership()` to freeze the current worker forever if you want
effective immutability.

## Publishing a worker

Requires [Foundry](https://getfoundry.sh) (`forge` + `cast`) and Node 20+.

1. Host the bundle somewhere public (any URL is fine — harnesses verify the
   hash, not the source). The easy built-in option is **GitHub itself**: with
   `--github`, the script commits the bundle to this repo's orphan `keccak`
   branch at its content address (`<hash[0:2]>/<hash[2:]>`, keccak256 hex),
   pushes, and uses the `raw.githubusercontent.com` URL as a resolver. Because
   paths are content-addressed, those URLs are immutable by construction, and
   the branch's history stays fully independent of the code history. Requires
   push access to `origin` (override with `RESOLVER_REMOTE`/`RESOLVER_BRANCH`).
2. Configure a `.env` in this directory (gitignored), or export the same
   variables:

   ```sh
   RPC_URL=https://…                 # chain RPC endpoint
   PRIVATE_KEY=0x…                   # deployer key with funds for gas
   RESOLVER_URLS=https://…           # comma-separated; optional with --github
   # GITHUB_RESOLVER=1               # same as passing --github
   # WORKER_BUNDLE=path/to/bundle.js # default: ../passthrough-worker (rebuilt)
   ```

3. Publish:

   ```sh
   npm run publish-worker -- --github   # add --yes to skip the confirmation
   ```

The script rebuilds the default bundle so the pinned hash matches current
source, **verifies every resolver URL actually serves the pinned bytes before
spending gas**, deploys, reads `workerHash()`/`workerResolvers()` back through
the public interface, and prints the specifier address with a ready-to-paste
`AnonRpcWorker` snippet.

To ship a new worker version later: upload the new bundle to the resolvers,
then call `setWorker(newHash, newResolvers)` as the owner (e.g.
`cast send <specifier> "setWorker(bytes32,string[])" <hash> '["https://…"]' …`).

## Tests

```sh
npm test    # github-resolver tests (against a local bare remote), forge unit
            # tests, and an end-to-end publish against a local anvil chain
            # with a local HTTP resolver; contract/publish parts skip if
            # Foundry is absent
```
