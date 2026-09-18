// FOC Compute — local proof of concept.
//
// One program that:
//   1. starts a private local blockchain (anvil, 1 block = 1 epoch = 1 second here; 30 s on Filecoin),
//   2. installs the real FilecoinPayV1 (FilOzone/filecoin-pay @ 04ded6a), a test USDFC token,
//      MockPDP (stand-in for PDPVerifier) and our ComputeService,
//   3. plays the storage provider: holds the client's data set, starts services, runs jobs in
//      containers (Docker), stores outputs as new pieces and gets paid through Filecoin Pay,
//   4. serves the demo page on http://localhost:8080, whose buttons send real transactions.
//
// Accounts are anvil's built-in test accounts (fake money, no keys handled here):
//   #0 deployer, #1 client ("you"), #2 storage provider.

import { spawn, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, http as rpc, parseUnits, formatUnits, keccak256, toHex, BaseError, getAddress,
} from "viem";
import { foundry } from "viem/chains";

const execFile = promisify(execFileCb);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.join(HERE, "..", "contracts");
// Working files live outside ~/Documents: macOS asks for extra permission before Docker can read Documents.
const RUN = path.join(process.env.HOME, ".foc-compute-poc");
const STORAGE = path.join(RUN, "storage"); // the provider's copy of the client's data set
const RPC_PORT = 8545;
const WEB_PORT = 8080;
const ENV_PATH = `${process.env.PATH}:${process.env.HOME}/.foundry/bin:/usr/local/bin:/opt/homebrew/bin`;

// ---------------------------------------------------------------- parameters

const U = (x) => parseUnits(String(x), 18); // USDFC has 18 decimals
const fmt = (x) => Number(formatUnits(x, 18)).toFixed(4);

const PARAMS = {
  walletStart: U(5),
  session: {
    name: "Search assistant over your files",
    image: "search:v1",
    rate: U("0.001"), // per epoch
    lockupPeriod: 60n, // epochs of safety margin
  },
  jobs: {
    index: { name: "Build a search index of my files", image: "indexer:v1", price: U("0.5"), deadline: 120n },
    sales: { name: "Summarise my sales table", image: "sales-report:v1", price: U("0.2"), deadline: 120n },
    late: { name: "Build a search index (provider will be late)", image: "indexer-slow:v1", price: U("0.5"), deadline: 15n },
  },
  approval: { rateAllowance: U("0.01"), lockupAllowance: U(3), maxLockupPeriod: 600n },
};
const digest = (image) => keccak256(toHex(image));
const IMAGE_BY_DIGEST = Object.fromEntries(
  [PARAMS.session.image, ...Object.values(PARAMS.jobs).map((j) => j.image)].map((i) => [digest(i), i]),
);

// Programs run inside the job containers (alpine Linux, no network, inputs read-only).
const JOB_SCRIPTS = {
  "indexer:v1": {
    output: "search-index.txt",
    inputs: (name) => name.endsWith(".txt"),
    script: `for f in /in/*; do tr 'A-Z' 'a-z' < "$f" | tr -cs 'a-z0-9' '\\n' | grep -E '^.{5,}$' | sort -u | sed "s|$| $(basename "$f")|"; done \
| awk '{a[$1]=a[$1]" "$2} END{for (w in a) print w ":" a[w]}' | sort > /out/search-index.txt`,
  },
  "sales-report:v1": {
    output: "sales-summary.txt",
    inputs: (name) => name.endsWith(".csv"),
    script: `awk -F, 'NR>1 {c[$2]+=$3; r[$2]+=$4; t+=$4} END {print "Sales summary"; for (k in r) printf "%s: %d customer-months, revenue %d USD\\n", k, c[k], r[k]; printf "Total revenue: %d USD\\n", t}' /in/*.csv > /out/sales-summary.txt`,
  },
};
JOB_SCRIPTS["indexer-slow:v1"] = { ...JOB_SCRIPTS["indexer:v1"], slow: true };

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
function artifact(name) {
  const j = JSON.parse(fs.readFileSync(path.join(CONTRACTS, "out", `${name}.sol`, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}
function reason(e) {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x?.data?.errorName);
    if (r?.data?.errorName) return `${r.data.errorName}${r.data.args?.length ? "(" + r.data.args.join(", ") + ")" : ""}`;
    return e.shortMessage;
  }
  return String(e?.message ?? e);
}
// one transaction at a time per account (keeps nonces in order)
const queues = new Map();
function serial(account, fn) {
  const prev = queues.get(account) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(account, next);
  return next;
}

// ---------------------------------------------------------------- chain

let pub, wallet, A, C; // clients, accounts, contracts
const ABI = {};
// the contract's ABI plus the errors of all our contracts, so revert reasons from nested calls decode too
const withErrors = (abi) => {
  const names = new Set(abi.filter((x) => x.type === "error").map((x) => x.name));
  const extra = Object.values(ABI).flat().filter((x) => x.type === "error" && !names.has(x.name) && names.add(x.name));
  return [...abi, ...extra];
};

async function startChain() {
  try {
    await fetch(`http://127.0.0.1:${RPC_PORT}`, { method: "POST" });
    throw new Error(`port ${RPC_PORT} is already in use — is the demo already running?`);
  } catch (e) {
    if (e.message.includes("already")) throw e;
  }
  const anvil = spawn("anvil", ["--block-time", "1", "--port", String(RPC_PORT), "--silent"], {
    env: { ...process.env, PATH: ENV_PATH }, stdio: "inherit",
  });
  process.on("exit", () => anvil.kill());
  pub = createPublicClient({ chain: foundry, transport: rpc(`http://127.0.0.1:${RPC_PORT}`), pollingInterval: 500 });
  wallet = createWalletClient({ chain: foundry, transport: rpc(`http://127.0.0.1:${RPC_PORT}`) });
  for (let i = 0; i < 50; i++) {
    try { await pub.getBlockNumber(); break; } catch { await sleep(200); }
  }
  const [deployer, client, provider] = (await wallet.getAddresses()).map((a) => getAddress(a));
  A = { deployer, client, provider };
}

async function send(account, address, abi, functionName, args = [], what = functionName) {
  return serial(account, async () => {
    // dry run first: if the contract would refuse, we get its reason instead of a failed transaction
    const { request } = await pub.simulateContract({ account, address, abi: withErrors(abi), functionName, args });
    const hash = await wallet.writeContract({ ...request, abi, chain: foundry, gas: 5_000_000n }); // estimates can be too low (nested Filecoin Pay calls)
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`${what} reverted`);
    return { what, fn: functionName, tx: hash, block: Number(rcpt.blockNumber), receipt: rcpt };
  });
}
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

async function deploy(name, args = []) {
  const { abi, bytecode } = artifact(name);
  ABI[name] = abi;
  const hash = await wallet.deployContract({ account: A.deployer, abi, bytecode, args, chain: foundry });
  const r = await pub.waitForTransactionReceipt({ hash });
  return getAddress(r.contractAddress);
}

async function installContracts() {
  say("Compiling contracts…");
  await execFile("forge", ["build"], { cwd: CONTRACTS, env: { ...process.env, PATH: ENV_PATH } });
  C = {};
  C.usdfc = await deploy("MockERC20", ["USDFC (local test token)", "USDFC"]);
  C.payments = await deploy("FilecoinPayV1");
  C.pdp = await deploy("MockPDP");
  C.cs = await deploy("ComputeService", [C.payments, C.usdfc, C.pdp]);
  await send(A.deployer, C.usdfc, ABI.MockERC20, "mint", [A.client, PARAMS.walletStart]);
  say("Installed:", C);
}

// ---------------------------------------------------------------- provider: data set

let dataSetId;
async function createDataSet() {
  fs.rmSync(RUN, { recursive: true, force: true });
  fs.mkdirSync(STORAGE, { recursive: true });
  const r = await send(A.provider, C.pdp, ABI.MockPDP, "createDataSet");
  dataSetId = await read(C.pdp, ABI.MockPDP, "nextDataSetId") - 1n;
  const src = path.join(HERE, "data", "dataset");
  for (const f of fs.readdirSync(src).sort()) {
    fs.copyFileSync(path.join(src, f), path.join(STORAGE, f));
    await addPiece(f, "input");
  }
  return r;
}
const pieceKind = {}; // pieceId -> "input" | "output"
async function addPiece(name, kind) {
  const bytes = fs.readFileSync(path.join(STORAGE, name));
  const cid = "sha256-" + crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 24);
  const pieceId = await read(C.pdp, ABI.MockPDP, "getNextPieceId", [dataSetId]);
  const r = await send(A.provider, C.pdp, ABI.MockPDP, "addPiece", [dataSetId, name, cid], `add piece ${name}`);
  pieceKind[pieceId] = kind;
  return { pieceId, cid, ...r };
}
async function listFiles() {
  const n = await read(C.pdp, ABI.MockPDP, "getNextPieceId", [dataSetId]);
  const out = [];
  for (let i = 0n; i < n; i++) {
    const [name, cid, live] = await read(C.pdp, ABI.MockPDP, "getPiece", [dataSetId, i]);
    const size = fs.existsSync(path.join(STORAGE, name)) ? fs.statSync(path.join(STORAGE, name)).size : 0;
    out.push({ pieceId: Number(i), name, cid, live, size, kind: pieceKind[i] ?? "input" });
  }
  return out;
}

// ---------------------------------------------------------------- provider: activity log

const providerLog = []; // what the provider did, newest last
const clientLog = [];
function plog(text, tx) {
  providerLog.push({ t: Date.now(), text, tx: tx?.tx, fn: tx?.fn, block: tx?.block });
  say("[provider]", text, tx?.fn ? `→ ${tx.fn} ${tx.tx.slice(0, 10)}…` : "");
}

// ---------------------------------------------------------------- provider: sessions

const sessionInfo = {}; // id -> { startBlock, stopBlock, stopped, closedBy, container }
const toSettle = new Set(); // railIds the provider keeps settling
const collected = {}, lastSettleTx = {}; // per rail: amount collected since last report
const container = (id) => `focs-session-${id}`;

async function onSessionOpened({ sessionId, provider, railId, imageDigest }) {
  if (provider !== A.provider) return;
  sessionInfo[sessionId] = { railId };
  plog(`Session #${sessionId} requested (${IMAGE_BY_DIGEST[imageDigest] ?? "unknown program"}). Starting the service next to your data…`);
  try {
    await execFile("docker", ["run", "-d", "--rm", "--name", container(sessionId), "--network", "none",
      "-v", `${STORAGE}:/data:ro`, "alpine:3.20", "sleep", "1d"], { env: { ...process.env, PATH: ENV_PATH } });
    const r = await send(A.provider, C.cs, ABI.ComputeService, "sessionReady", [sessionId]);
    plog(`Service running. Billing starts now (block ${r.block}).`, r);
    toSettle.add(railId);
  } catch (e) {
    plog(`Could not start session #${sessionId}: ${reason(e)}. Closing it.`);
    await stopContainer(sessionId);
    try { plog("Session closed.", await send(A.provider, C.cs, ABI.ComputeService, "closeSession", [sessionId])); } catch {}
  }
}
async function stopContainer(id) {
  try { await execFile("docker", ["rm", "-f", container(id)], { env: { ...process.env, PATH: ENV_PATH } }); } catch {}
}
async function onSessionReady({ sessionId }, block) {
  if (sessionInfo[sessionId]) sessionInfo[sessionId].startBlock = block;
}
async function onSessionClosed({ sessionId, closedBy, rateStoppedAtClose }, block) {
  const s = (sessionInfo[sessionId] ??= {});
  Object.assign(s, { stopBlock: block, stopped: rateStoppedAtClose, closedBy });
  await stopContainer(sessionId);
  if (s.startBlock === undefined) return;
  if (!rateStoppedAtClose) { // unfunded: the rail keeps paying the provider until its end epoch (S1)
    try { s.endEpoch = Number((await read(C.payments, ABI.FilecoinPayV1, "getRail", [s.railId])).endEpoch); } catch {}
  }
  plog(rateStoppedAtClose
    ? `Session #${sessionId} stopped at block ${block}: service shut down, payment stopped at the same epoch.`
    : `Session #${sessionId} ended without funds: I can collect up to the safety margin, then the payment ends.`);
}

// Every few seconds: collect what is owed (settle), and stop serving clients who ran out of funds.
async function providerTick(block) {
  for (const [id, s] of Object.entries(sessionInfo)) {
    if (s.startBlock === undefined || s.stopBlock !== undefined) continue;
    const [fundedUntil] = await read(C.payments, ABI.FilecoinPayV1, "getAccountInfoIfSettled", [C.usdfc, A.client]);
    if (fundedUntil < BigInt(block)) {
      plog(`Your balance ran out at epoch ${fundedUntil}. Stopping session #${id} (the safety margin covers me).`);
      try { await send(A.provider, C.cs, ABI.ComputeService, "closeSession", [BigInt(id)]).then((r) => plog("Session closed by the provider.", r)); }
      catch (e) { plog(`closeSession failed: ${reason(e)}`); }
    }
  }
  if (block % 5 !== 0) return;
  for (const railId of [...toSettle]) {
    try {
      const before = await read(C.payments, ABI.FilecoinPayV1, "accounts", [C.usdfc, A.provider]);
      const r = await send(A.provider, C.payments, ABI.FilecoinPayV1, "settleRail", [railId, BigInt(block)], "collect payment");
      const after = await read(C.payments, ABI.FilecoinPayV1, "accounts", [C.usdfc, A.provider]);
      collected[railId] = (collected[railId] ?? 0n) + (after[0] - before[0]);
      lastSettleTx[railId] = r;
    } catch { /* nothing to collect */ }
    let done = false;
    try { await read(C.payments, ABI.FilecoinPayV1, "getRail", [railId]); } catch { done = true; } // rail finalised
    if (collected[railId] > 0n && (done || block % 30 === 0)) {
      plog(`Collected ${fmt(collected[railId])} USDFC from payment rail #${railId} (settled in Filecoin Pay).`, lastSettleTx[railId]);
      collected[railId] = 0n;
    }
    if (done) toSettle.delete(railId);
  }
}

async function ask(sessionId, question) {
  const s = await read(C.cs, ABI.ComputeService, "sessions", [BigInt(sessionId)]);
  if (Number(s[7]) !== 2) throw new Error("this session is not running");
  const q = String(question).slice(0, 80);
  const { stdout } = await execFile("docker", ["exec", "-e", `Q=${q}`, container(sessionId), "sh", "-c",
    'grep -rin -- "$Q" /data | sed "s|^/data/||" | head -20'], { env: { ...process.env, PATH: ENV_PATH } }).catch((e) => ({ stdout: e.stdout ?? "" }));
  return stdout.trim() ? stdout.trim().split("\n") : [];
}

// ---------------------------------------------------------------- provider: jobs

const jobInfo = {}; // id -> { name, image, stage, output }
async function onJobPosted({ jobId, provider, imageDigest, inputPieceIds, price, deadline }) {
  if (provider !== A.provider) return;
  const image = IMAGE_BY_DIGEST[imageDigest];
  const spec = JOB_SCRIPTS[image];
  const name = Object.values(PARAMS.jobs).find((j) => j.image === image)?.name ?? image;
  jobInfo[jobId] = { name, image, stage: "received" };
  plog(`New job #${jobId}: "${name}" for ${fmt(price)} USDFC, deadline block ${deadline}.`);
  if (!spec) return plog(`I don't run ${image}; ignoring job #${jobId}.`);
  runJob(jobId, spec, inputPieceIds, deadline).catch((e) => plog(`Job #${jobId} failed: ${reason(e)}`));
}

async function runJob(jobId, spec, inputPieceIds, deadline) {
  const J = jobInfo[jobId];
  const dir = path.join(RUN, `job-${jobId}`);
  fs.mkdirSync(path.join(dir, "in"), { recursive: true });
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  for (const id of inputPieceIds) {
    const [name] = await read(C.pdp, ABI.MockPDP, "getPiece", [dataSetId, id]);
    if (spec.inputs(name)) fs.copyFileSync(path.join(STORAGE, name), path.join(dir, "in", name));
  }
  J.stage = "running";
  plog(`Job #${jobId}: running the program in a container on your files (no network, read-only inputs)…`);
  if (spec.slow) {
    while ((await pub.getBlockNumber()) <= deadline) await sleep(1000);
    J.stage = "late";
    return plog(`Job #${jobId}: I missed the deadline (block ${deadline}). I can no longer be paid; you can take your money back.`);
  }
  await sleep(3000); // let the demo show the "running" stage
  await execFile("docker", ["run", "--rm", "--network", "none", "-v", `${dir}/in:/in:ro`, "-v", `${dir}/out:/out`,
    "alpine:3.20", "sh", "-c", spec.script], { env: { ...process.env, PATH: ENV_PATH } });
  // store the output in the client's data set as a new piece (name made unique)
  let out = spec.output, k = 2;
  while (fs.existsSync(path.join(STORAGE, out))) out = spec.output.replace(/(\.[^.]+)$/, ` (${k++})$1`);
  fs.copyFileSync(path.join(dir, "out", spec.output), path.join(STORAGE, out));
  J.stage = "storing";
  const p = await addPiece(out, "output");
  J.output = { name: out, pieceId: Number(p.pieceId), cid: p.cid };
  plog(`Job #${jobId}: result "${out}" added to your data set as piece #${p.pieceId}.`, p);
  const r = await send(A.provider, C.cs, ABI.ComputeService, "commitOutputs", [jobId, [p.pieceId]]);
  J.stage = "paid";
  plog(`Job #${jobId}: result committed on-chain; Filecoin Pay released the price to me.`, r);
}

// ---------------------------------------------------------------- event loop

let lastBlock = 0n;
async function eventLoop() {
  for (;;) {
    try {
      const latest = await pub.getBlockNumber();
      if (latest > lastBlock) {
        const logs = await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, fromBlock: lastBlock + 1n, toBlock: latest });
        lastBlock = latest;
        for (const l of logs) {
          const b = Number(l.blockNumber);
          if (l.eventName === "SessionOpened") onSessionOpened(l.args);
          else if (l.eventName === "SessionReady") await onSessionReady(l.args, b);
          else if (l.eventName === "SessionClosed") await onSessionClosed(l.args, b);
          else if (l.eventName === "JobPosted") onJobPosted(l.args);
          else if (l.eventName === "JobExpired" && jobInfo[l.args.jobId]) jobInfo[l.args.jobId].stage = "refunded";
        }
        await providerTick(Number(latest));
      }
    } catch (e) { say("event loop:", reason(e)); }
    await sleep(700);
  }
}

// ---------------------------------------------------------------- client actions ("you")

function clog(what, results) {
  const t = Date.now();
  for (const [i, r] of results.entries()) clientLog.push({ t: t + i, text: r.what, fn: r.fn, tx: r.tx, block: r.block });
}
async function requireFree(amount, what) {
  const [, , available] = await read(C.payments, ABI.FilecoinPayV1, "getAccountInfoIfSettled", [C.usdfc, A.client]);
  if (available < amount) throw new Error(`Not enough free money in Filecoin Pay: ${fmt(available)} USDFC free, ${what} needs ${fmt(amount)}. Add money first.`);
}
const client = {
  // Move USDFC from your wallet into Filecoin Pay and let ComputeService act for you within limits.
  async setup({ amount }) {
    const amt = U(amount);
    const { rateAllowance, lockupAllowance, maxLockupPeriod } = PARAMS.approval;
    return [
      await send(A.client, C.usdfc, ABI.MockERC20, "approve", [C.payments, amt], `Allow Filecoin Pay to take ${amount} USDFC from your wallet`),
      await send(A.client, C.payments, ABI.FilecoinPayV1, "deposit", [C.usdfc, A.client, amt], `Deposit ${amount} USDFC into Filecoin Pay`),
      await send(A.client, C.payments, ABI.FilecoinPayV1, "setOperatorApproval",
        [C.usdfc, C.cs, true, rateAllowance, lockupAllowance, maxLockupPeriod],
        `Let the compute service open payments for you, up to ${fmt(rateAllowance)} USDFC/epoch and ${fmt(lockupAllowance)} USDFC on hold`),
    ];
  },
  async deposit({ amount }) {
    const amt = U(amount);
    return [
      await send(A.client, C.usdfc, ABI.MockERC20, "approve", [C.payments, amt], `Allow Filecoin Pay to take ${amount} USDFC`),
      await send(A.client, C.payments, ABI.FilecoinPayV1, "deposit", [C.usdfc, A.client, amt], `Deposit ${amount} USDFC into Filecoin Pay`),
    ];
  },
  async openSession() {
    const s = PARAMS.session;
    await requireFree(s.rate * s.lockupPeriod, "the safety margin");
    return [await send(A.client, C.cs, ABI.ComputeService, "openSession",
      [A.provider, digest(s.image), s.rate, s.lockupPeriod, dataSetId], `Start a session: ${s.name}`)];
  },
  async closeSession({ sessionId }) {
    return [await send(A.client, C.cs, ABI.ComputeService, "closeSession", [BigInt(sessionId)], `Stop session #${sessionId}`)];
  },
  async postJob({ job }) {
    const j = PARAMS.jobs[job];
    if (!j) throw new Error("unknown job");
    await requireFree(j.price, "this job");
    const spec = JOB_SCRIPTS[j.image];
    const inputs = (await listFiles()).filter((f) => f.live && f.kind === "input" && spec.inputs(f.name)).map((f) => BigInt(f.pieceId));
    const deadline = (await pub.getBlockNumber()) + j.deadline;
    return [await send(A.client, C.cs, ABI.ComputeService, "postJob",
      [A.provider, digest(j.image), dataSetId, inputs, j.price, deadline], `Order job: ${j.name}`)];
  },
  async expire({ jobId }) {
    return [await send(A.client, C.cs, ABI.ComputeService, "expire", [BigInt(jobId)], `Deadline passed: cancel job #${jobId} and release the money`)];
  },
  async withdraw({ amount }) {
    const [, , available] = await read(C.payments, ABI.FilecoinPayV1, "getAccountInfoIfSettled", [C.usdfc, A.client]);
    const amt = amount === "all" ? available : U(amount);
    return [await send(A.client, C.payments, ABI.FilecoinPayV1, "withdraw", [C.usdfc, amt], `Withdraw ${fmt(amt)} USDFC back to your wallet`)];
  },
};

// ---------------------------------------------------------------- state for the page

async function state() {
  const block = Number(await pub.getBlockNumber());
  const walletBal = await read(C.usdfc, ABI.MockERC20, "balanceOf", [A.client]);
  const [fundedUntil, funds, available] = await read(C.payments, ABI.FilecoinPayV1, "getAccountInfoIfSettled", [C.usdfc, A.client]);
  const prov = await read(C.payments, ABI.FilecoinPayV1, "accounts", [C.usdfc, A.provider]);
  const nS = Number(await read(C.cs, ABI.ComputeService, "nextSessionId"));
  const nJ = Number(await read(C.cs, ABI.ComputeService, "nextJobId"));
  const ST = ["none", "opening", "running", "closed"], JT = ["none", "waiting", "paid", "refunded"];
  const sessions = [];
  for (let i = 1; i < nS; i++) {
    const s = await read(C.cs, ABI.ComputeService, "sessions", [BigInt(i)]);
    const info = sessionInfo[i] ?? {};
    const end = info.endEpoch !== undefined ? Math.min(block, info.endEpoch) : (info.stopBlock ?? block);
    const used = info.startBlock === undefined ? 0n : s[3] * BigInt(Math.max(0, end - info.startBlock));
    sessions.push({ id: i, railId: Number(s[2]), rate: fmt(s[3]), lockupPeriod: Number(s[4]), status: ST[Number(s[7])],
      startBlock: info.startBlock ?? null, stopBlock: info.stopBlock ?? null, rateStopped: info.stopped ?? null,
      usedSoFar: fmt(used) });
  }
  const jobs = [];
  for (let i = 1; i < nJ; i++) {
    const j = await read(C.cs, ABI.ComputeService, "jobs", [BigInt(i)]);
    const info = jobInfo[i] ?? {};
    jobs.push({ id: i, railId: Number(j[2]), price: fmt(j[3]), deadline: Number(j[4]), status: JT[Number(j[8])],
      name: info.name, stage: info.stage, output: info.output ?? null });
  }
  return {
    block, epochSeconds: 1,
    contracts: C, accounts: A, dataSetId: Number(dataSetId),
    client: { wallet: fmt(walletBal), inFilecoinPay: fmt(funds), available: fmt(available), onHold: fmt(funds - available),
      fundedUntil: fundedUntil > 10n ** 30n ? null : Number(fundedUntil) },
    provider: { earned: fmt(prov[0]) },
    params: { rate: fmt(PARAMS.session.rate), lockupPeriod: Number(PARAMS.session.lockupPeriod),
      margin: fmt(PARAMS.session.rate * PARAMS.session.lockupPeriod),
      jobs: Object.fromEntries(Object.entries(PARAMS.jobs).map(([k, j]) => [k, { name: j.name, price: fmt(j.price), deadline: Number(j.deadline) }])) },
    sessions, jobs, files: await listFiles(), providerLog: providerLog.slice(-40), clientLog: clientLog.slice(-40),
  };
}

// ---------------------------------------------------------------- web server

function serve() {
  const app = path.join(HERE, "app");
  http.createServer(async (req, res) => {
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj, (k, v) => typeof v === "bigint" ? v.toString() : v)); };
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && url.pathname === "/api/state") return json(200, await state());
      if (req.method === "GET" && url.pathname.startsWith("/api/file/")) {
        const id = BigInt(url.pathname.split("/").pop());
        const [name] = await read(C.pdp, ABI.MockPDP, "getPiece", [dataSetId, id]);
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(fs.readFileSync(path.join(STORAGE, name)));
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        let body = ""; for await (const c of req) body += c;
        const args = body ? JSON.parse(body) : {};
        const action = url.pathname.slice(5);
        if (action === "ask") return json(200, { lines: await ask(args.sessionId, args.question) });
        if (!client[action]) return json(404, { error: "unknown action" });
        try {
          const results = await client[action](args);
          clog(action, results);
          return json(200, { ok: true, txs: results.map(({ receipt, ...r }) => r) });
        } catch (e) { return json(400, { ok: false, error: reason(e) }); }
      }
      const file = path.join(app, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
      if (file.startsWith(app) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(file)] ?? "application/octet-stream";
        res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
        return res.end(fs.readFileSync(file));
      }
      res.writeHead(404); res.end("not found");
    } catch (e) { json(500, { error: reason(e) }); }
  }).listen(WEB_PORT, "127.0.0.1");
}

// ---------------------------------------------------------------- main

async function main() {
  try { await execFile("docker", ["info"], { env: { ...process.env, PATH: ENV_PATH } }); }
  catch { throw new Error("Docker is not running. Open the Docker app, wait until it says 'running', then start again."); }
  const { stdout } = await execFile("docker", ["ps", "-aq", "--filter", "name=focs-session-"], { env: { ...process.env, PATH: ENV_PATH } });
  for (const id of stdout.split("\n").filter(Boolean)) await execFile("docker", ["rm", "-f", id], { env: { ...process.env, PATH: ENV_PATH } });

  say("Starting the local blockchain…");
  await startChain();
  await installContracts();
  const r = await createDataSet();
  plog(`I hold your data set #${dataSetId} (${(await listFiles()).length} files, proven with PDP — simulated locally).`, r);
  lastBlock = await pub.getBlockNumber();
  eventLoop();
  serve();
  say(`Ready. Open http://localhost:${WEB_PORT}  (Ctrl+C to stop)`);
  if (process.argv.includes("--open")) spawn("open", [`http://localhost:${WEB_PORT}`]);
}
process.on("SIGINT", async () => {
  for (const id of Object.keys(sessionInfo)) await stopContainer(id);
  process.exit(0);
});
main().catch((e) => { console.error("\nCould not start:", reason(e)); process.exit(1); });
