// End-to-end test of the prototype against a REAL kps peer.
//
// Pipeline:
//   1. build the bundles
//   2. compute the demo bundle's keccak hash and ABI-encode a mock specifier
//      (workerHash() / workerResolvers()) so the §4 path runs for real
//   3. start the Go kps echo server, capture its ip:port:certhash address
//   4. serve the page + dist assets + a /hello passthrough endpoint
//   5. drive headless Chromium: instantiate AnonRpcWorker, await ready,
//      exercise a plain-fetch passthrough AND a kps-routed echo, assert results
//
// Run: npm run test:e2e

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { keccak_256 } from "@noble/hashes/sha3";
import { chromium } from "playwright";

const KPS_REPO = "/home/andrew/workspaces/kps";
const HERE = new URL(".", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;

const cleanups = [];
const cleanup = () => cleanups.splice(0).reverse().forEach((fn) => { try { fn(); } catch {} });
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  cleanup();
  process.exit(1);
}

/* --- minimal ABI encoders matching src/host/specifier.ts decoders --- */

const enc = new TextEncoder();
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const selector = (sig) => "0x" + toHex(keccak_256(enc.encode(sig))).slice(0, 8);

function pad32(b) {
  const out = new Uint8Array(Math.ceil(b.length / 32) * 32 || 32);
  out.set(b);
  return out;
}
function word(n) {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && n > 0; i--) { out[i] = n & 0xff; n = Math.floor(n / 256); }
  return out;
}
function concat(arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
// Encode `string[]` as a single dynamic return value (head offset = 0x20).
function encodeStringArray(strings) {
  const items = strings.map((s) => enc.encode(s));
  const len = word(items.length);
  const heads = [];
  const tails = [];
  let tailOffset = items.length * 32;
  for (const item of items) {
    heads.push(word(tailOffset));
    const tail = concat([word(item.length), pad32(item)]);
    tails.push(tail);
    tailOffset += tail.length;
  }
  const array = concat([len, ...heads, ...tails]);
  return concat([word(0x20), array]);
}

async function main() {
  // 1. build
  await run("node", ["build.mjs"], { cwd: ROOT });

  // 2. hash + mock specifier
  const demoBytes = new Uint8Array(await readFile(`${ROOT}dist/demo-worker.js`));
  const workerHash = "0x" + toHex(keccak_256(demoBytes));

  // 3. kps echo server
  const kpsAddr = await startKpsServer();
  console.log(`kps echo server: ${kpsAddr}`);

  // 4. http server
  const { origin, ethCallMap, port } = await startHttpServer({ workerHash });
  console.log(`http server: ${origin}`);

  // 5. drive chromium
  const browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--force-webrtc-ip-handling-policy=default",
    ],
  });
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  page.on("console", (m) => console.log(`  [page:${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => console.log(`  [page:error] ${e.message}`));

  await page.goto(`${origin}/`);
  await page.waitForFunction(() => "AnonRpcWorker" in window, null, { timeout: 5000 });

  const result = await page.evaluate(
    async (cfg) => {
      const provider = {
        request: async ({ method, params }) => {
          if (method !== "eth_call") throw new Error(`unexpected method ${method}`);
          const sel = params[0].data.slice(0, 10);
          const ret = cfg.ethCallMap[sel];
          if (!ret) throw new Error(`no mock eth_call for ${sel}`);
          return ret;
        },
      };
      const w = new window.AnonRpcWorker({
        address: cfg.specifierAddress,
        preExisting: { rpcProvider: provider },
      });
      await w.ready;

      const sandbox = document.querySelector("iframe")?.getAttribute("sandbox");

      const r1 = await w.fetch(`${cfg.origin}/hello`);
      const passthrough = await r1.text();

      const payload = "ping-over-real-kps-" + "x".repeat(100);
      const r2 = await w.fetch(`kps+echo://${cfg.kpsAddr}`, { method: "POST", body: payload });
      const echoed = await r2.text();

      w.close();
      return { sandbox, passthrough, echoed, sentPayload: payload };
    },
    { ethCallMap, specifierAddress: "0xabc0000000000000000000000000000000000001", kpsAddr, origin },
  );

  // assertions
  check("iframe sandbox is allow-scripts only (§6)", result.sandbox, "allow-scripts");
  check("plain fetch passthrough body", result.passthrough, `hello from ${origin}`);
  check("kps-routed echo round-trips bytes", result.echoed, result.sentPayload);

  console.log("\n✅ all e2e assertions passed");
  cleanup();
  process.exit(0);

  /* helpers bound to closure */

  async function startHttpServer({ workerHash }) {
    const hostBundle = await readFile(`${ROOT}dist/host.js`);
    const demoBundle = await readFile(`${ROOT}dist/demo-worker.js`);
    const page = await readFile(`${HERE}page.html`);

    const server = createServer(async (req, res) => {
      const url = req.url.split("?")[0];
      if (url === "/") return send(res, 200, "text/html", page);
      if (url === "/dist/host.js") return send(res, 200, "text/javascript", hostBundle);
      if (url === "/dist/demo-worker.js") return send(res, 200, "text/javascript", demoBundle);
      if (url === "/hello") return send(res, 200, "text/plain", `hello from ${originRef.value}`);
      send(res, 404, "text/plain", "not found");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => server.close());
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    originRef.value = origin;

    const resolvers = [`${origin}/dist/demo-worker.js`];
    const ethCallMap = {
      [selector("workerHash()")]: workerHash,
      [selector("workerResolvers()")]: "0x" + toHex(encodeStringArray(resolvers)),
    };
    return { origin, ethCallMap, port };
  }
}

const originRef = { value: "" };

function check(label, actual, expected) {
  if (actual !== expected) fail(`${label}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`);
  console.log(`  ✓ ${label}`);
}

function send(res, status, type, body) {
  // The worker fetches /hello from a null origin (sandboxed iframe), so the
  // response must be CORS-readable or it would come back opaque.
  res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*" });
  res.end(body);
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

function startKpsServer() {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "go",
      ["run", "./libs/go/cmd/server", "-listen", "127.0.0.1:0", "-ip", "127.0.0.1", "-key", `${HERE}.tmp-kps.key`],
      { cwd: KPS_REPO },
    );
    cleanups.push(() => p.kill("SIGKILL"));
    let out = "";
    const timer = setTimeout(() => reject(new Error("kps server did not print address in time")), 30000);
    const onData = (buf) => {
      out += buf.toString();
      const m = out.match(/kps\.dial\("([^"]+)"\)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", (b) => process.stderr.write(`  [kps] ${b}`));
    p.on("exit", (code) => reject(new Error(`kps server exited early (${code})`)));
  });
}

main().catch((e) => fail(e.stack || String(e)));
