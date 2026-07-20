// Site smoke test: drives the BUILT demo (dist/) end-to-end with Playwright
// against an anvil chain — a specifier deployed by the real publish script, a
// local resolver, and the real harness boot inside the page. This is the test
// that catches "the bundle resolves the wrong artifact" regressions, which
// typecheck and the harness e2e cannot see.
//
// Skips gracefully when Foundry is absent (anvil is the chain).

import { spawn, execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

const HERE = new URL(".", import.meta.url).pathname; // impl/site/test/
const SITE = new URL("..", import.meta.url).pathname; // impl/site/
const IMPL = new URL("../..", import.meta.url).pathname; // impl/

// Anvil's well-known dev key #0 and dev account #1 as the watched address.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const WATCH = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const cleanups = [];
const cleanup = () => cleanups.splice(0).reverse().forEach((f) => { try { f(); } catch {} });
process.on("exit", cleanup);
const fail = (m) => { console.error("❌ " + m); cleanup(); process.exit(1); };
const ok = (m) => console.log("  ✓ " + m);

try {
  execSync("anvil --version", { stdio: "ignore" });
} catch {
  console.log("⚠ foundry not installed — skipping site smoke test (https://getfoundry.sh)");
  process.exit(0);
}

// Fresh build of everything the page loads.
await new Promise((resolve, reject) => {
  const p = spawn("npm", ["run", "build"], { cwd: IMPL, stdio: "ignore" });
  p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("build failed"))));
});

// The failure mode this test exists for: harness build-time defines must not
// leak into the site bundle as bare identifiers.
const bundleJs = await readFile(`${SITE}dist/demo/main.js`, "utf8");
for (const ident of ["__IFRAME_BOOT_SRC__", "__WORKER_RUNTIME_SRC__"]) {
  if (bundleJs.includes(ident)) fail(`site bundle contains unresolved build-time define ${ident}`);
}
ok("site bundle has no unresolved build-time defines");

// anvil
const anvilPort = 21000 + Math.floor(Math.random() * 9000);
const anvil = spawn("anvil", ["--port", String(anvilPort)], { stdio: "ignore" });
cleanups.push(() => anvil.kill("SIGKILL"));
const rpc = `http://127.0.0.1:${anvilPort}`;
for (let i = 0; ; i++) {
  try {
    const r = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
    });
    if (r.ok) break;
  } catch {}
  if (i > 50) fail("anvil didn't start");
  await new Promise((r) => setTimeout(r, 100));
}

// Local resolver serving the worker bundle (CORS for the page origin).
const workerBundle = await readFile(`${IMPL}passthrough-worker/dist/passthrough-worker.js`);
const resolver = createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" });
  res.end(workerBundle);
});
await new Promise((r) => resolver.listen(0, "127.0.0.1", r));
cleanups.push(() => resolver.close());
const resolverUrl = `http://127.0.0.1:${resolver.address().port}/w.js`;

// Deploy the specifier with the real publish script (all knobs pinned).
const out = await new Promise((resolve, reject) => {
  const p = spawn("node", ["publish-worker.mjs", "--yes"], {
    cwd: `${IMPL}specifier`,
    env: {
      ...process.env,
      RPC_URL: rpc,
      PRIVATE_KEY: ANVIL_KEY,
      RESOLVER_URLS: resolverUrl,
      GITHUB_RESOLVER: "0",
      SKIP_RESOLVER_CHECK: "0",
      WORKER_BUNDLE: `${IMPL}passthrough-worker/dist/passthrough-worker.js`,
      ETHERSCAN_API_KEY: "",
      VERIFIER: "etherscan",
    },
  });
  let o = "";
  p.stdout.on("data", (b) => (o += b));
  p.stderr.on("data", (b) => (o += b));
  p.on("exit", (code) => (code === 0 ? resolve(o) : reject(new Error(`publish failed:\n${o}`))));
});
const specifier = out.match(/address: "(0x[0-9a-fA-F]{40})"/)?.[1];
if (!specifier) fail("no specifier deployed");
ok(`specifier on anvil: ${specifier}`);

// Serve the built site.
const site = createServer(async (req, res) => {
  const path = req.url.split("?")[0].replace(/\/$/, "/index.html");
  try {
    const body = await readFile(`${SITE}dist${path}`);
    const type = path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : "text/javascript";
    res.writeHead(200, { "content-type": type });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
cleanups.push(() => site.close());
const siteUrl = `http://127.0.0.1:${site.address().port}`;

// Drive the demo UI.
const browser = await chromium.launch({ args: ["--no-sandbox"] });
cleanups.push(() => browser.close());
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  [page:error]", e.message));

await page.goto(`${siteUrl}/demo/`);

// Fresh visit: watch address prefills with the beacon deposit contract.
if ((await page.inputValue("#watch")) !== "0x00000000219ab540356cBB839Cbe05303d7705Fa") {
  fail("watch address did not prefill with the beacon deposit contract");
}
ok("watch address prefilled with the default");

await page.fill("#bootstrap", rpc);
await page.click("#copy");
if ((await page.inputValue("#worker-rpc")) !== rpc) fail("copy button didn't copy the bootstrap URL");
ok("copy button fills worker RPC from bootstrap");
await page.fill("#specifier", specifier);
await page.fill("#watch", WATCH);

await page.click("#toggle");
await page.waitForSelector(".pill.live", { timeout: 30000 }).catch(async () => {
  fail(`worker never went live — status: ${await page.textContent("#detail")}`);
});
ok("worker booted: specifier read + hash-verified bundle running");

await page.waitForFunction(
  () => document.getElementById("balance")?.textContent?.includes("10,000"),
  null,
  { timeout: 15000 },
);
ok("balance displayed through the sandboxed worker");

// Once watching, the status line reports the last request's outcome + timing.
const detail = await page.textContent("#detail");
if (!/request OK in \d+ ms/.test(detail ?? "")) {
  fail(`status detail missing request timing — got: ${detail}`);
}
ok(`status shows request outcome (${detail.trim()})`);

// Change the balance on-chain; the next poll must reflect it.
await fetch(rpc, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "anvil_setBalance",
    params: [WATCH, "0x" + (99995n * 10n ** 17n).toString(16)], // 9999.5 ETH
  }),
});
await page.waitForFunction(
  () => document.getElementById("balance")?.textContent?.includes("9,999.5"),
  null,
  { timeout: 20000 },
);
const delta = await page.textContent("#delta");
if (!delta?.includes("0.5")) fail(`expected a 0.5 delta, got: ${delta}`);
ok(`balance change detected on next poll (${delta.trim()})`);

// RPC URLs persist only after proven use (worker booted + balance fetched);
// specifier/watch persist as typed. After the successful run above, a reload
// must restore all four.
await page.reload();
if (
  (await page.inputValue("#bootstrap")) !== rpc ||
  (await page.inputValue("#worker-rpc")) !== rpc ||
  (await page.inputValue("#specifier")) !== specifier ||
  (await page.inputValue("#watch")) !== WATCH
) {
  fail("settings did not persist across reload after successful use");
}
ok("all settings persist across reload after successful use");

console.log("\n✅ site smoke test passed");
cleanup();
process.exit(0);
