// Trusted harness code that runs as the Web Worker's top-level script. It wires
// up `anonRpcWorker` from the capability port, exposes it as a global, then
// loads the hash-verified (untrusted) worker bundle, which uses that global as
// its entire platform. The worker bundle is the §4 conformance artifact; this
// runtime is part of the harness.
//
// Bundled to a classic-worker IIFE so `importScripts` is available.

import { PortRpc } from "../protocol.js";
import { makeWorkerApi } from "./anon-rpc-worker-api.js";

addEventListener("message", function onInit(ev: MessageEvent) {
  if (ev.data?.kind !== "init") return;
  removeEventListener("message", onInit as EventListener);

  const port: MessagePort = ev.data.port;
  const bundleBytes: Uint8Array = ev.data.bundleBytes;

  const rpc = new PortRpc(port);
  const api = makeWorkerApi(rpc);
  (globalThis as unknown as { anonRpcWorker: unknown }).anonRpcWorker = api;

  try {
    const blob = new Blob([bundleBytes as unknown as BlobPart], { type: "text/javascript" });
    // eslint-disable-next-line no-restricted-globals
    (self as unknown as { importScripts: (u: string) => void }).importScripts(
      URL.createObjectURL(blob),
    );
  } catch (err) {
    api.log.error("worker bundle failed to load:", (err as Error)?.message ?? String(err));
  }
});
