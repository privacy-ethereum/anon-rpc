// Specifier tests: forge unit tests for the contract, then an end-to-end run
// of the real publish script against a local anvil chain, with a local HTTP
// server standing in as the resolver (so the pre-deploy verification path is
// exercised, not skipped). Skips gracefully when Foundry is not installed.

import { spawn, execSync } from "node:child_process";
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { keccak_256 } from "@noble/hashes/sha3";
import { uploadToGithubResolver, parseGithubRemote, rawUrl } from "../github-resolver.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;

// Anvil's well-known dev account #0 (prefunded on every anvil instance).
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const cleanups = [];
const cleanup = () => cleanups.splice(0).reverse().forEach((fn) => { try { fn(); } catch {} });
process.on("exit", cleanup);

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  cleanup();
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, ...opts });
    let out = "";
    p.stdout.on("data", (b) => { out += b; process.stdout.write(b); });
    p.stderr.on("data", (b) => { out += b; process.stderr.write(b); });
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`))));
  });
}

function assert(cond, label) {
  if (!cond) fail(`assertion failed: ${label}`);
  console.log(`  ✓ ${label}`);
}

// --- github-resolver tests (git only; no foundry needed) ---------------------
//
// A scratch repo whose origin has a github-looking FETCH url (so raw-URL
// derivation runs for real) but a local bare repo as PUSH url (so pushes are
// real too, without touching the network).

console.log("github-resolver tests");
{
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  const scratch = `${HERE}.tmp-git`;
  await rm(scratch, { recursive: true, force: true });
  await mkdir(`${scratch}/work`, { recursive: true });
  const g = (dir, ...args) =>
    execSync(`git ${args.join(" ")}`, { cwd: `${scratch}/${dir}`, encoding: "utf8" }).trim();

  g(".", "init --bare origin.git");
  g("work", "init -b main");
  g("work", "config user.email t@t.test");
  g("work", "config user.name t");
  await writeFile(`${scratch}/work/README.md`, "code history\n");
  g("work", "add .");
  g("work", "commit -qm init");
  g("work", "remote add origin git@github.com:acme/widgets.git");
  g("work", `remote set-url --push origin ${scratch}/origin.git`);

  // URL derivation.
  assert(
    rawUrl(parseGithubRemote("git@github.com:acme/widgets.git"), "keccak", "aabb") ===
      "https://raw.githubusercontent.com/acme/widgets/keccak/aa/bb",
    "raw URL from ssh remote",
  );
  assert(
    rawUrl(parseGithubRemote("https://github.com/acme/widgets"), "keccak", "aabb") ===
      "https://raw.githubusercontent.com/acme/widgets/keccak/aa/bb",
    "raw URL from https remote",
  );

  const bytesA = new TextEncoder().encode("bundle-a-bytes");
  const hashA = hex(keccak_256(bytesA));
  const upload = (bytes) =>
    uploadToGithubResolver({ bytes, repoDir: `${scratch}/work`, remote: "origin", branch: "keccak" });

  const first = await upload(bytesA);
  assert(
    first.url === `https://raw.githubusercontent.com/acme/widgets/keccak/${hashA.slice(0, 2)}/${hashA.slice(2)}`,
    "upload reports the content-addressed raw URL",
  );
  assert(
    g("work", `cat-file blob keccak:${hashA.slice(0, 2)}/${hashA.slice(2)}`) === "bundle-a-bytes",
    "bundle stored at hash[0:2]/hash[2:]",
  );
  assert(g("work", "rev-list --count keccak") === "1", "orphan branch has exactly one commit");
  // (--git-dir: respects safe.bareRepository=explicit configs)
  assert(g(".", "--git-dir=origin.git rev-parse keccak") === first.commit, "pushed to the remote");
  let independent = false;
  try {
    g("work", "merge-base keccak main");
  } catch {
    independent = true;
  }
  assert(independent, "keccak history is independent of main");

  const again = await upload(bytesA);
  assert(again.alreadyPresent && g("work", "rev-list --count keccak") === "1", "re-upload is a no-op");

  const bytesB = new TextEncoder().encode("bundle-b-bytes");
  const hashB = hex(keccak_256(bytesB));
  await upload(bytesB);
  assert(g("work", "rev-list --count keccak") === "2", "second bundle appends a commit");
  assert(
    g("work", `cat-file blob keccak:${hashA.slice(0, 2)}/${hashA.slice(2)}`) === "bundle-a-bytes" &&
      g("work", `cat-file blob keccak:${hashB.slice(0, 2)}/${hashB.slice(2)}`) === "bundle-b-bytes",
    "both bundles remain retrievable",
  );

  await rm(scratch, { recursive: true, force: true });
}

// --- contract + publish-script tests (need foundry) --------------------------

try {
  execSync("forge --version", { stdio: "ignore" });
} catch {
  console.log("⚠ foundry not installed — skipping contract/publish tests (https://getfoundry.sh)");
  process.exit(0);
}

// 1. Contract unit tests.
await run("forge", ["test"]);

// 2. Build the worker bundle the publish script defaults to.
await run("npm", ["run", "build"], { cwd: `${ROOT}../passthrough-worker` });
const bundle = await readFile(`${ROOT}../passthrough-worker/dist/passthrough-worker.js`);

// 3. Local resolver serving the bundle bytes.
const resolver = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/javascript" });
  res.end(bundle);
});
await new Promise((r) => resolver.listen(0, "127.0.0.1", r));
cleanups.push(() => resolver.close());
const resolverUrl = `http://127.0.0.1:${resolver.address().port}/passthrough-worker.js`;

// 4. Local chain.
const anvilPort = 20000 + Math.floor(Math.random() * 20000);
const anvil = spawn("anvil", ["--port", String(anvilPort)], { stdio: "ignore" });
cleanups.push(() => anvil.kill("SIGKILL"));
const rpcUrl = `http://127.0.0.1:${anvilPort}`;
for (let i = 0; ; i++) {
  try {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    if (r.ok) break;
  } catch {
    if (i > 50) fail("anvil did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}

// 5. The real publish script, non-interactive, against anvil. The script
//    self-verifies the on-chain read-back, so exit 0 + an address is success.
const out = await run("node", ["publish-worker.mjs", "--yes"], {
  env: {
    ...process.env,
    RPC_URL: rpcUrl,
    PRIVATE_KEY: ANVIL_KEY,
    RESOLVER_URLS: resolverUrl,
  },
});
const address = out.match(/address: "(0x[0-9a-fA-F]{40})"/)?.[1];
if (!address) fail("publish script did not print a deployed specifier address");
if (!out.includes("✓ resolver serves the pinned bytes")) fail("resolver verification did not run");
if (!out.includes("✓ on-chain read-back matches")) fail("on-chain read-back did not run");

console.log(`\n✅ specifier tests passed (published at ${address} on local anvil)`);
cleanup();
process.exit(0);
