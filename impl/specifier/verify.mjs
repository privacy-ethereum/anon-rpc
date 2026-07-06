// Verifies a deployed WorkerSpecifier's source on a block explorer via
// `forge verify-contract`. Constructor args are recovered from the creation
// transaction (--guess-constructor-args), so this works for any past deploy
// regardless of setWorker() calls since.
//
// Configuration (environment or ./.env):
//   RPC_URL             chain RPC endpoint (used to derive chain id + args)
//   ETHERSCAN_API_KEY   for the default etherscan verifier (one v2 key works
//                       across Etherscan-family explorers)
//   VERIFIER            "etherscan" (default) | "sourcify" (needs no key)
//
// Standalone: npm run verify -- <address>

import { spawn } from "node:child_process";
import { loadEnv } from "./env.mjs";

const HERE = new URL(".", import.meta.url).pathname;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (b) => {
      out += b;
      process.stdout.write(b);
    });
    p.stderr.on("data", (b) => {
      out += b;
      process.stderr.write(b);
    });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`))));
  });
}

/**
 * Best-effort explorer verification. Returns true on success; on failure
 * prints the manual command and returns false (never throws): a deployed
 * contract must not be reported as a failed publish over an explorer hiccup.
 */
export async function verifyContract({ address, rpcUrl, apiKey, verifier = "etherscan" }) {
  const args = [
    "verify-contract",
    address,
    "src/WorkerSpecifier.sol:WorkerSpecifier",
    "--rpc-url", rpcUrl,
    "--guess-constructor-args",
    "--watch",
  ];
  if (verifier === "sourcify") args.push("--verifier", "sourcify");
  else args.push("--etherscan-api-key", apiKey);

  try {
    await run("forge", args);
    return true;
  } catch {
    console.error(
      `\n⚠ source verification failed (the contract itself is deployed and fine).\nRetry manually:\n  cd impl/specifier && forge ${args
        .map((a) => (a === apiKey ? "<ETHERSCAN_API_KEY>" : a))
        .join(" ")}`,
    );
    return false;
  }
}

// --- standalone CLI ---

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const address = process.argv[2];
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) {
    console.error("usage: npm run verify -- <specifier-address>");
    process.exit(1);
  }
  const env = await loadEnv(`${HERE}.env`);
  if (!env.RPC_URL) {
    console.error("RPC_URL is not set");
    process.exit(1);
  }
  const verifier = env.VERIFIER || "etherscan";
  if (verifier === "etherscan" && !env.ETHERSCAN_API_KEY) {
    console.error("ETHERSCAN_API_KEY is not set (or use VERIFIER=sourcify, which needs no key)");
    process.exit(1);
  }
  const ok = await verifyContract({
    address,
    rpcUrl: env.RPC_URL,
    apiKey: env.ETHERSCAN_API_KEY,
    verifier,
  });
  process.exit(ok ? 0 : 1);
}
