// Bundles the worker to a single standalone IIFE: dist/passthrough-worker.js.
// The bytes of that file are the §4 artifact — keccak256 of them is what a
// specifier contract's workerHash() pins.

import { build } from "esbuild";

await build({
  entryPoints: ["src/passthrough-worker.ts"],
  outfile: "dist/passthrough-worker.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  logLevel: "info",
});

console.log("build complete");
