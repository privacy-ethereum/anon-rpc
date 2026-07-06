// The balance-watcher demo: boots the anon-rpc browser harness against a
// user-supplied specifier contract and polls an address's ETH balance through
// the sandboxed worker's anonymized fetch.

import { AnonRpcWorker } from "@anon-rpc/browser-harness";

const SETTINGS_KEY = "anon-rpc-demo-settings";
const POLL_MS = 12_000; // ~mainnet block time
// The passthrough worker published on mainnet (editable below).
const DEFAULT_SPECIFIER = "0x4fd77be300f31c5fe6ab266d35d27750a3478d27";

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

function loadSettings(): void {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  } catch {
    // corrupted settings: start fresh
  }
  for (const f of fields) els[f].value = saved[f] ?? "";
  if (!els.specifier.value) els.specifier.value = DEFAULT_SPECIFIER;
}

function saveSettings(): void {
  const s = Object.fromEntries(fields.map((f) => [f, els[f].value.trim()]));
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

loadSettings();
for (const f of fields) els[f].addEventListener("input", saveSettings);
saveSettings(); // capture the default specifier on first visit

els.copy.addEventListener("click", () => {
  els.workerRpc.value = els.bootstrap.value;
  saveSettings();
});

/* --- status --- */

type State = "idle" | "boot" | "live" | "error";

function setStatus(state: State, detail: string): void {
  els.pill.className = `pill ${state === "idle" ? "" : state}`;
  els.pill.textContent = { idle: "idle", boot: "starting", live: "watching", error: "error" }[state];
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
  try {
    const call = jsonRpc(worker.fetch, s.workerRpc);
    const result = await call("eth_getBalance", [s.watch, "latest"]);
    const wei = BigInt(result as string);

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
    setStatus("live", `polling every ${POLL_MS / 1000} s through the sandboxed worker`);
  } catch (e) {
    // Keep polling: a transient RPC failure should not stop the watcher.
    setStatus("error", `balance query failed: ${(e as Error).message}`);
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

  setStatus("live", `polling every ${POLL_MS / 1000} s through the sandboxed worker`);
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
