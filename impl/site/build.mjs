// Builds the GitHub Pages site into dist/: static pages copied, the demo app
// bundled (the local @anon-rpc/browser-harness workspace is linked, so the
// site always ships the repo's current harness — root `npm run build` builds
// the harness before the site by workspace order).

import { build } from "esbuild";
import { rm, mkdir, cp, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/demo", { recursive: true });

await cp("src/index.html", "dist/index.html");
await cp("src/site.css", "dist/site.css");
await cp("src/demo/index.html", "dist/demo/index.html");
await writeFile("dist/.nojekyll", ""); // serve files verbatim

await build({
  entryPoints: ["src/demo/main.ts"],
  outfile: "dist/demo/main.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  logLevel: "info",
  // tsconfig.json maps @anon-rpc/browser-harness to the harness SOURCE so
  // typechecking works pre-build — but esbuild honors tsconfig paths too, and
  // bundling the source skips the harness build's define-injected iframe/
  // worker-runtime sources (a raw __IFRAME_BOOT_SRC__ reaches the browser).
  // An empty tsconfig here makes the bundler resolve the real package
  // exports: the BUILT dist/host.js.
  tsconfigRaw: "{}",
});

console.log("site built");
