// Vite build for the GitHub Pages site (landing + demo + spec, multi-page).
//
// Note: unlike raw esbuild, Vite does NOT read tsconfig `paths`, so the
// typecheck-only mapping of @anon-rpc/browser-harness to the harness SOURCE
// (tsconfig.json) cannot leak into the bundle — the bundler resolves the real
// package exports: the BUILT dist/host.js with its define-injected iframe/
// worker-runtime sources. The site smoke test still verifies the built bundle
// contains no unresolved defines, whatever the bundler.

import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Marked } from "marked";
import markedShiki from "marked-shiki";
import { createHighlighter } from "shiki";

// The spec page hosts the repo's normative SPEC.md, rendered at build time
// (and live in `vite dev`) into the <!--SPEC_HTML--> slot of spec/index.html.
// Code fences are syntax-highlighted with Shiki at build time — inline-styled
// spans, no runtime JS. Dracula's pink/purple/cyan sits naturally on the
// site's violet palette; its background is remapped to the site's code-block
// black.
let renderSpec;
async function renderSpecMarkdown() {
  if (!renderSpec) {
    const highlighter = await createHighlighter({
      themes: ["dracula"],
      langs: ["typescript", "solidity"],
    });
    const marked = new Marked(
      markedShiki({
        highlight: (code, lang) =>
          highlighter.codeToHtml(code, {
            lang: highlighter.getLoadedLanguages().includes(lang) ? lang : "text",
            theme: "dracula",
            colorReplacements: { "#282a36": "#08060d" },
          }),
      }),
    );
    renderSpec = (md) => marked.parse(md);
  }
  const md = readFileSync(resolve(import.meta.dirname, "../../SPEC.md"), "utf8");
  const html = await renderSpec(md);
  // Put the GitHub link on the title line: wrap the document's <h1> in a flex
  // row with the button, which flexbox centers at any viewport/font size.
  const gh =
    '<a class="ghost" href="https://github.com/privacy-ethereum/anon-rpc/blob/main/SPEC.md" target="_blank" rel="noopener">View on GitHub →</a>';
  return html.replace(
    /<h1([^>]*)>([\s\S]*?)<\/h1>/,
    (_m, attrs, inner) => `<div class="doc-head"><h1${attrs}>${inner}</h1>${gh}</div>`,
  );
}

function specPage() {
  return {
    name: "inject-spec-markdown",
    transformIndexHtml: {
      order: "pre",
      async handler(html, ctx) {
        if (!ctx.filename.endsWith(`spec${ctx.filename.includes("\\") ? "\\" : "/"}index.html`)) return;
        const spec = await renderSpecMarkdown();
        // Replacement via callback: rendered code can contain `$`, which a
        // string replacement would interpret as a substitution pattern.
        return html.replace("<!--SPEC_HTML-->", () => spec);
      },
    },
  };
}

export default defineConfig({
  root: "src",
  base: "./", // relative URLs: works at any Pages mount path
  plugins: [specPage()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "src/index.html"),
        demo: resolve(import.meta.dirname, "src/demo/index.html"),
        spec: resolve(import.meta.dirname, "src/spec/index.html"),
      },
    },
  },
});
