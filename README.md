# anon-rpc

A standard that lets a wallet or application make anonymized RPC requests by
running untrusted, hash-pinned client code inside a sandboxed worker and
granting it a small, explicit, transport-neutral capability API.

- [SPEC.md](SPEC.md) — the normative specification.
- [draft-worker-api.md](draft-worker-api.md) — non-normative API design and rationale.
- [impl/](impl/) — a working reference prototype (browser harness + conforming
  worker, with a real KPS transport bridged across the sandbox boundary).
