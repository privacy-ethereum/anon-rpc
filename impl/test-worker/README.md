# anon-rpc test worker

The worker the repo's e2e drives. It exercises the full capability surface
(§7–§13): plain `fetch` passthrough, `kps+echo://<addr>` routing over a real
KPS stream, and a call counter persisted via §11 storage (returned as an
`x-anon-rpc-call-count` header, surviving worker restarts and page reloads).

**This is not the template.** To start your own anon-client, copy
[../passthrough-worker](../passthrough-worker) — the minimal conforming worker.

```sh
npm run build       # esbuild → dist/test-worker.js (hashed by the e2e)
npm run typecheck
```
