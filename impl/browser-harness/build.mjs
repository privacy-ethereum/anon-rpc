// Builds the harness's execution contexts:
//   - worker-runtime.js IIFE : harness code that runs as the Web Worker script
//   - iframe-boot.js   IIFE  : harness code that runs in the null-origin iframe
//   - host.js          ESM   : the published library entry — npm dependencies
//                              stay external so consumers dedupe/update them
//
// worker-runtime and iframe-boot sources are inlined into host.js (via
// define), because the null-origin iframe cannot load host-origin scripts and
// must be handed their source text at runtime. They MUST stay fully bundled:
// they are blob-spawned where imports cannot resolve.

import { build } from "esbuild";
import { readFile, mkdir, rm } from "node:fs/promises";

// Fresh dist every build: without this, renamed/deleted sources leave stale
// bundles and .d.ts files behind — and dist/types ships wholesale in the
// tarball. (tsc emits dist/types AFTER this script, in the same build script.)
const outdir = "dist";
await rm(outdir, { recursive: true, force: true });
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
const runtimeSrc = await buildOne("src/worker/worker-runtime.ts", `${outdir}/worker-runtime.js`, "iife");
const iframeSrc = await buildOne("src/iframe/iframe-boot.ts", `${outdir}/iframe-boot.js`, "iife");

// Host builds, with the runtime + iframe sources inlined.
await build({
  ...common,
  entryPoints: ["src/host/index.ts"],
  outfile: `${outdir}/host.js`,
  format: "esm",
  packages: "external",
  // Maps embed sourcesContent, and src/ ships in the tarball, so consumers
  // debug against the real TS. The IIFE intermediates above deliberately have
  // no maps: their text is blob-spawned, where a sourceMappingURL cannot
  // resolve.
  sourcemap: true,
  define: {
    __WORKER_RUNTIME_SRC__: JSON.stringify(runtimeSrc),
    __IFRAME_BOOT_SRC__: JSON.stringify(iframeSrc),
  },
});

console.log("build complete");
