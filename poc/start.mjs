// FOC Compute — proof of concept.
//
//   node start.mjs              local mode: a private chain on this Mac (anvil, 1 epoch = 1 s), with the FOC
//                               contracts at the versions deployed on calibnet and mainnet (see foc.mjs),
//                               a test token luca_usdfc and ComputeService. The client is a built-in test wallet.
//   node start.mjs --calibnet   calibnet mode: FilOz's contracts on the Filecoin Calibration test network
//                               (1 epoch = 30 s), our ComputeService deployed there, USDFC test token.
//                               The client is the visitor's MetaMask; the provider signs with its own key
//                               (~/.foc-compute-poc/calibnet/provider.key, never printed).
//   calibnet setup (one time):  --new-provider-key   create the provider key, print its address only
//                               --new-demo-client-key  create the demo client's key (visitors without MetaMask)
//                               --register           register the provider in FilOz's registry (5 tFIL fee)
//                               --deploy             deploy ComputeService, write poc/calibnet.json
//
// The program plays the storage provider: holds the client's data set (a real FWSS data set), starts services
// and runs jobs in containers (Docker) next to the files, adds job outputs to the client's data set through
// ComputeService's authorizer, and gets paid through Filecoin Pay. It also serves the page on
// http://localhost:8080. In both modes every client action (deposit, approvals, sessions, jobs) is a
// transaction the page sends from the client's wallet.

import { spawn, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, http as rpc, fallback, parseUnits, formatUnits, keccak256, toHex, BaseError, getAddress,
  verifyMessage, hexToString,
} from "viem";
import { foundry, filecoinCalibration } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as FOC from "./foc.mjs";

const execFile = promisify(execFileCb);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.join(HERE, "..", "contracts");
const ENV_PATH = `${process.env.PATH}:${process.env.HOME}/.foundry/bin:/usr/local/bin:/opt/homebrew/bin`;
const XENV = { env: { ...process.env, PATH: ENV_PATH } };
const WEB_PORT = 8080;
const RPC_PORT = 8545;
const ZERO = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------- network

const NETWORK = process.argv.includes("--calibnet") ? "calibnet" : "local";
const CAL = NETWORK === "calibnet";
// Working files live outside ~/Documents: macOS asks for extra permission before Docker can read Documents.
const RUN = path.join(process.env.HOME, ".foc-compute-poc", NETWORK);
const STORAGE = path.join(RUN, "storage"); // the provider's copies of its clients' data sets, one folder per client
const clientDir = (client) => { const d = path.join(STORAGE, getAddress(client)); fs.mkdirSync(d, { recursive: true }); return d; };
const STATE_FILE = path.join(RUN, "state.json"); // calibnet: survives restarts
const KEY_FILE = path.join(RUN, "provider.key"); // calibnet: provider key, owner-readable only
const DEMO_KEY_FILE = path.join(RUN, "demo-client.key"); // calibnet: demo client key (test tokens only), owner-readable only
const DEPLOY_FILE = path.join(HERE, "calibnet.json"); // calibnet: our ComputeService address (public)

// FilOz's calibnet deployment (filecoin-services @ 4cbbea4, service_contracts/deployments.json, key 314159;
// checked on-chain 2026-09-18) and USDFC on calibnet.
const CALIBNET = {
  usdfc: "0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0",
  payments: "0x09a0fDc2723fAd1A7b8e3e00eE5DF73841df55a0",
  pdp: "0x85e366Cf9DD2c0aE37E963d9556F5f4718d6417C",
  registry: "0x839e5c9988e4e9977d40708d0094103c0839Ac9D",
  sessionKeys: "0x518411c2062E119Aaf7A8B12A2eDf9a939347655",
  fwss: "0x02925630df557F957f70E112bA06e50965417CA0",
  view: "0x1B68d64f01bAa42014B9774605867BF4eDC0320f",
};

const U = (x) => parseUnits(String(x), 18); // both tokens have 18 decimals
const fmt = (x) => Number(formatUnits(x, 18)).toFixed(4);

const NET = CAL
  ? {
    chain: filecoinCalibration, rpc: "https://api.calibration.node.glif.io/rpc/v1",
    rpcBackup: "https://rpc.ankr.com/filecoin_testnet", epochSeconds: 30, token: "USDFC",
    explorer: "https://filecoin-testnet.blockscout.com/tx/", poll: 5000, settleEvery: 4,
    session: { rate: U("0.01"), lockupPeriod: 10n }, // 0.01 per 30 s; margin = 10 epochs (5 min)
    deadlines: { index: 20n, sales: 20n, late: 4n },
    approval: { rateAllowance: U("0.1"), lockupAllowance: U(3), maxLockupPeriod: 600n },
    storage: { deposit: U(1), rate: U("0.1"), lockup: U(2) },
  }
  : {
    chain: foundry, rpc: `http://127.0.0.1:${RPC_PORT}`, epochSeconds: 1, token: "luca_usdfc",
    explorer: null, poll: 700, settleEvery: 5,
    session: { rate: U("0.001"), lockupPeriod: 60n },
    deadlines: { index: 120n, sales: 120n, late: 15n },
    approval: { rateAllowance: U("0.01"), lockupAllowance: U(3), maxLockupPeriod: 600n },
    storage: { deposit: U(1), rate: U(1), lockup: U(1) },
  };

const PARAMS = {
  walletStart: U(5), // local only
  session: { name: "Search assistant over your files", image: "search:v1", ...NET.session,
    desc: "A small service the provider starts next to your files. While it runs you can ask it to search your files for a word; it answers with the matching lines. Think of it as a stand-in for an AI assistant over your documents: you pay for the time it runs, not per question." },
  jobs: {
    index: { name: "Build a search index of my files", image: "indexer:v1", price: U("0.5"), deadline: NET.deadlines.index,
      desc: "Reads your text files and builds an index: every word, and which files contain it.", reads: "your .txt files", writes: "search-index.txt" },
    sales: { name: "Summarise my sales table", image: "sales-report:v1", price: U("0.2"), deadline: NET.deadlines.sales,
      desc: "Reads your sales table and adds up customers and revenue per region, plus the total.", reads: "sales-2026.csv", writes: "sales-summary.txt" },
    pii: { name: "Find and remove personal data in my documents", image: "pii-redact:v1", price: U("0.5"), deadline: NET.deadlines.index,
      desc: "Scans your financial documents (loan agreements, KYC forms, invoices, trade confirmations) for personal and account data: names, addresses, dates of birth, emails, phone numbers, IBANs, bank codes, card numbers, tax and passport numbers, wallet addresses. Produces a report and a redacted copy of every document, for example to share with investors or auditors. Runs Microsoft Presidio on the provider's CPU; the documents never leave the provider.",
      reads: "your documents (.txt)", writes: "pii-report.txt and redacted-documents.txt" },
    late: { name: "Build a search index: see what happens if the provider misses the deadline", image: "indexer-slow:v1", price: U("0.5"), deadline: NET.deadlines.late,
      desc: "Same program as the search index, but the provider deliberately misses the deadline, to show what happens then: nobody is paid, and a \"Get my money back\" button appears.", reads: "your .txt files", writes: "nothing (late)" },
  },
  approval: NET.approval,
};
const digest = (image) => keccak256(toHex(image));
const IMAGE_BY_DIGEST = Object.fromEntries(
  [PARAMS.session.image, ...Object.values(PARAMS.jobs).map((j) => j.image)].map((i) => [digest(i), i]),
);

// Programs run inside the job containers (alpine Linux, no network, inputs read-only).
const JOB_SCRIPTS = {
  "indexer:v1": {
    output: "search-index.txt",
    inputs: (name) => name.endsWith(".txt") && !/^(search-index|sales-summary|pii-report|redacted-documents)/.test(name),
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
// input filters are also evaluated by the page, so they must be self-contained (no outside names)
// Jobs packaged as their own container image (built from poc/jobs/<name>): the image reads /in and writes /out.
JOB_SCRIPTS["pii-redact:v1"] = {
  dockerImage: "piecework/pii-redact:v1",
  outputs: ["pii-report.txt", "redacted-documents.txt"],
  inputs: (name) => name.endsWith(".txt") && !/^(search-index|sales-summary|pii-report|redacted-documents)/.test(name),
};

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
function reason(e) {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x?.data?.errorName);
    if (r?.data?.errorName) return `${r.data.errorName}${r.data.args?.length ? "(" + r.data.args.join(", ") + ")" : ""}`;
    return e.shortMessage;
  }
  return String(e?.message ?? e);
}
const queues = new Map(); // one transaction at a time per account (keeps nonces in order)
function serial(account, fn) {
  const key = typeof account === "string" ? account : account.address;
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  queues.set(key, next);
  return next;
}
const loadJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const saveState = () => CAL && fs.writeFileSync(STATE_FILE, JSON.stringify(ST, (k, v) => typeof v === "bigint" ? v.toString() : v, 2));

// ---------------------------------------------------------------- chain

let pub, wallet, C, providerAcct; // C: contract addresses
let demoAcct, demoWallet; // calibnet: the demo client wallet the page can use instead of MetaMask
const ABI = {};
const A = {}; // local: deployer, client; both: provider (address)
const withErrors = (abi) => { // the contract's ABI plus all our errors, so nested revert reasons decode
  const names = new Set(abi.filter((x) => x.type === "error").map((x) => x.name));
  return [...abi, ...Object.values(ABI).flat().filter((x) => x.type === "error" && !names.has(x.name) && names.add(x.name))];
};

async function send(account, address, abi, functionName, args = [], what = functionName, value) {
  return serial(account, async () => {
    // dry run first: if the contract would refuse, we get its reason instead of a failed transaction
    const { request } = await pub.simulateContract({ account, address, abi: withErrors(abi), functionName, args, value });
    // gas: estimates can be too low for nested Filecoin Pay calls; locally a fixed budget, on calibnet estimate × 1.5
    const gas = CAL ? (await pub.estimateContractGas({ account, address, abi, functionName, args, value })) * 3n / 2n : 15_000_000n;
    const hash = await wallet.writeContract({ ...request, abi, chain: NET.chain, gas });
    // the public node sometimes fails a request: keep asking for the receipt (the transaction is already sent)
    let rcpt;
    for (let attempt = 1; ; attempt++) {
      try { rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 }); break; }
      catch (e) { if (attempt >= 6) throw e; say(`receipt for ${functionName} not available yet (${reason(e)}), retrying…`); await sleep(5000); }
    }
    if (rcpt.status !== "success") throw new Error(`${what} reverted`);
    return { what, fn: functionName, tx: hash, block: Number(rcpt.blockNumber), receipt: rcpt };
  });
}
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

function localArtifact(name) {
  const j = JSON.parse(fs.readFileSync(path.join(CONTRACTS, "out", `${name}.sol`, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

async function startLocalChain() {
  try {
    await fetch(NET.rpc, { method: "POST" });
    throw new Error(`port ${RPC_PORT} is already in use — is the demo already running?`);
  } catch (e) { if (e.message.includes("already")) throw e; }
  const anvil = spawn("anvil", ["--block-time", "1", "--port", String(RPC_PORT), "--silent"], { ...XENV, stdio: "inherit" });
  process.on("exit", () => anvil.kill());
  pub = createPublicClient({ chain: foundry, transport: rpc(NET.rpc), pollingInterval: 500 });
  wallet = createWalletClient({ chain: foundry, transport: rpc(NET.rpc) });
  for (let i = 0; i < 50; i++) { try { await pub.getBlockNumber(); break; } catch { await sleep(200); } }
  const [deployer, client, provider] = (await wallet.getAddresses()).map((a) => getAddress(a));
  Object.assign(A, { deployer, client, provider });
  providerAcct = provider; // anvil unlocked account
  say("Compiling contracts…");
  await execFile("forge", ["build"], { ...XENV, cwd: CONTRACTS });
  await execFile("forge", ["build"], { ...XENV, cwd: path.join(HERE, "..", "integration") });
  const tok = localArtifact("MockERC20");
  ABI.ERC20 = tok.abi;
  const h = await wallet.deployContract({ account: deployer, abi: tok.abi, bytecode: tok.bytecode, chain: foundry,
    args: ["luca_usdfc (local test token standing in for USDFC)", "luca_usdfc"] });
  const usdfc = getAddress((await pub.waitForTransactionReceipt({ hash: h })).contractAddress);
  const foc = await FOC.deployLocal({ pub, wallet, chain: foundry, deployer, usdfc });
  C = foc.C;
  Object.assign(ABI, foc.ABI);
  await send(deployer, C.usdfc, ABI.ERC20, "mint", [client, PARAMS.walletStart + NET.storage.deposit]);
  say("Installed:", C);
}

async function connectCalibnet() {
  if (!fs.existsSync(KEY_FILE)) throw new Error(`No provider key yet. Run: node start.mjs --calibnet --new-provider-key`);
  providerAcct = privateKeyToAccount(fs.readFileSync(KEY_FILE, "utf8").trim()); // loaded in memory only, never printed
  A.provider = providerAcct.address;
  // two public nodes: if one fails a request, the other is used
  const T = () => fallback([rpc(NET.rpc), rpc(NET.rpcBackup)], { retryCount: 2 });
  pub = createPublicClient({ chain: filecoinCalibration, transport: T(), pollingInterval: 4000 });
  wallet = createWalletClient({ chain: filecoinCalibration, transport: T(), account: providerAcct });
  if (fs.existsSync(DEMO_KEY_FILE)) {
    demoAcct = privateKeyToAccount(fs.readFileSync(DEMO_KEY_FILE, "utf8").trim()); // in memory only, never printed
    demoWallet = createWalletClient({ chain: filecoinCalibration, transport: T(), account: demoAcct });
  }
  for (const n of FOC.NAMES) ABI[n] = FOC.artifact(n).abi;
  ABI.ERC20 = localArtifact("MockERC20").abi; // standard ERC-20 functions
  C = { ...CALIBNET, cs: loadJSON(DEPLOY_FILE, {}).computeService };
}

// ---------------------------------------------------------------- persistent provider state

// ST.clients[address] = { dataSetId, clientDataSetId, pieces: { id: {name, cid, kind} } }
let ST = { clients: {}, lastBlock: 0 };
let current = null; // local: the built-in test wallet (calibnet: each request names its client)
const LOCAL_CLIENT = () => current;
const dataSetTimes = []; // calibnet: when data sets were created (each costs the provider a FIL deposit)
const MAX_NEW_DATASETS_PER_HOUR = 5;
const cl = (addr = current) => (addr ? ST.clients[getAddress(addr)] : undefined);

const sampleFiles = () => fs.readdirSync(path.join(HERE, "data", "dataset")).filter((f) => !f.startsWith(".")).sort();

// Piece CIDs of the sample files: the client signs these to put its files in the data set.
async function samplePieces() {
  const out = [];
  for (const f of sampleFiles()) out.push({ name: f, ...(await FOC.pieceCid(fs.readFileSync(path.join(HERE, "data", "dataset", f)))) });
  return out;
}

// Provider submits createDataSet with the client's signature (FWSS checks it).
async function createDataSetFor(client, clientDataSetId, signature) {
  client = getAddress(client);
  const dataSetId = BigInt(await read(C.pdp, ABI.PDPVerifier, "getNextDataSetId"));
  const deposit = await read(C.pdp, ABI.PDPVerifier, "FIL_CLEANUP_DEPOSIT");
  const r = await send(providerAcct, C.pdp, ABI.PDPVerifier, "createDataSet",
    [C.fwss, FOC.createDataSetExtraData(client, BigInt(clientDataSetId), signature)], "create data set", deposit);
  ST.clients[client] = { dataSetId: Number(dataSetId), clientDataSetId: String(clientDataSetId), pieces: {}, createTx: r.tx };
  saveState();
  plog(`Created your data set #${dataSetId} on FWSS (signed by you).`, r);
  return { dataSetId: Number(dataSetId), ...r };
}

// Provider submits addPieces for the sample files with the client's signature (one signature for all).
async function addSampleFilesFor(client, nonce, signature) {
  const c = cl(client);
  const files = await samplePieces();
  const first = Number(await read(C.pdp, ABI.PDPVerifier, "getNextPieceId", [BigInt(c.dataSetId)]));
  const r = await send(providerAcct, C.pdp, ABI.PDPVerifier, "addPieces",
    [BigInt(c.dataSetId), ZERO, files.map((f) => ({ data: f.hex })), FOC.addPiecesExtraData(BigInt(nonce), signature)], "add your files");
  files.forEach((f, i) => {
    fs.copyFileSync(path.join(HERE, "data", "dataset", f.name), path.join(clientDir(client), f.name));
    c.pieces[first + i] = { name: f.name, cid: f.text, kind: "input", tx: r.tx };
  });
  saveState();
  plog(`Stored your ${files.length} files as pieces #${first}–#${first + files.length - 1} of data set #${c.dataSetId} (signed by you).`, r);
  return r;
}

// Local mode: the test wallet already stores its files here before the demo starts.
async function prepareLocalClient() {
  const client = A.client;
  const sign = { signTypedData: (args) => wallet.signTypedData({ account: client, ...args }) };
  await send(client, C.usdfc, ABI.ERC20, "approve", [C.payments, NET.storage.deposit]);
  await send(client, C.payments, ABI.FilecoinPayV1, "deposit", [C.usdfc, client, NET.storage.deposit]);
  await send(client, C.payments, ABI.FilecoinPayV1, "setOperatorApproval", [C.usdfc, C.fwss, true, NET.storage.rate, NET.storage.lockup, 1n << 40n]);
  await FOC.registerProvider({ pub, wallet, chain: foundry }, A.provider, C, ABI, `http://localhost:${WEB_PORT}`);
  const clientDataSetId = FOC.randomNonce();
  const sig = await FOC.signCreateDataSet(sign, { chainId: foundry.id, fwss: C.fwss, clientDataSetId, payee: A.provider });
  const r = await createDataSetFor(client, clientDataSetId, sig);
  const nonce = FOC.randomNonce();
  const files = await samplePieces();
  const sig2 = await FOC.signAddPieces(sign, { chainId: foundry.id, fwss: C.fwss, clientDataSetId, nonce, cids: files.map((f) => f.hex) });
  await addSampleFilesFor(client, nonce, sig2);
  // keep only a small buffer beyond the storage reserve (so the wallet shows exactly 5 and "money runs out" is quick)
  const [, , available] = await read(C.payments, ABI.FilecoinPayV1, "getAccountInfoIfSettled", [C.usdfc, client]);
  const extra = available - U("0.05");
  if (extra > 0n) {
    await send(client, C.payments, ABI.FilecoinPayV1, "withdraw", [C.usdfc, extra]);
    await send(client, C.usdfc, ABI.ERC20, "transfer", [A.deployer, extra]);
  }
  current = client;
  return r;
}

// Add a job output (a file in the provider's storage) to the client's data set, signed by the provider:
// FWSS accepts it only through ComputeService's authorizer, while the client has a job open with this provider.
async function addOutputPieces(client, names, jobId) {
  const c = cl(client);
  const cids = [];
  for (const n of names) cids.push(await FOC.pieceCid(fs.readFileSync(path.join(clientDir(client), n))));
  const nonce = FOC.randomNonce();
  const signer = CAL ? providerAcct : { signTypedData: (args) => wallet.signTypedData({ account: A.provider, ...args }) };
  const sig = await FOC.signAddPieces(signer, { chainId: NET.chain.id, fwss: C.fwss, clientDataSetId: BigInt(c.clientDataSetId), nonce, cids: cids.map((x) => x.hex) });
  const first = Number(await read(C.pdp, ABI.PDPVerifier, "getNextPieceId", [BigInt(c.dataSetId)]));
  const r = await send(providerAcct, C.pdp, ABI.PDPVerifier, "addPieces",
    [BigInt(c.dataSetId), ZERO, cids.map((x) => ({ data: x.hex })), FOC.addPiecesExtraData(nonce, sig)], `add ${names.join(", ")}`);
  const pieces = names.map((name, i) => {
    c.pieces[first + i] = { name, cid: cids[i].text, kind: "output", tx: r.tx, jobId: Number(jobId) };
    return { name, pieceId: first + i, cid: cids[i].text };
  });
  saveState();
  return { pieces, ...r };
}

async function listFiles(client = current) {
  const c = cl(client);
  if (!c) return [];
  const n = Number(await read(C.pdp, ABI.PDPVerifier, "getNextPieceId", [BigInt(c.dataSetId)]));
  const out = [];
  for (let i = 0; i < n; i++) {
    const live = await read(C.pdp, ABI.PDPVerifier, "pieceLive", [BigInt(c.dataSetId), BigInt(i)]);
    const p = c.pieces[i] ?? { name: `piece ${i}`, cid: "", kind: "input" };
    const f = path.join(clientDir(client), p.name);
    const size = fs.existsSync(f) ? fs.statSync(f).size : 0;
    out.push({ pieceId: i, name: p.name, cid: p.cid, live, size, kind: p.kind, tx: p.tx ?? null, jobId: p.jobId ?? null, jobLabel: p.jobLabel ?? null });
  }
  return out;
}

// ---------------------------------------------------------------- logs

const providerLog = [];
const clientLog = [];
function plog(text, tx) {
  providerLog.push({ t: Date.now(), text, tx: tx?.tx, fn: tx?.fn, block: tx?.block });
  say("[provider]", text, tx?.fn ? `→ ${tx.fn} ${tx.tx.slice(0, 10)}…` : "");
}

// ---------------------------------------------------------------- provider: sessions

const sessionInfo = {}; // id -> { client, railId, startBlock, stopBlock, stopped, endEpoch }
const toSettle = new Set();
const collected = {}, lastSettleTx = {};
const container = (id) => `focs-${NETWORK}-session-${id}`;

async function onSessionOpened({ sessionId, client, provider, railId, imageDigest }) {
  if (provider !== A.provider) return;
  sessionInfo[sessionId] = { client, railId };
  plog(`Session #${sessionId} requested (${IMAGE_BY_DIGEST[imageDigest] ?? "unknown program"}). Starting the service next to your data…`);
  try {
    await execFile("docker", ["run", "-d", "--rm", "--name", container(sessionId), "--network", "none",
      "-v", `${clientDir(client)}:/data:ro`, "alpine:3.20", "sleep", "1d"], XENV); // only this client's files
    const r = await send(providerAcct, C.cs, ABI.ComputeService, "sessionReady", [sessionId]);
    plog(`Service running. Billing starts now (block ${r.block}).`, r);
    toSettle.add(railId);
  } catch (e) {
    plog(`Could not start session #${sessionId}: ${reason(e)}. Closing it.`);
    await stopContainer(sessionId);
    try { plog("Session closed.", await send(providerAcct, C.cs, ABI.ComputeService, "closeSession", [sessionId])); } catch {}
  }
}
async function stopContainer(id) { try { await execFile("docker", ["rm", "-f", container(id)], XENV); } catch {} }
function onSessionReady({ sessionId }, block) { if (sessionInfo[sessionId]) sessionInfo[sessionId].startBlock = block; }
async function onSessionClosed({ sessionId, rateStoppedAtClose }, block) {
  const s = sessionInfo[sessionId];
  if (!s) return;
  Object.assign(s, { stopBlock: block, stopped: rateStoppedAtClose });
  await stopContainer(sessionId);
  if (s.startBlock === undefined) return;
  if (!rateStoppedAtClose) { // unfunded: the rail keeps paying the provider until its end epoch (S1)
    try { s.endEpoch = Number((await read(C.payments, ABI.FilecoinPayV1, "getRail", [s.railId])).endEpoch); } catch {}
  }
  plog(rateStoppedAtClose
    ? `Session #${sessionId} stopped at block ${block}: service shut down, payment stopped at the same epoch.`
    : `Session #${sessionId} ended without funds: I can collect up to the safety margin, then the payment ends.`);
}

// Each block: stop serving clients who ran out of funds. Every few blocks: collect what is owed (settle).
async function providerTick(block) {
  for (const [id, s] of Object.entries(sessionInfo)) {
    if (s.startBlock === undefined || s.stopBlock !== undefined) continue;
    const [fundedUntil] = await read(C.payments, ABI.FilecoinPayV1, "getAccountInfoIfSettled", [C.usdfc, s.client]);
    if (fundedUntil < BigInt(block)) {
      plog(`Your balance ran out at epoch ${fundedUntil}. Stopping session #${id} (the safety margin covers me).`);
      try { plog("Session closed by the provider.", await send(providerAcct, C.cs, ABI.ComputeService, "closeSession", [BigInt(id)])); }
      catch (e) { plog(`closeSession failed: ${reason(e)}`); }
    }
  }
  if (block % NET.settleEvery !== 0) return;
  for (const railId of [...toSettle]) {
    try {
      const before = await read(C.payments, ABI.FilecoinPayV1, "accounts", [C.usdfc, A.provider]);
      const r = await send(providerAcct, C.payments, ABI.FilecoinPayV1, "settleRail", [railId, BigInt(block)], "collect payment");
      const after = await read(C.payments, ABI.FilecoinPayV1, "accounts", [C.usdfc, A.provider]);
      collected[railId] = (collected[railId] ?? 0n) + (after[0] - before[0]);
      lastSettleTx[railId] = r;
    } catch { /* nothing to collect */ }
    let done = false;
    try { await read(C.payments, ABI.FilecoinPayV1, "getRail", [railId]); } catch { done = true; } // rail finalised
    if (collected[railId] > 0n && (done || block % (NET.settleEvery * 6) === 0)) {
      plog(`Collected ${fmt(collected[railId])} ${NET.token} from payment rail #${railId} (settled in Filecoin Pay).`, lastSettleTx[railId]);
      collected[railId] = 0n;
    }
    if (done) toSettle.delete(railId);
  }
}

// Session requests are served only to the session's client: the page signs, once per session, the message
// below with the client's wallet (a signature, no transaction); the provider checks it against the session's client.
export const accessMessage = (sessionId) => `PieceWork: access to session #${sessionId} on chain ${NET.chain.id}`;
async function ask(sessionId, question, signature) {
  const s = await read(C.cs, ABI.ComputeService, "sessions", [BigInt(sessionId)]);
  if (Number(s[7]) !== 2) throw new Error("this session is not running");
  const ok = signature && await verifyMessage({ address: s[0], message: accessMessage(sessionId), signature }).catch(() => false);
  if (!ok) throw new Error("not signed by this session's client");
  const q = String(question).slice(0, 80);
  const { stdout } = await execFile("docker", ["exec", "-e", `Q=${q}`, container(sessionId), "sh", "-c",
    'grep -rin -- "$Q" /data | sed "s|^/data/||" | head -20'], XENV).catch((e) => ({ stdout: e.stdout ?? "" }));
  return stdout.trim() ? stdout.trim().split("\n") : [];
}

// ---------------------------------------------------------------- provider: jobs

const jobInfo = {}; // id -> { client, name, image, stage, output }
function onJobPosted({ jobId, client, provider, imageDigest, inputPieceIds, price, deadline }) {
  if (provider !== A.provider) return;
  const image = IMAGE_BY_DIGEST[imageDigest];
  const spec = JOB_SCRIPTS[image];
  const name = Object.values(PARAMS.jobs).find((j) => j.image === image)?.name ?? image;
  jobInfo[jobId] = { client, name, image, stage: "received" };
  plog(`New job #${jobId}: "${name}" for ${fmt(price)} ${NET.token}, deadline block ${deadline}.`);
  if (!spec) return plog(`I don't run ${image}; ignoring job #${jobId}.`);
  runJob(jobId, client, spec, inputPieceIds, deadline).catch((e) => plog(`Job #${jobId} failed: ${reason(e)}`));
}

async function runJob(jobId, client, spec, inputPieceIds, deadline) {
  const J = jobInfo[jobId];
  const c = cl(client);
  if (!c) return plog(`Job #${jobId}: I don't hold a data set for this client.`);
  const dir = path.join(RUN, `job-${jobId}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "in"), { recursive: true });
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  for (const id of inputPieceIds) {
    const name = c.pieces[Number(id)]?.name;
    if (name && spec.inputs(name)) fs.copyFileSync(path.join(clientDir(client), name), path.join(dir, "in", name));
  }
  J.stage = "running";
  plog(`Job #${jobId}: running the program in a container on your files (no network, read-only inputs)…`);
  if (spec.slow) {
    while ((await pub.getBlockNumber()) <= deadline) await sleep(NET.poll);
    J.stage = "late";
    return plog(`Job #${jobId}: I missed the deadline (block ${deadline}). I can no longer be paid; you can take your money back.`);
  }
  await sleep(3000); // let the demo show the "running" stage
  const t0 = Date.now();
  if (spec.dockerImage) await execFile("docker", ["run", "--rm", "--network", "none", "-v", `${dir}/in:/in:ro`, "-v", `${dir}/out:/out`, spec.dockerImage], XENV);
  else await execFile("docker", ["run", "--rm", "--network", "none", "-v", `${dir}/in:/in:ro`, "-v", `${dir}/out:/out`,
    "alpine:3.20", "sh", "-c", spec.script], XENV);
  plog(`Job #${jobId}: the program finished in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
  const names = [];
  for (const o of spec.outputs ?? [spec.output]) { // unique names in the data set
    let out = o, k = 2;
    while (fs.existsSync(path.join(clientDir(client), out))) out = o.replace(/(\.[^.]+)$/, ` (${k++})$1`);
    fs.copyFileSync(path.join(dir, "out", o), path.join(clientDir(client), out));
    names.push(out);
  }
  J.stage = "storing";
  let p;
  try { p = await addOutputPieces(client, names, jobId); }
  catch (e) {
    J.stage = "blocked";
    return plog(`Job #${jobId}: FWSS refused to add the result to your data set (${reason(e)}). Did you let providers deliver results into your data set? (step 1)`);
  }
  J.outputs = p.pieces;
  plog(`Job #${jobId}: ${names.length > 1 ? `results ${names.map((n) => `"${n}"`).join(" and ")}` : `result "${names[0]}"`} added to your data set as piece${names.length > 1 ? "s" : ""} #${p.pieces.map((x) => x.pieceId).join(", #")}.`, p);
  J.stage = "committing";
  const r = await send(providerAcct, C.cs, ABI.ComputeService, "commitOutputs", [jobId, p.pieces.map((x) => BigInt(x.pieceId))]);
  J.stage = "paid";
  plog(`Job #${jobId}: result committed on-chain; Filecoin Pay released the price to me.`, r);
}

// ---------------------------------------------------------------- recovery after a restart (calibnet)

// The chain is the source of truth: rebuild running sessions (restart their containers, keep settling)
// and open jobs (so the page shows them and the client can get a refund) from ComputeService's state.
async function recoverFromChain() {
  const latest = await pub.getBlockNumber();
  const readyBlock = async (id) => { // SessionReady carries the epoch billing started
    for (let to = latest; to > latest - 20000n && to > 0n; to -= 2000n) {
      const logs = await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, eventName: "SessionReady",
        args: { sessionId: BigInt(id) }, fromBlock: to - 1999n, toBlock: to }).catch(() => []);
      if (logs.length) return Number(logs[0].args.epoch);
    }
    return undefined;
  };
  const nS = Number(await read(C.cs, ABI.ComputeService, "nextSessionId"));
  for (let id = 1; id < nS; id++) {
    const s = await read(C.cs, ABI.ComputeService, "sessions", [BigInt(id)]);
    if (getAddress(s[1]) !== A.provider || Number(s[7]) !== 2) continue; // only running sessions of this provider
    sessionInfo[id] = { client: s[0], railId: s[2], startBlock: await readyBlock(id) };
    await execFile("docker", ["run", "-d", "--rm", "--name", container(id), "--network", "none",
      "-v", `${clientDir(s[0])}:/data:ro`, "alpine:3.20", "sleep", "1d"], XENV).catch(() => {});
    toSettle.add(s[2]);
    plog(`Recovered running session #${id} after a restart; service restarted, billing continues until the client stops.`);
  }
  const nJ = Number(await read(C.cs, ABI.ComputeService, "nextJobId"));
  for (let id = 1; id < nJ; id++) {
    const j = await read(C.cs, ABI.ComputeService, "jobs", [BigInt(id)]);
    if (getAddress(j[1]) !== A.provider) continue;
    const image = IMAGE_BY_DIGEST[j[6]];
    const name = Object.values(PARAMS.jobs).find((x) => x.image === image)?.name ?? image;
    const outs = Object.entries(cl(j[0])?.pieces ?? {}).filter(([, p]) => p.jobId === id && !/first contract/.test(p.jobLabel ?? ""));
    const stage = { 1: "received", 2: "paid", 3: "refunded" }[Number(j[8])];
    jobInfo[id] = { client: j[0], name, image, stage, outputs: outs.map(([pid, p]) => ({ name: p.name, pieceId: Number(pid), cid: p.cid })) };
  }
}

// ---------------------------------------------------------------- event loop

let lastBlock = 0n;
async function eventLoop() {
  for (;;) {
    try {
      const latest = await pub.getBlockNumber();
      if (latest > lastBlock && C.cs) {
        const logs = await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, fromBlock: lastBlock + 1n, toBlock: latest });
        lastBlock = latest;
        for (const l of logs) {
          const b = Number(l.blockNumber);
          if (l.eventName === "SessionOpened") onSessionOpened(l.args);
          else if (l.eventName === "SessionReady") onSessionReady(l.args, b);
          else if (l.eventName === "SessionClosed") await onSessionClosed(l.args, b);
          else if (l.eventName === "JobPosted") onJobPosted(l.args);
          else if (l.eventName === "JobExpired" && jobInfo[l.args.jobId]) jobInfo[l.args.jobId].stage = "refunded";
        }
        await providerTick(Number(latest));
      }
    } catch (e) { say("event loop:", reason(e)); }
    await sleep(NET.poll);
  }
}

// ---------------------------------------------------------------- state for the page

async function state(who) {
  if (CAL && who) { try { who = getAddress(who); } catch { who = null; } }
  const current = CAL ? who : LOCAL_CLIENT(); // calibnet: each visitor sees its own wallet
  const block = Number(await pub.getBlockNumber());
  const out = {
    network: NETWORK, block, epochSeconds: NET.epochSeconds, token: NET.token, explorer: NET.explorer,
    contracts: C, provider: A.provider, client: null, dataSetId: null, sessions: [], jobs: [], files: [],
    providerLog: providerLog.slice(-40), clientLog: clientLog.slice(-40),
    params: { rate: fmt(PARAMS.session.rate), lockupPeriod: Number(PARAMS.session.lockupPeriod),
      margin: fmt(PARAMS.session.rate * PARAMS.session.lockupPeriod),
      jobs: Object.fromEntries(Object.entries(PARAMS.jobs).map(([k, j]) => [k, { name: j.name, price: fmt(j.price), deadline: Number(j.deadline) }])) },
  };
  const prov = await read(C.payments, ABI.FilecoinPayV1, "accounts", [C.usdfc, A.provider]);
  out.providerEarned = fmt(prov[0]);
  if (!current) return out;
  const walletBal = await read(C.usdfc, ABI.ERC20, "balanceOf", [current]);
  const [fundedUntil, funds, available] = await read(C.payments, ABI.FilecoinPayV1, "getAccountInfoIfSettled", [C.usdfc, current]);
  const approval = await read(C.payments, ABI.FilecoinPayV1, "operatorApprovals", [C.usdfc, current, C.fwss]);
  const csApproval = C.cs ? await read(C.payments, ABI.FilecoinPayV1, "operatorApprovals", [C.usdfc, current, C.cs]) : [false];
  out.client = { address: current, wallet: fmt(walletBal), inFilecoinPay: fmt(funds), available: fmt(available),
    onHold: fmt(funds - available), fundedUntil: fundedUntil > 10n ** 30n ? null : Number(fundedUntil),
    storageApproved: approval[0], computeApproved: csApproval[0], fil: fmt(await pub.getBalance({ address: current })) };
  const c = cl(current);
  out.dataSetId = c ? c.dataSetId : null;
  out.dataSetTx = c?.createTx ?? null;
  out.hasFiles = c ? Object.keys(c.pieces).length > 0 : false;
  if (c) out.authorizerSet = getAddress(await read(C.view, ABI.FilecoinWarmStorageServiceStateView, "getDataSetAuthorizer", [BigInt(c.dataSetId)]).catch(() => ZERO)) === C.cs;
  out.files = await listFiles(current);
  if (!C.cs) return out;
  const S = ["none", "opening", "running", "closed"], J = ["none", "waiting", "paid", "refunded"];
  for (const [id, info] of Object.entries(sessionInfo)) {
    if (getAddress(info.client) !== getAddress(current)) continue;
    const s = await read(C.cs, ABI.ComputeService, "sessions", [BigInt(id)]);
    const end = info.endEpoch !== undefined ? Math.min(block, info.endEpoch) : (info.stopBlock ?? block);
    const used = info.startBlock === undefined ? 0n : s[3] * BigInt(Math.max(0, end - info.startBlock));
    // closed on-chain but not yet processed by the provider: report "stopping" rather than guess how it ended
    const status = S[Number(s[7])] === "closed" && info.stopBlock === undefined ? "stopping" : S[Number(s[7])];
    out.sessions.push({ id: Number(id), railId: Number(s[2]), rate: fmt(s[3]), lockupPeriod: Number(s[4]), status,
      startBlock: info.startBlock ?? null, stopBlock: info.stopBlock ?? null, rateStopped: info.stopped ?? null, usedSoFar: fmt(used) });
  }
  for (const [id, info] of Object.entries(jobInfo)) {
    if (getAddress(info.client) !== getAddress(current)) continue;
    const j = await read(C.cs, ABI.ComputeService, "jobs", [BigInt(id)]);
    out.jobs.push({ id: Number(id), railId: Number(j[2]), price: fmt(j[3]), deadline: Number(j[4]), status: J[Number(j[8])],
      name: info.name, stage: info.stage, outputs: info.outputs ?? [] });
  }
  return out;
}

// PDP proving period and challenge window, as set in FWSS on this network (getPDPConfig)
let PDP_CONFIG = null;
async function pdpConfig() {
  if (!PDP_CONFIG) {
    const r = await read(C.view, ABI.FilecoinWarmStorageServiceStateView, "getPDPConfig").catch(() => null);
    if (r) PDP_CONFIG = { maxProvingPeriod: Number(r[0]), challengeWindowSize: Number(r[1]) };
  }
  return PDP_CONFIG ?? { maxProvingPeriod: 240, challengeWindowSize: 20 };
}

// What the page needs to send transactions from the client's wallet.
async function config() {
  const pick = (abi, names) => abi.filter((x) => x.type === "error" || names.includes(x.name));
  return {
    network: NETWORK, chainId: NET.chain.id, chainName: NET.chain.name, rpc: NET.rpc, rpcBackup: NET.rpcBackup ?? null, explorer: NET.explorer,
    epochSeconds: NET.epochSeconds, token: NET.token, contracts: C, provider: A.provider,
    localClient: CAL ? null : A.client,
    accessMessage: accessMessage("{id}"),
    demoClient: demoAcct?.address ?? null,
    pdp: await pdpConfig(),
    params: {
      session: { image: digest(PARAMS.session.image), name: PARAMS.session.name, desc: PARAMS.session.desc, rate: PARAMS.session.rate.toString(), lockupPeriod: PARAMS.session.lockupPeriod.toString() },
      jobs: Object.fromEntries(Object.entries(PARAMS.jobs).map(([k, j]) => [k, { name: j.name, desc: j.desc, reads: j.reads, writes: j.writes, image: digest(j.image), price: j.price.toString(), deadline: j.deadline.toString(), inputs: JOB_SCRIPTS[j.image].inputs.toString() }])),
      approval: Object.fromEntries(Object.entries(PARAMS.approval).map(([k, v]) => [k, v.toString()])),
      storage: Object.fromEntries(Object.entries(NET.storage).map(([k, v]) => [k, v.toString()])),
    },
    abi: {
      erc20: pick(ABI.ERC20, ["approve", "balanceOf", "allowance"]),
      payments: pick(ABI.FilecoinPayV1, ["deposit", "withdraw", "setOperatorApproval", "getAccountInfoIfSettled"]),
      fwss: pick(ABI.FilecoinWarmStorageService, ["setDataSetAuthorizer"]),
      cs: ABI.ComputeService,
    },
  };
}

// ---------------------------------------------------------------- web server

function serve() {
  const app = path.join(HERE, "app");
  http.createServer(async (req, res) => {
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj, (k, v) => typeof v === "bigint" ? v.toString() : v)); };
    try {
      const url = new URL(req.url, "http://x");
      // health check for the stable link's "is the demo up?" test (github.io origin, so CORS is open here)
      if (req.method === "GET" && url.pathname === "/api/ping") { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); return res.end('{"ok":true}'); }
      if (req.method === "GET" && url.pathname === "/api/config") return json(200, await config());
      if (req.method === "GET" && url.pathname === "/api/state") return json(200, await state(url.searchParams.get("client")));
      if (req.method === "GET" && url.pathname === "/api/sample-pieces") return json(200, (await samplePieces()).map(({ name, hex, text }) => ({ name, hex, text })));
      if (req.method === "GET" && url.pathname.startsWith("/api/file/")) {
        const owner = CAL ? url.searchParams.get("client") : current;
        const name = owner ? cl(owner)?.pieces[Number(url.pathname.split("/").pop())]?.name : undefined;
        if (!name || !fs.existsSync(path.join(clientDir(owner), name))) { res.writeHead(404); return res.end("unknown piece"); }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(fs.readFileSync(path.join(clientDir(owner), name)));
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        let body = ""; for await (const ch of req) body += ch;
        const a = body ? JSON.parse(body) : {};
        const action = url.pathname.slice(5);
        try {
          if (action === "connect") { // the page tells which wallet is the client
            if (!CAL) return json(200, { ok: true });
            current = getAddress(a.client);
            return json(200, { ok: true, dataSetId: cl()?.dataSetId ?? null, clientDataSetId: cl()?.clientDataSetId ?? null });
          }
          if (action === "wallet") return json(200, { result: await demoWalletRequest(a.method, a.params) });
          if (action === "clientlog") { clientLog.push({ t: Date.now(), text: a.what, fn: a.fn, tx: a.tx, block: a.block }); return json(200, { ok: true }); }
          if (action === "ask") return json(200, { lines: await ask(a.sessionId, a.question, a.signature) });
          if (action === "dataset/create") {
            if (cl(a.client)) throw new Error("this wallet already has a data set with this provider");
            const now = Date.now();
            while (dataSetTimes.length && now - dataSetTimes[0] > 3600_000) dataSetTimes.shift();
            if (dataSetTimes.length >= MAX_NEW_DATASETS_PER_HOUR) throw new Error("Too many new data sets in the last hour; try again later.");
            dataSetTimes.push(now);
          }
          if (action === "dataset/create") return json(200, { ok: true, ...(await createDataSetFor(a.client, a.clientDataSetId, a.signature)) });
          if (action === "dataset/add" && Object.keys(cl(a.client)?.pieces ?? {}).length) throw new Error("your files are already stored");
          if (action === "dataset/add") return json(200, { ok: true, ...(await addSampleFilesFor(a.client, a.nonce, a.signature)) });
          return json(404, { error: "unknown action" });
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

// ---------------------------------------------------------------- demo client wallet (calibnet)

// The page's demo wallet forwards the two signing requests here; everything else goes straight to the RPC.
// uint fields arrive as strings in JSON typed data: turn them back into integers before signing.
function coerce(types, type, value) {
  if (type.endsWith("[]")) return value.map((v) => coerce(types, type.slice(0, -2), v));
  if (types[type]) return Object.fromEntries(types[type].map((f) => [f.name, coerce(types, f.type, value[f.name])]));
  if (/^u?int\d*$/.test(type)) return BigInt(value);
  return value;
}
async function demoWalletRequest(method, params) {
  if (!demoAcct) throw new Error("no demo wallet on this server");
  if (method === "eth_sendTransaction") {
    const t = params[0];
    if (getAddress(t.from) !== demoAcct.address) throw new Error("wrong sender");
    // the demo wallet only talks to the demo's contracts
    const allowed = [C.usdfc, C.payments, C.fwss, C.cs].map((x) => getAddress(x));
    if (!t.to || !allowed.includes(getAddress(t.to))) throw new Error("the demo wallet only sends to the demo's contracts");
    if (t.value && BigInt(t.value) > 0n) throw new Error("the demo wallet does not send FIL");
    return serial(demoAcct, () => demoWallet.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : 0n,
      gas: t.gas ? BigInt(t.gas) : undefined, chain: filecoinCalibration }));
  }
  if (method === "eth_signTypedData_v4") {
    const { domain, types, primaryType, message } = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
    const { EIP712Domain, ...rest } = types;
    if (getAddress(domain.verifyingContract) !== getAddress(C.fwss) || !["CreateDataSet", "AddPieces"].includes(primaryType))
      throw new Error("the demo wallet only signs FWSS data set requests");
    return demoAcct.signTypedData({ domain: { ...domain, chainId: Number(domain.chainId) }, types: rest, primaryType, message: coerce(rest, primaryType, message) });
  }
  if (method === "personal_sign") {
    const text = params[0].startsWith("0x") ? hexToString(params[0]) : params[0];
    if (!/^PieceWork: access to session #\d+ on chain \d+$/.test(text)) throw new Error("the demo wallet only signs session access");
    return demoAcct.signMessage({ message: text });
  }
  throw new Error(`unsupported wallet method ${method}`);
}

// ---------------------------------------------------------------- calibnet one-time setup commands

async function calibnetCommand() {
  fs.mkdirSync(RUN, { recursive: true });
  if (process.argv.includes("--new-provider-key")) {
    if (fs.existsSync(KEY_FILE)) return say("A provider key already exists. Address:", privateKeyToAccount(fs.readFileSync(KEY_FILE, "utf8").trim()).address);
    fs.writeFileSync(KEY_FILE, generatePrivateKey(), { mode: 0o600 });
    return say("Provider key created (kept in", KEY_FILE, "— never shown). Provider address:", privateKeyToAccount(fs.readFileSync(KEY_FILE, "utf8").trim()).address);
  }
  if (process.argv.includes("--new-demo-client-key")) {
    if (!fs.existsSync(DEMO_KEY_FILE)) fs.writeFileSync(DEMO_KEY_FILE, generatePrivateKey(), { mode: 0o600 });
    return say("Demo client key ready (kept in", DEMO_KEY_FILE, "— never shown). Demo client address:", privateKeyToAccount(fs.readFileSync(DEMO_KEY_FILE, "utf8").trim()).address);
  }
  await connectCalibnet();
  say("Provider", A.provider, "balance", fmt(await pub.getBalance({ address: A.provider })), "tFIL");
  if (process.argv.includes("--register")) {
    const r = await FOC.registerProvider({ pub, wallet, chain: filecoinCalibration }, providerAcct, C, ABI, "https://github.com/lucaniz/foc-compute");
    return say("Registered. Provider id:", r.providerId.toString(), r.receipt ? `tx ${r.receipt.transactionHash}` : "(was already registered)");
  }
  if (process.argv.includes("--deploy")) {
    const a = FOC.artifact("ComputeService");
    const args = [C.payments, C.usdfc, C.pdp, C.sessionKeys, C.view];
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args, chain: filecoinCalibration });
    say("Deploy transaction sent:", hash, "— waiting for confirmation (about a minute)…");
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
    const computeService = getAddress(r.contractAddress);
    fs.writeFileSync(DEPLOY_FILE, JSON.stringify({ network: "calibnet", chainId: 314159, computeService, tx: hash,
      block: Number(r.blockNumber), constructorArgs: args, deployedAt: new Date().toISOString() }, null, 2) + "\n");
    return say("ComputeService deployed at", computeService, "(written to poc/calibnet.json)");
  }
  if (process.argv.includes("--add-demo-files")) { // new sample files into the demo client's existing data set
    ST = loadJSON(STATE_FILE, ST);
    const client = demoAcct.address, c = cl(client);
    const have = new Set(Object.values(c.pieces).map((p) => p.name));
    const missing = (await samplePieces()).filter((f) => !have.has(f.name));
    if (!missing.length) return say("The demo data set already has every sample file.");
    const nonce = FOC.randomNonce();
    const sig = await FOC.signAddPieces(demoAcct, { chainId: NET.chain.id, fwss: C.fwss, clientDataSetId: BigInt(c.clientDataSetId), nonce, cids: missing.map((f) => f.hex) });
    const first = Number(await read(C.pdp, ABI.PDPVerifier, "getNextPieceId", [BigInt(c.dataSetId)]));
    const r = await send(providerAcct, C.pdp, ABI.PDPVerifier, "addPieces",
      [BigInt(c.dataSetId), ZERO, missing.map((f) => ({ data: f.hex })), FOC.addPiecesExtraData(BigInt(nonce), sig)], "add demo files");
    missing.forEach((f, i) => {
      fs.copyFileSync(path.join(HERE, "data", "dataset", f.name), path.join(clientDir(client), f.name));
      c.pieces[first + i] = { name: f.name, cid: f.text, kind: "input", tx: r.tx };
    });
    saveState();
    return say(`Added ${missing.length} files to data set #${c.dataSetId} as pieces #${first}–#${first + missing.length - 1}, tx ${r.tx}`);
  }
  return false;
}

// ---------------------------------------------------------------- main

async function main() {
  const setup = ["--new-provider-key", "--new-demo-client-key", "--register", "--deploy", "--add-demo-files"].some((f) => process.argv.includes(f));
  if (CAL && setup) { await calibnetCommand(); process.exit(0); }

  try { await execFile("docker", ["info"], XENV); }
  catch { throw new Error("Docker is not running. Open the Docker app, wait until it says 'running', then start again."); }
  const { stdout } = await execFile("docker", ["ps", "-aq", "--filter", `name=focs-${NETWORK}-session-`], XENV);
  for (const id of stdout.split("\n").filter(Boolean)) await execFile("docker", ["rm", "-f", id], XENV);

  if (CAL) {
    fs.mkdirSync(STORAGE, { recursive: true });
    await connectCalibnet();
    if (!C.cs) throw new Error("ComputeService is not deployed on calibnet yet. Run: node start.mjs --calibnet --deploy");
    ST = loadJSON(STATE_FILE, ST);
    for (const [addr, c] of Object.entries(ST.clients)) // move files from the old shared folder into the client's own
      for (const p of Object.values(c.pieces)) {
        const old = path.join(STORAGE, p.name);
        if (fs.existsSync(old) && fs.statSync(old).isFile() && !fs.existsSync(path.join(clientDir(addr), p.name))) fs.renameSync(old, path.join(clientDir(addr), p.name));
      }
    const registered = await read(C.registry, ABI.ServiceProviderRegistry, "getProviderIdByAddress", [A.provider]);
    if (registered === 0n) throw new Error("The provider is not registered yet. Run: node start.mjs --calibnet --register");
    plog(`Provider ${A.provider} on calibnet (registry id ${registered}). Proofs of possession: not run yet (I do not run a prover).`);
  } else {
    fs.rmSync(RUN, { recursive: true, force: true });
    fs.mkdirSync(STORAGE, { recursive: true });
    say("Starting the local blockchain…");
    await startLocalChain();
    const r = await prepareLocalClient();
    plog(`I hold your data set #${cl().dataSetId} on FWSS (${(await listFiles()).length} files; storage paid through Filecoin Pay; proofs of possession not run yet: I do not run a prover).`, r);
  }
  if (CAL) await recoverFromChain();
  lastBlock = await pub.getBlockNumber();
  eventLoop();
  serve();
  say(`Ready (${NETWORK}). Open http://localhost:${WEB_PORT}  (Ctrl+C to stop)`);
  if (process.argv.includes("--open")) spawn("open", [`http://localhost:${WEB_PORT}`]);
}
process.on("SIGINT", async () => {
  for (const id of Object.keys(sessionInfo)) await stopContainer(id);
  process.exit(0);
});
main().catch((e) => { console.error("\nCould not start:", reason(e)); process.exit(1); });
