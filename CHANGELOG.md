# Specification changelog

Changes to [SPEC.md](SPEC.md) by specification version.

## 0.2.1 — 2026-07-27

- §4.2: content codings over kps resolvers — the request advertises what the harness's environment can decode (`Accept-Encoding`), a response may use exactly one advertised coding (`Content-Encoding`), and the body-size cap applies to the decoded bytes. The hash check always runs over the decoded bytes.

## 0.2.0 — 2026-07-24

- §4.1–4.2: `workerResolvers()` entries specified — `https:` URLs and kps resolver strings, with a self-contained GET-over-KPS exchange for the latter; unrecognized entries are ignored.
- §5, §7.1: hosts can pass `WorkerInit.config`, delivered to the worker as `anonRpcWorker.config` — structured-cloneable, opaque to the harness, fixed for the worker's lifetime.
- §10: tracks the KPS specification at version `^0.2.1`, which adds flow control to the WebRTC framing via a breaking wire change (0.1.x and 0.2.x peers do not interoperate). API surface: `KpsConn.remoteAddress` added; bracketed IPv6 address form documented.
- Non-normative design rationale moved from `draft-worker-api.md` (now removed) into Appendix A.

## 0.1.0 — 2026-06-24

- Initial draft.
