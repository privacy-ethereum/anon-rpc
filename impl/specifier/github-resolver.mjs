// GitHub as a worker-bundle resolver: a content-addressed store on an orphan
// branch (default "keccak", independent history), with each bundle at
// <hash[0:2]>/<hash[2:]> (keccak256 hex, no 0x). The raw.githubusercontent
// URL for that path is immutable by construction — the content of a path can
// never change — which is exactly right for hash-pinned resolvers (§4).
//
// Implemented with git plumbing (hash-object / mktree / commit-tree /
// update-ref), so uploading never touches the working tree, index, or the
// currently checked-out branch.
//
// Standalone CLI: node github-resolver.mjs <bundle-path>   (uploads + pushes)

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { keccak_256 } from "@noble/hashes/sha3";

const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function git(repoDir, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd: repoDir });
    let out = "";
    let err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.join(" ")} failed:\n${err || out}`)),
    );
    if (input !== undefined) p.stdin.write(input);
    p.stdin.end();
  });
}

async function tryGit(repoDir, args) {
  try {
    return await git(repoDir, args);
  } catch {
    return undefined;
  }
}

/** "git@github.com:o/r.git" | "https://github.com/o/r(.git)" -> { owner, repo } */
export function parseGithubRemote(url) {
  const m =
    url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/) ??
    url.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`not a github remote: ${url}`);
  return { owner: m[1], repo: m[2] };
}

export function rawUrl({ owner, repo }, branch, hashHex) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${hashHex.slice(0, 2)}/${hashHex.slice(2)}`;
}

/**
 * Commit `bytes` at its content address on `branch` and push to `remote`.
 * Returns { url, hashHex, alreadyPresent, commit }.
 */
export async function uploadToGithubResolver({
  bytes,
  repoDir,
  remote = "origin",
  branch = "keccak",
  push = true,
}) {
  const hashHex = toHex(keccak_256(bytes));
  const dir = hashHex.slice(0, 2);
  const file = hashHex.slice(2);

  const remoteUrl = await git(repoDir, ["remote", "get-url", remote]);
  const url = rawUrl(parseGithubRemote(remoteUrl), branch, hashHex);

  // Base the new commit on the freshest view of the branch: remote-tracking
  // after a fetch, else a local branch, else nothing (orphan root commit —
  // the branch's history stays independent of the code history).
  await tryGit(repoDir, ["fetch", remote, branch]);
  const base =
    (await tryGit(repoDir, ["rev-parse", "--verify", `refs/remotes/${remote}/${branch}`])) ??
    (await tryGit(repoDir, ["rev-parse", "--verify", `refs/heads/${branch}`]));

  const blob = await git(repoDir, ["hash-object", "-w", "--stdin"], { input: bytes });

  // Already stored? (Content-addressed: same path implies same bytes, but
  // compare the blob to be exact.)
  if (base) {
    const existing = await tryGit(repoDir, ["rev-parse", "--verify", `${base}:${dir}/${file}`]);
    if (existing === blob) {
      await git(repoDir, ["update-ref", `refs/heads/${branch}`, base]);
      if (push) await git(repoDir, ["push", remote, `refs/heads/${branch}:refs/heads/${branch}`]);
      return { url, hashHex, alreadyPresent: true, commit: base };
    }
  }

  // Inner tree: existing entries of <dir> plus our blob.
  const innerEntries = new Map();
  if (base && (await tryGit(repoDir, ["rev-parse", "--verify", `${base}:${dir}`]))) {
    for (const line of (await git(repoDir, ["ls-tree", `${base}:${dir}`])).split("\n")) {
      if (!line) continue;
      const [meta, name] = line.split("\t");
      innerEntries.set(name, meta);
    }
  }
  innerEntries.set(file, `100644 blob ${blob}`);
  const innerTree = await git(repoDir, ["mktree"], {
    input: [...innerEntries.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, meta]) => `${meta}\t${name}`)
      .join("\n") + "\n",
  });

  // Root tree: existing top-level entries with <dir> pointing at the new tree.
  const rootEntries = new Map();
  if (base) {
    for (const line of (await git(repoDir, ["ls-tree", base])).split("\n")) {
      if (!line) continue;
      const [meta, name] = line.split("\t");
      rootEntries.set(name, meta);
    }
  }
  rootEntries.set(dir, `040000 tree ${innerTree}`);
  const rootTree = await git(repoDir, ["mktree"], {
    input: [...rootEntries.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, meta]) => `${meta}\t${name}`)
      .join("\n") + "\n",
  });

  const commit = await git(
    repoDir,
    ["commit-tree", rootTree, ...(base ? ["-p", base] : []), "-m", `keccak: add ${hashHex}`],
  );
  await git(repoDir, ["update-ref", `refs/heads/${branch}`, commit]);
  if (push) await git(repoDir, ["push", remote, `refs/heads/${branch}:refs/heads/${branch}`]);

  return { url, hashHex, alreadyPresent: false, commit };
}

// --- standalone CLI ---

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const bundlePath = process.argv[2];
  if (!bundlePath) {
    console.error("usage: node github-resolver.mjs <bundle-path>");
    process.exit(1);
  }
  const repoDir = new URL("../..", import.meta.url).pathname;
  const bytes = new Uint8Array(await readFile(bundlePath));
  const res = await uploadToGithubResolver({ bytes, repoDir });
  console.log(`${res.alreadyPresent ? "already present" : "uploaded"}: ${res.url}`);
}
