// Vite build for the GitHub Pages site (landing + demo, multi-page).
//
// Note: unlike raw esbuild, Vite does NOT read tsconfig `paths`, so the
// typecheck-only mapping of @anon-rpc/browser-harness to the harness SOURCE
// (tsconfig.json) cannot leak into the bundle — the bundler resolves the real
// package exports: the BUILT dist/host.js with its define-injected iframe/
// worker-runtime sources. The site smoke test still verifies the built bundle
// contains no unresolved defines, whatever the bundler.

import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "src",
  base: "./", // relative URLs: works at any Pages mount path
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "src/index.html"),
        demo: resolve(import.meta.dirname, "src/demo/index.html"),
      },
    },
  },
});
