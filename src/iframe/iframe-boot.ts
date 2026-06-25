// Runs inside the null-origin sandboxed iframe (§6). It is trusted harness code,
// but it has no ambient authority: it only spins up the Web Worker and relays
// the capability port through to it. Because the iframe's origin is opaque it
// cannot load host-origin scripts, so the worker runtime source and bundle
// bytes are passed in by the host and blob-spawned here.
//
// This file uses no imports; it is bundled to a self-contained IIFE and inlined
// into the iframe's srcdoc.

(() => {
  parent.postMessage({ kind: "iframe-ready" }, "*");

  addEventListener("message", (ev: MessageEvent) => {
    if (ev.data?.kind !== "init") return;
    const port = ev.ports[0];
    const runtimeSource: string = ev.data.runtimeSource;
    const bundleBytes: Uint8Array = ev.data.bundleBytes;

    const blob = new Blob([runtimeSource], { type: "text/javascript" });
    const worker = new Worker(URL.createObjectURL(blob));

    // Re-transfer the entangled port (still entangled with the host's port1)
    // and hand over the hash-verified bundle bytes for the runtime to load.
    worker.postMessage({ kind: "init", port, bundleBytes }, [port]);

    worker.addEventListener("error", (e) => {
      parent.postMessage({ kind: "worker-error", message: e.message }, "*");
    });
  });
})();
