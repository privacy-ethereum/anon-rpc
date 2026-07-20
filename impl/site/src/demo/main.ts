// The balance-watcher demo: boots the anon-rpc browser harness against a
// user-supplied specifier contract and polls an address's ETH balance through
// the sandboxed worker's anonymized fetch.

import { AnonRpcWorker } from "@anon-rpc/browser-harness";

const SETTINGS_KEY = "anon-rpc-demo-settings";
const POLL_MS = 12_000; // ~mainnet block time
// The passthrough worker published on mainnet (editable below).
const DEFAULT_SPECIFIER = "0x4fd77be300f31c5fe6ab266d35d27750a3478d27";
// The beacon deposit contract: a huge balance that changes constantly.
const DEFAULT_WATCH = "0x00000000219ab540356cBB839Cbe05303d7705Fa";
// Probed in order on first visit to prefill the RPC fields (all mainnet,
// CORS-open). Availability shifts, hence the probe rather than a hardcode.
const PUBLIC_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://1rpc.io/eth",
  "https://cloudflare-eth.com",
];

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const els = {
  bootstrap: $<HTMLInputElement>("bootstrap"),
  workerRpc: $<HTMLInputElement>("worker-rpc"),
  copy: $<HTMLButtonElement>("copy"),
  specifier: $<HTMLInputElement>("specifier"),
  watch: $<HTMLInputElement>("watch"),
  toggle: $<HTMLButtonElement>("toggle"),
  pill: $<HTMLSpanElement>("pill"),
  detail: $<HTMLSpanElement>("detail"),
  balanceCard: $<HTMLDivElement>("balance-card"),
  balance: $<HTMLDivElement>("balance"),
  delta: $<HTMLDivElement>("delta"),
  checked: $<HTMLDivElement>("checked"),
};

/* --- settings persistence --- */

type Settings = { bootstrap: string; workerRpc: string; specifier: string; watch: string };
const fields: (keyof Settings)[] = ["bootstrap", "workerRpc", "specifier", "watch"];

function readSaved(): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  } catch {
    return {}; // corrupted settings: start fresh
  }
}

function persist(patch: Partial<Settings>): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readSaved(), ...patch }));
}

const saved = readSaved();
for (const f of fields) els[f].value = saved[f] ?? "";
if (!els.specifier.value) els.specifier.value = DEFAULT_SPECIFIER;
if (!els.watch.value) els.watch.value = DEFAULT_WATCH;

// Specifier and watch address persist as typed. The RPC URLs deliberately do
// NOT: they are only saved once proven — bootstrap when a worker boots
// through it, worker RPC when a balance query succeeds — so a typo never
// becomes the sticky default.
els.specifier.addEventListener("input", () => persist({ specifier: els.specifier.value.trim() }));
els.watch.addEventListener("input", () => persist({ watch: els.watch.value.trim() }));

els.copy.addEventListener("click", () => {
  els.workerRpc.value = els.bootstrap.value;
});

// No proven RPC saved yet: probe the public list in order and prefill with
// the first endpoint that answers eth_chainId with mainnet (unless the user
// has started typing meanwhile).
if (!saved.bootstrap) {
  void (async () => {
    const restore = els.bootstrap.placeholder;
    els.bootstrap.placeholder = "checking public RPCs…";
    try {
      for (const url of PUBLIC_RPCS) {
        try {
          const resp = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
            signal: AbortSignal.timeout(4000),
          });
          const body = (await resp.json()) as { result?: string };
          if (body.result !== "0x1") continue;
          if (!els.bootstrap.value) els.bootstrap.value = url;
          if (!els.workerRpc.value) els.workerRpc.value = url;
          return;
        } catch {
          // endpoint down or slow: try the next one
        }
      }
    } finally {
      els.bootstrap.placeholder = restore;
    }
  })();
}

/* --- status --- */

type State = "idle" | "boot" | "ready" | "live" | "error";

function setStatus(state: State, detail: string): void {
  els.pill.className = `pill ${state === "idle" ? "" : state}`;
  els.pill.textContent =
    { idle: "idle", boot: "starting", ready: "ready", live: "watching", error: "error" }[state];
  els.detail.textContent = detail;
}

/* --- balance formatting --- */

const WEI = 10n ** 18n;

function formatEth(wei: bigint, maxDecimals = 6): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = (abs / WEI).toLocaleString("en-US");
  const frac = (abs % WEI).toString().padStart(18, "0").slice(0, maxDecimals).replace(/0+$/, "");
  return `${neg ? "−" : ""}${whole}${frac ? "." + frac : ""}`;
}

/* --- watcher --- */

let worker: AnonRpcWorker | undefined;
let timer: number | undefined;
let lastBalance: bigint | undefined;
let running = false;

function jsonRpc(fetchImpl: typeof fetch, url: string) {
  let id = 0;
  return async (method: string, params: unknown[]): Promise<unknown> => {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${new URL(url).host}`);
    const body = (await resp.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? "RPC error");
    return body.result;
  };
}

function validate(): Settings {
  const s = Object.fromEntries(fields.map((f) => [f, els[f].value.trim()])) as Settings;
  const isUrl = (u: string) => /^https?:\/\//.test(u);
  const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
  if (!isUrl(s.bootstrap)) throw new Error("bootstrap RPC URL must be http(s)");
  if (!isUrl(s.workerRpc)) throw new Error("worker RPC URL must be http(s)");
  if (!isAddr(s.specifier)) throw new Error("specifier must be a 0x… address");
  if (!isAddr(s.watch)) throw new Error("watch address must be a 0x… address");
  return s;
}

async function tick(s: Settings): Promise<void> {
  if (!worker || !running) return;
  const t0 = Date.now();
  // In-flight: stay "ready" until the first balance lands, "watching" after.
  setStatus(
    lastBalance === undefined ? "ready" : "live",
    `eth_getBalance in flight through the worker…`,
  );
  try {
    const call = jsonRpc(worker.fetch, s.workerRpc);
    const result = await call("eth_getBalance", [s.watch, "latest"]);
    if (!running) return; // stopped while the request was in flight
    const wei = BigInt(result as string);

    // The worker RPC answered a real query: it has earned persistence.
    persist({ workerRpc: s.workerRpc });

    els.balanceCard.style.display = "block";
    els.balance.innerHTML = `${formatEth(wei)} <span class="unit">ETH</span>`;
    els.checked.textContent = `last checked ${new Date().toLocaleTimeString()}`;

    if (lastBalance !== undefined && wei !== lastBalance) {
      const diff = wei - lastBalance;
      const up = diff > 0n;
      els.delta.textContent = `${up ? "+" : "−"}${formatEth(diff < 0n ? -diff : diff, 8)} ETH`;
      els.delta.className = up ? "up" : "down";
      els.balance.classList.add(up ? "flash-up" : "flash-down");
      setTimeout(() => els.balance.classList.remove("flash-up", "flash-down"), 2500);
    }
    lastBalance = wei;
    setStatus(
      "live",
      `request OK in ${Date.now() - t0} ms — next poll in ${POLL_MS / 1000} s`,
    );
  } catch (e) {
    if (!running) return; // stop() rejected the in-flight request: not an error
    // Keep polling: a transient RPC failure should not stop the watcher.
    setStatus(
      "error",
      `balance query failed after ${Date.now() - t0} ms: ${(e as Error).message} — retrying in ${POLL_MS / 1000} s`,
    );
  }
}

async function start(): Promise<void> {
  let s: Settings;
  try {
    s = validate();
  } catch (e) {
    setStatus("error", (e as Error).message);
    return;
  }

  running = true;
  els.toggle.textContent = "Stop";
  for (const f of fields) els[f].disabled = true;
  els.copy.disabled = true;
  lastBalance = undefined;
  els.delta.textContent = "";
  els.delta.className = "";

  setStatus("boot", "reading specifier, fetching bundle, verifying keccak256…");
  const bootstrapCall = jsonRpc(fetch, s.bootstrap);
  worker = new AnonRpcWorker({
    address: s.specifier,
    preExisting: {
      rpcProvider: {
        request: ({ method, params }) => bootstrapCall(method, (params as unknown[]) ?? []),
      },
    },
  });

  try {
    await worker.ready;
  } catch (e) {
    setStatus("error", `worker failed to start: ${(e as Error).message}`);
    stop(true);
    return;
  }
  if (!running) return; // stopped while booting

  // A worker booted through this bootstrap RPC: it has earned persistence.
  persist({ bootstrap: s.bootstrap });

  // `worker.ready` fulfilled: the hash-verified bundle is running in the
  // sandbox. tick() takes over the status from its first in-flight request.
  setStatus("ready", "worker ready — bundle verified and running in the sandbox");
  void tick(s);
  timer = window.setInterval(() => void tick(s), POLL_MS);
}

function stop(keepStatus = false): void {
  running = false;
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  worker?.close();
  worker = undefined;
  els.toggle.textContent = "Start watching";
  for (const f of fields) els[f].disabled = false;
  els.copy.disabled = false;
  if (!keepStatus) setStatus("idle", "");
}

els.toggle.addEventListener("click", () => (running ? stop() : void start()));
