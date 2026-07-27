// Bundles the worker to a single standalone IIFE: dist/passthrough-worker.js.
// The bytes of that file are the §4 artifact — keccak256 of them is what a
// specifier contract's workerHash() pins.

import { build } from "esbuild";
import { rm } from "node:fs/promises";

// Fresh dist every build: a renamed entry must not leave a stale bundle
// behind (these bytes are the hash-pinned §4 artifact — no ambiguity allowed).
await rm("dist", { recursive: true, force: true });

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
