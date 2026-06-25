// §4 — Worker identity and integrity.
//
// Reads an on-chain IWorkerSpecifier (workerHash() / workerResolvers()) through
// a pre-existing RPC provider, fetches the bundle bytes from a resolver, and
// verifies keccak256(bytes) == workerHash. The hash is trust; the URL is not.

import { keccak_256 } from "@noble/hashes/sha3";
import type { RpcProvider } from "../spec-types.js";

const SEL_WORKER_HASH = selector("workerHash()");
const SEL_WORKER_RESOLVERS = selector("workerResolvers()");

function selector(sig: string): string {
  return "0x" + toHex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export type Specifier = { workerHash: string; resolvers: string[] };

export async function readSpecifier(
  provider: RpcProvider,
  address: string,
): Promise<Specifier> {
  const hashRet = await ethCall(provider, address, SEL_WORKER_HASH);
  const resolversRet = await ethCall(provider, address, SEL_WORKER_RESOLVERS);
  return {
    workerHash: "0x" + decodeBytes32(hashRet),
    resolvers: decodeStringArray(resolversRet),
  };
}

async function ethCall(provider: RpcProvider, to: string, data: string): Promise<Uint8Array> {
  const res = await provider.request({
    method: "eth_call",
    params: [{ to, data }, "latest"],
  });
  if (typeof res !== "string") throw new Error("eth_call did not return data");
  return hexToBytes(res);
}

/** Fetch bundle bytes from the first working resolver and verify the hash (§4). */
export async function fetchAndVerifyBundle(spec: Specifier): Promise<Uint8Array> {
  const errors: string[] = [];
  for (const url of spec.resolvers) {
    let bytes: Uint8Array;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      bytes = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`);
      continue;
    }
    const got = "0x" + toHex(keccak_256(bytes));
    if (got !== spec.workerHash) {
      // A resolver served bytes that don't match the pinned hash: reject and
      // try the next one. Any bytes matching the hash are acceptable (§4).
      errors.push(`${url}: hash mismatch (got ${got}, want ${spec.workerHash})`);
      continue;
    }
    return bytes;
  }
  throw new Error(`no resolver yielded bytes matching workerHash: ${errors.join("; ")}`);
}

/* --- minimal ABI return decoding (bytes32, string[]) --- */

function decodeBytes32(ret: Uint8Array): string {
  if (ret.length < 32) throw new Error("short bytes32 return");
  return toHex(ret.slice(0, 32));
}

function word(ret: Uint8Array, at: number): number {
  // Read a 32-byte word as an unsigned int (assumes it fits in JS number).
  let n = 0;
  for (let i = at; i < at + 32; i++) n = n * 256 + ret[i];
  return n;
}

function decodeStringArray(ret: Uint8Array): string[] {
  // Return is a single dynamic value: head word is the offset to the array.
  const base = word(ret, 0);
  const len = word(ret, base);
  const out: string[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < len; i++) {
    const elemOff = base + 32 + word(ret, base + 32 + i * 32);
    const strLen = word(ret, elemOff);
    out.push(dec.decode(ret.slice(elemOff + 32, elemOff + 32 + strLen)));
  }
  return out;
}
