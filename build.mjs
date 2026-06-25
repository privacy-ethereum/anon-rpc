// Builds the four execution contexts of the prototype:
//   - demo-worker.js   IIFE  : untrusted, hash-pinned worker bundle (§4 artifact)
//   - worker-runtime.js IIFE : harness code that runs as the Web Worker script
//   - iframe-boot.js   IIFE  : harness code that runs in the null-origin iframe
//   - host.js          ESM   : the AnonRpcWorker host API (imported by the page)
//
// worker-runtime and iframe-boot sources are inlined into host.js (via define),
// because the null-origin iframe cannot load host-origin scripts and must be
// handed their source text at runtime.

import { build } from "esbuild";
import { readFile, mkdir } from "node:fs/promises";

const outdir = "dist";
await mkdir(outdir, { recursive: true });

const common = {
  bundle: true,
  platform: "browser",
  target: "es2022",
  logLevel: "info",
};

async function buildOne(entry, outfile, format) {
  await build({ ...common, entryPoints: [entry], outfile, format });
  return readFile(outfile, "utf8");
}

// Standalone bundles.
await buildOne("src/demo-worker/demo-worker.ts", `${outdir}/demo-worker.js`, "iife");
const runtimeSrc = await buildOne("src/worker/worker-runtime.ts", `${outdir}/worker-runtime.js`, "iife");
const iframeSrc = await buildOne("src/iframe/iframe-boot.ts", `${outdir}/iframe-boot.js`, "iife");

// Host bundle, with the runtime + iframe sources inlined.
await build({
  ...common,
  entryPoints: ["src/host/index.ts"],
  outfile: `${outdir}/host.js`,
  format: "esm",
  define: {
    __WORKER_RUNTIME_SRC__: JSON.stringify(runtimeSrc),
    __IFRAME_BOOT_SRC__: JSON.stringify(iframeSrc),
  },
});

console.log("build complete");
