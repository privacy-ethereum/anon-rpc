// Publishes a worker on-chain: deploys a WorkerSpecifier pinning the bundle's
// keccak256 hash (SPEC.md §4), pointing at your resolver URLs.
//
// Configuration (environment, or a gitignored .env file in this directory):
//   RPC_URL              chain RPC endpoint
//   PRIVATE_KEY          deployer key holding funds for gas (never printed)
//   RESOLVER_URLS        comma-separated URLs that serve the bundle bytes
//   GITHUB_RESOLVER      set to 1 (or pass --github) to upload the bundle to
//                        this repo's content-addressed "keccak" branch and use
//                        the raw.githubusercontent URL as a resolver
//   WORKER_BUNDLE        path to the bundle (default: the passthrough worker,
//                        auto-rebuilt so the hash matches current source)
//   SKIP_RESOLVER_CHECK  set to 1 to skip verifying the URLs serve the bytes
//
// Usage: npm run publish-worker [-- --yes --github]
//
// Foundry (forge + cast) must be installed: https://getfoundry.sh

import { readFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { keccak_256 } from "@noble/hashes/sha3";
import { uploadToGithubResolver } from "./github-resolver.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const DEFAULT_BUNDLE = `${HERE}../passthrough-worker/dist/passthrough-worker.js`;
const toHex = (b) => "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

// --- configuration ---

async function loadEnv() {
  const env = { ...process.env };
  try {
    const dotenv = await readFile(`${HERE}.env`, "utf8");
    for (const line of dotenv.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // no .env file — environment variables only
  }
  return env;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: HERE, ...opts });
    let out = "";
    let err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} ${args[0]} failed:\n${err || out}`)),
    );
  });
}

async function main() {
  const env = await loadEnv();
  const yes = process.argv.includes("--yes");

  const useGithub = env.GITHUB_RESOLVER === "1" || process.argv.includes("--github");

  const rpcUrl = env.RPC_URL || fail("RPC_URL is not set");
  const privateKey = env.PRIVATE_KEY || fail("PRIVATE_KEY is not set");
  const resolvers = (env.RESOLVER_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (resolvers.length === 0 && !useGithub) {
    fail("no resolvers: set RESOLVER_URLS and/or pass --github (GITHUB_RESOLVER=1)");
  }

  // 1. The bundle. The default (passthrough worker) is rebuilt so the pinned
  //    hash always reflects current source; an explicit path is used as-is.
  let bundlePath = env.WORKER_BUNDLE;
  if (!bundlePath) {
    console.log("building passthrough-worker (WORKER_BUNDLE not set)…");
    await run("npm", ["run", "build"], { cwd: `${HERE}../passthrough-worker` });
    bundlePath = DEFAULT_BUNDLE;
  }
  await access(bundlePath).catch(() => fail(`bundle not found: ${bundlePath}`));
  const bundle = new Uint8Array(await readFile(bundlePath));
  const hash = toHex(keccak_256(bundle));

  // 2. Optional GitHub resolver: commit the bundle at its content address on
  //    the orphan "keccak" branch and push; the raw URL joins the resolvers.
  if (useGithub) {
    const res = await uploadToGithubResolver({
      bytes: bundle,
      repoDir: `${HERE}../..`,
      remote: env.RESOLVER_REMOTE || "origin",
      branch: env.RESOLVER_BRANCH || "keccak",
    });
    console.log(`✓ github resolver ${res.alreadyPresent ? "already had the bundle" : "updated"}: ${res.url}`);
    if (!resolvers.includes(res.url)) resolvers.push(res.url);
  }

  // 3. Chain + account facts.
  const deployer = await run("cast", ["wallet", "address", "--private-key", privateKey]);
  const chainId = await run("cast", ["chain-id", "--rpc-url", rpcUrl]);
  const balance = await run("cast", ["balance", deployer, "--rpc-url", rpcUrl]);
  if (balance === "0") fail(`deployer ${deployer} has zero balance on chain ${chainId}`);

  console.log(`
publish plan
  chain id    ${chainId}
  deployer    ${deployer}  (balance ${balance} wei)
  bundle      ${bundlePath}  (${bundle.byteLength} bytes)
  workerHash  ${hash}
  resolvers   ${resolvers.join("\n              ")}
`);

  // 4. Resolvers must actually serve the pinned bytes (a harness will reject
  //    anything else). Deploying a specifier no resolver satisfies is wasted
  //    gas, so verify BEFORE spending it. Retries cover CDN propagation of a
  //    just-pushed github resolver path.
  if (env.SKIP_RESOLVER_CHECK === "1") {
    console.log("⚠ resolver verification skipped (SKIP_RESOLVER_CHECK=1)");
  } else {
    for (const url of resolvers) {
      let lastProblem;
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
        try {
          const resp = await fetch(url);
          if (!resp.ok) {
            lastProblem = `HTTP ${resp.status}`;
            continue;
          }
          const got = toHex(keccak_256(new Uint8Array(await resp.arrayBuffer())));
          if (got !== hash) {
            lastProblem = `serves DIFFERENT bytes (keccak ${got})`;
            continue;
          }
          ok = true;
        } catch (e) {
          lastProblem = `unreachable (${e.message})`;
        }
      }
      if (!ok) {
        fail(`resolver ${url}: ${lastProblem}\n   pinned: ${hash}\nUpload the current bundle there first (or SKIP_RESOLVER_CHECK=1).`);
      }
      console.log(`✓ resolver serves the pinned bytes: ${url}`);
    }
  }

  // 5. Confirm before spending funds.
  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("\ndeploy? (y/N) ");
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) fail("aborted");
  }

  // 6. Deploy.
  console.log("\ndeploying WorkerSpecifier…");
  const created = JSON.parse(
    await run("forge", [
      "create",
      "src/WorkerSpecifier.sol:WorkerSpecifier",
      "--rpc-url", rpcUrl,
      "--private-key", privateKey,
      "--broadcast",
      "--json",
      "--constructor-args", hash, JSON.stringify(resolvers),
    ]),
  );
  const address = created.deployedTo;
  console.log(`deployed: ${address}  (tx ${created.transactionHash})`);

  // 7. Read back through the public interface and verify.
  const onchainHash = await run("cast", ["call", address, "workerHash()(bytes32)", "--rpc-url", rpcUrl]);
  if (onchainHash.toLowerCase() !== hash.toLowerCase()) {
    fail(`read-back mismatch: workerHash() returned ${onchainHash}, expected ${hash}`);
  }
  const onchainResolvers = await run("cast", [
    "call", address, "workerResolvers()(string[])", "--rpc-url", rpcUrl,
  ]);
  for (const url of resolvers) {
    if (!onchainResolvers.includes(url)) fail(`read-back mismatch: workerResolvers() missing ${url}`);
  }
  console.log("✓ on-chain read-back matches");

  console.log(`
✅ worker published

  const worker = new AnonRpcWorker({
    address: "${address}",
    preExisting: { rpcProvider },
  });

To update later: setWorker(newHash, newResolvers) as the owner.
To freeze forever: renounceOwnership().
`);
}

main().catch((e) => fail(e.stack || String(e)));
