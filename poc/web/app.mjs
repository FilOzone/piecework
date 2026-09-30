// PieceWork, entirely in the browser: your wallet, your files, the provider's Curio, the chain. Nothing of
// this runs on anybody's server — the page is static, and every request goes either to a public Filecoin node
// or to the storage provider you picked.

import {
  createPublicClient, createWalletClient, custom, http, getAddress, parseUnits, formatUnits,
  keccak256, toHex, hexToBytes, decodeEventLog,
} from "https://cdn.jsdelivr.net/npm/viem@2.56.8/+esm";
import { CID } from "https://cdn.jsdelivr.net/npm/multiformats@13.3.6/+esm";
import { sp as SP, piece as Piece, chains as Chains } from "https://cdn.jsdelivr.net/npm/@filoz/synapse-core@0.9.1/+esm";

const V = new URL(import.meta.url).searchParams.get("v") ?? "";
const q = V ? `?v=${V}` : "";
export const CFG = await fetch(`config.json${q}`).then((r) => r.json());
export const ABI = await fetch(`abi.json${q}`).then((r) => r.json());
for (const k of Object.keys(ABI)) if (k !== "Errors") ABI[k] = [...ABI[k], ...ABI.Errors]; // so reverts decode
const C = { ...CFG.contracts, cs: getAddress(CFG.computeService) };
const chain = CFG.chainId === 314 ? Chains.mainnet : Chains.calibration;
const pub = createPublicClient({ chain, transport: http(CFG.rpc) });
export { C, chain, pub };

// The names of files this browser has uploaded, by piece CID. Warm Storage records the name in a PieceAdded
// event, but a public node can take a while to index one, and until then the page would rather use what it
// already knows than call the file "piece-6".
const KNOWN = "pw-names";
const knownNames = () => { try { return JSON.parse(localStorage.getItem(KNOWN)) ?? {}; } catch { return {}; } };
function rememberName(cid, name) {
  try { const all = knownNames(); all[String(cid)] = name; localStorage.setItem(KNOWN, JSON.stringify(all)); } catch { /* private window */ }
}

const FWSS_ABI = [{ type: "function", name: "setDataSetAuthorizer", stateMutability: "nonpayable",
  inputs: [{ name: "dataSetId", type: "uint256" }, { name: "authorizer", type: "address" }], outputs: [] }];
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
];

// ---------------------------------------------------------------- the wallet

export let me = null, wallet = null;

export async function connect() {
  if (!window.ethereum) throw new Error("No wallet in this browser. Install MetaMask, then reload.");
  const [a] = await window.ethereum.request({ method: "eth_requestAccounts" });
  const want = "0x" + CFG.chainId.toString(16);
  if ((await window.ethereum.request({ method: "eth_chainId" })) !== want) {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] })
      .catch(async (e) => {
        if (e.code !== 4902) throw e;
        await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
          chainId: want, chainName: "Filecoin Calibration", nativeCurrency: { name: "tFIL", symbol: "tFIL", decimals: 18 },
          rpcUrls: [CFG.rpc], blockExplorerUrls: ["https://filecoin-testnet.blockscout.com"] }] });
      });
  }
  me = getAddress(a);
  wallet = createWalletClient({ chain, transport: custom(window.ethereum), account: me });
  window.ethereum.on?.("accountsChanged", () => location.reload());
  window.ethereum.on?.("chainChanged", () => location.reload());
  return me;
}

// Every step is a real transaction; the page says which one it is waiting for.
export let onStep = () => {};
export function reportSteps(fn) { onStep = fn; }
let lastStep = "";
const step = (text) => { lastStep = text; onStep(text); };

// The wallet can be moved to another network at any moment, and a transaction sent to the wrong chain either
// wastes real money or fails confusingly. Check before every single one.
async function onTheRightChain() {
  const want = "0x" + CFG.chainId.toString(16);
  let at = await window.ethereum.request({ method: "eth_chainId" });
  if (at === want) return;
  onStep(`Your wallet is on another network — switch it to Filecoin ${CFG.network} to continue`);
  await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  at = await window.ethereum.request({ method: "eth_chainId" });
  if (at !== want) throw new Error(`your wallet is on chain ${parseInt(at, 16)}, and this page only works on Filecoin ${CFG.network} (${CFG.chainId}). Switch networks in your wallet and try again.`);
}

async function send(address, abi, functionName, args) {
  await onTheRightChain();
  const { request } = await pub.simulateContract({ account: me, address, abi, functionName, args });
  const gas = (await pub.estimateContractGas({ account: me, address, abi, functionName, args })) * 3n / 2n;
  // MetaMask does not always raise its window for a second transaction in the same flow, and a page that
  // just spins looks broken. Say what is waiting, and where.
  onStep(`${lastStep} — confirm in your wallet (open MetaMask if it did not come to the front)`);
  const hash = await wallet.writeContract({ ...request, account: me, chain, gas });
  onStep(`${lastStep} — sent, waiting for a block (about 30 seconds)`);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
  // A mined transaction is not a successful one. Without this check a reverted call looks exactly like a
  // completed one to everything above, and the page reports work that never happened.
  if (receipt.status !== "success") throw new Error(`the transaction was mined but reverted (${hash}); nothing changed on chain`);
  return receipt;
}

// ---------------------------------------------------------------- money

export async function money() {
  const [, , available] = await pub.readContract({ address: C.payments, abi: ABI.FilecoinPayV1, functionName: "getAccountInfoIfSettled", args: [C.usdfc, me] });
  const held = await pub.readContract({ address: C.usdfc, abi: ERC20_ABI, functionName: "balanceOf", args: [me] }).catch(() => 0n);
  const gas = await pub.getBalance({ address: me }).catch(() => 0n);
  return { available: formatUnits(available, 18), wallet: formatUnits(held, 18), gas: formatUnits(gas, 18) };
}

export async function deposit(amount) {
  const value = parseUnits(String(amount), 18);
  const held = await pub.readContract({ address: C.usdfc, abi: ERC20_ABI, functionName: "balanceOf", args: [me] });
  if (held < value) throw new Error(`your wallet holds ${formatUnits(held, 18)} ${CFG.token}, less than the ${amount} you asked for`);
  step(`Letting Filecoin Pay take ${amount} ${CFG.token} from your wallet (1 of 2)`);
  await send(C.usdfc, ERC20_ABI, "approve", [C.payments, value]);
  step(`Depositing ${amount} ${CFG.token} into Filecoin Pay (2 of 2)`);
  await send(C.payments, ABI.FilecoinPayV1, "deposit", [C.usdfc, me, value]);
}

// A provider submits our transaction and then tells us when it confirmed. That second half is a plain web
// server, and it can go down while the transaction is already on chain: the work is done and the page is still
// asking a machine that cannot answer. So watch both, and believe whichever speaks first. The chain is the
// truth; the provider's answer is only the fast path.
async function confirmed(watch, landed, { timeout = 10 * 60_000, grace = 120_000 } = {}) {
  let said = null;
  watch.then(() => (said = "ok"), (e) => (said = e instanceof Error ? e : new Error(String(e))));
  let deadline = Date.now() + timeout, shortened = false;
  for (;;) {
    if (said === "ok") return;
    if (await landed().catch(() => false)) return;
    if (said instanceof Error && !shortened) {
      // The provider gave up or errored. Give the chain a short grace period, then report its words.
      shortened = true;
      deadline = Math.min(deadline, Date.now() + grace);
      onStep(`${lastStep} — the provider stopped answering; checking the chain directly`);
    }
    if (Date.now() > deadline) {
      throw said instanceof Error ? said
        : new Error("the provider never confirmed it and nothing appeared on chain; reload to see where it got to");
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// ---------------------------------------------------------------- data sets

const provider = (id) => CFG.providers.find((p) => p.id === id) ?? CFG.providers[0];

// A provider refuses a piece smaller than this, and the refusal it sends back ("Invalid upload size") does not
// say what the limit is or which file broke it. Check here, where the file and the number are both to hand.
// It bites hardest on questions for the search service, which are naturally a sentence long.
const MIN_PIECE_BYTES = 127;
function checkSizes(files) {
  const small = [...files].filter((f) => f.size < MIN_PIECE_BYTES);
  if (!small.length) return;
  const one = small.length === 1;
  throw new Error(`${small.map((f) => `"${f.name}" is ${f.size} bytes`).join(", ")} — a stored piece has to be at least `
    + `${MIN_PIECE_BYTES} bytes, so ${one ? "that file is" : "those files are"} too small to put in a data set. `
    + `Add a couple of lines and try again.`);
}

export async function createSet(providerId, files, label = "") {
  const p = provider(providerId);
  checkSizes(files);
  await onTheRightChain();
  step("Checking your storage budget with Warm Storage");
  const [, rateAllowance, lockupAllowance, rateUsage, lockupUsage, maxLockupPeriod] = await pub.readContract({ address: C.payments,
    abi: ABI.FilecoinPayV1, functionName: "operatorApprovals", args: [C.usdfc, me, C.fwss] });
  if (lockupAllowance - lockupUsage < parseUnits("1", 18)) {
    step("Renewing the budget you give Warm Storage (every data set holds a reserve)");
    await send(C.payments, ABI.FilecoinPayV1, "setOperatorApproval",
      [C.usdfc, C.fwss, true, rateAllowance > rateUsage ? rateAllowance : rateUsage + parseUnits("0.1", 18),
        lockupUsage + parseUnits("2", 18), maxLockupPeriod || 1n << 40n]);
  }
  // Which data sets are already ours, so a new one can be told apart from someone else's.
  const before = (await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView,
    functionName: "clientDataSets", args: [me] }).catch(() => [])).map(Number);
  const pieces = [];
  for (const f of files) {
    step(`Uploading ${f.name} to ${p.name}`);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const pieceCid = await Piece.calculate(bytes);
    await SP.uploadPiece({ serviceURL: p.curioUrl, data: bytes, pieceCid });
    rememberName(pieceCid, f.name);
    pieces.push({ pieceCid, metadata: { name: f.name }, name: f.name });
  }
  step("Creating your data set with the provider (you sign, it submits)");
  const created = await SP.createDataSetAndAddPieces(wallet, { serviceURL: p.curioUrl, payee: getAddress(p.address),
    pieces: pieces.map(({ pieceCid, metadata }) => ({ pieceCid, metadata })), cdn: false,
    metadata: label ? { label } : undefined });
  let id = null;
  await confirmed(
    SP.waitForCreateDataSetAddPieces({ statusUrl: created.statusUrl, timeout: 10 * 60_000 }).then((d) => { id = Number(d.dataSetId); }),
    async () => {
      const fresh = (await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView,
        functionName: "clientDataSets", args: [me] })).map(Number).filter((x) => !before.includes(x));
      if (!fresh.length) return false;
      id = Math.max(...fresh);
      return true;
    });
  // The provider tells us which data set it made, but another client creating one at the same moment can make
  // that answer wrong, and setting the authorizer on someone else's data set is refused. Check with the chain.
  const owner = await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView,
    functionName: "getDataSet", args: [BigInt(id)] }).then((d) => d.payer, () => null);
  if (!owner || getAddress(owner) !== me) {
    step("The provider reported a data set that is not yours; asking Warm Storage which one is");
    const mine = await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView,
      functionName: "clientDataSets", args: [me] });
    const fresh = mine.map(Number).filter((x) => !before.includes(x));
    if (!fresh.length) throw new Error("the data set was created but could not be identified; reload and it will be in your list");
    id = Math.max(...fresh);
  }
  step(`Letting providers add job results to data set #${id}, only while a job is open`);
  await send(C.fwss, FWSS_ABI, "setDataSetAuthorizer", [BigInt(id), C.cs]);
  return id;
}

export async function addFiles(providerId, dataSetId, files) {
  const p = provider(providerId);
  checkSizes(files);
  await onTheRightChain();
  const pieces = [];
  for (const f of files) {
    step(`Uploading ${f.name}`);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const pieceCid = await Piece.calculate(bytes);
    await SP.uploadPiece({ serviceURL: p.curioUrl, data: bytes, pieceCid });
    rememberName(pieceCid, f.name);
    pieces.push({ pieceCid, metadata: { name: f.name } });
  }
  const had = Number(await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "getNextPieceId", args: [BigInt(dataSetId)] }));
  step("Adding them to your data set (you sign, the provider submits)");
  const r = await SP.addPieces(wallet, { serviceURL: p.curioUrl, dataSetId: BigInt(dataSetId),
    clientDataSetId: await clientDataSetId(dataSetId), pieces });
  await confirmed(
    SP.waitForAddPieces({ statusUrl: r.statusUrl, timeout: 10 * 60_000 }),
    async () => Number(await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier,
      functionName: "getNextPieceId", args: [BigInt(dataSetId)] })) >= had + pieces.length);
}

export async function removeFiles(providerId, dataSetId, pieceIds) {
  const p = provider(providerId);
  await onTheRightChain();
  step("Signing the removal; the provider submits it to PDP");
  await SP.schedulePieceDeletions(wallet, { serviceURL: p.curioUrl, dataSetId: BigInt(dataSetId),
    clientDataSetId: await clientDataSetId(dataSetId), pieceIds: pieceIds.map((x) => BigInt(x)) });
}

async function clientDataSetId(dataSetId) {
  const d = await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView, functionName: "getDataSet", args: [BigInt(dataSetId)] });
  return d.clientDataSetId;
}

// What is in a data set, read from the chain and from the provider. Piece names are the ones the client gave.
export async function readSet(providerId, dataSetId, jobs = {}) {
  const p = provider(providerId);
  const d = await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView, functionName: "getDataSet", args: [BigInt(dataSetId)] });
  if (!d?.payer || getAddress(d.payer) !== me) throw new Error(`data set #${dataSetId} is not paid for by your wallet`);
  if (getAddress(d.serviceProvider) !== getAddress(p.address)) throw new Error(`data set #${dataSetId} is not held by ${p.name}`);
  const next = Number(await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "getNextPieceId", args: [BigInt(dataSetId)] }));
  const names = await pieceNames(dataSetId);
  const mine = knownNames();
  const files = {};
  for (let i = 0; i < next; i++) {
    if (!(await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "pieceLive", args: [BigInt(dataSetId), BigInt(i)] }))) continue;
    const raw = await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "getPieceCid", args: [BigInt(dataSetId), BigInt(i)] });
    const cid = CID.decode(hexToBytes(raw.data)).toString();
    files[i] = { name: names[String(i)] ?? mine[cid] ?? `piece-${i}`, cid };
  }
  // what each piece is: a result of a job, a file of yours, on its way out, or one the provider may clear away
  for (const j of Object.values(jobs)) {
    if (Number(j.dataSetId) !== Number(dataSetId)) continue;
    for (const o of j.outputs ?? []) if (files[o.pieceId]) Object.assign(files[o.pieceId], { kind: "output", name: `${o.name} (job #${j.jobId})` });
  }
  const m = await marks(dataSetId, p.address, Object.keys(files)).catch(() => null);
  if (m) for (const [pid, f] of Object.entries(files)) {
    if (m.scheduled.has(pid)) f.removing = true;
    else if (m.still[pid]) f.removable = true;
  }
  const authorizer = await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView,
    functionName: "getDataSetAuthorizer", args: [BigInt(dataSetId)] }).catch(() => null);
  const canReceiveResults = !!authorizer && getAddress(authorizer) === getAddress(C.cs);
  return { dataSetId: Number(dataSetId), provider: p.id, files, authorizer, canReceiveResults };
}

// Public Filecoin nodes refuse a log range over a few hundred blocks, so ask in steps of 300.
async function pieceNames(dataSetId) {
  const head = Number(await pub.getBlockNumber());
  const names = {};
  for (let to = head, n = 0; n < 14; to -= 300, n++) {
    const logs = await pub.getContractEvents({ address: C.fwss, abi: ABI.FilecoinWarmStorageService, eventName: "PieceAdded",
      args: { dataSetId: BigInt(dataSetId) }, fromBlock: BigInt(Math.max(0, to - 299)), toBlock: BigInt(to) }).catch(() => []);
    for (const ev of logs) {
      const i = ev.args.keys?.indexOf("name") ?? -1;
      if (i >= 0) names[String(ev.args.pieceId)] = ev.args.values[i];
    }
  }
  return names;
}

export const fileUrl = (providerId, cid) => `${provider(providerId).curioUrl.replace(/\/$/, "")}/piece/${cid}`;

// Everything this page knows, it can read back from the chain. That matters more here than in a normal web
// app: each published version has its own address, so its own origin, so its own empty browser storage. The
// jobs and the marks on the files survive because they are on chain, not because the browser kept them.
const CHUNK = 300, WINDOW = 16; // public nodes refuse a wide eth_getLogs range; this is a few hours of blocks

async function inWindow(fn) {
  const head = Number(await pub.getBlockNumber());
  const out = [];
  for (let to = head, n = 0; n < WINDOW; to -= CHUNK, n++) {
    out.push(...await fn(BigInt(Math.max(0, to - CHUNK + 1)), BigInt(to)));
  }
  return out;
}

// The data sets this wallet pays for, at this provider. Warm Storage names the payer when a data set is
// created, but does not index it, so the filtering happens here.
export async function findDataSets(providerId) {
  const p = provider(providerId);
  // Warm Storage keeps the list, so there is no window and nothing to remember: every data set this wallet
  // has ever paid for, whenever it was made.
  const ids = await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView,
    functionName: "clientDataSets", args: [me] });
  const out = [];
  for (const id of ids) {
    const d = await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView,
      functionName: "getDataSet", args: [id] }).catch(() => null);
    if (!d || getAddress(d.serviceProvider) !== getAddress(p.address)) continue;
    let label = "";
    const [keys, values] = await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView,
      functionName: "getAllDataSetMetadata", args: [id] }).catch(() => [[], []]);
    const at = keys.indexOf("label");
    if (at >= 0) label = values[at];
    out.push({ id: Number(id), label });
  }
  return out.sort((a, b) => a.id - b.id);
}

// Jobs and sessions are numbered by the contract, so they can be counted rather than searched for: no window,
// nothing missed, nothing remembered. A deployment with thousands of them would want an index; one with tens
// should not pretend it does.
const nextId = (name) => pub.readContract({ address: C.cs, abi: ABI.ComputeService, functionName: name }).then(Number);

export async function findJobs() {
  const next = await nextId("nextJobId");
  const byDigest = Object.fromEntries(Object.keys(CFG.jobs).map((t) => [keccak256(toHex(t)), t]));
  const jobs = {};
  for (let id = Math.max(1, next - 200); id < next; id++) {
    const j = await pub.readContract({ address: C.cs, abi: ABI.ComputeService, functionName: "jobs", args: [BigInt(id)] }).catch(() => null);
    if (!j?.[0] || getAddress(j[0]) !== me) continue;
    const p = CFG.providers.find((x) => getAddress(x.address) === getAddress(j[1]));
    jobs[String(id)] = { jobId: String(id), type: byDigest[j[6]] ?? j[6].slice(0, 10), provider: p?.id ?? j[1],
      dataSetId: Number(j[5]), price: formatUnits(j[3], 18), deadline: Number(j[4]),
      status: ["none", "waiting", "paid", "refunded"][Number(j[8])], outputs: [] };
  }
  for (const [id, j] of Object.entries(jobs)) {
    if (j.status === "paid") Object.assign(j, await jobOutputs(id, j.dataSetId, j.type).catch(() => ({})));
  }
  return jobs;
}

// What a paid job delivered: JobPaid names the pieces.
async function jobOutputs(jobId, dataSetId, type) {
  const names = CFG.jobs[type]?.outputs ?? [];
  const paid = await inWindow((fromBlock, toBlock) => pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService,
    eventName: "JobPaid", args: { jobId: BigInt(jobId) }, fromBlock, toBlock }).catch(() => []));
  if (!paid.length) return {};
  const outputs = [];
  for (const [i, pid] of (paid[0].args.outputPieceIds ?? []).entries()) {
    const raw = await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "getPieceCid", args: [BigInt(dataSetId), pid] });
    outputs.push({ pieceId: String(pid), name: names[i] ?? `result-${i + 1}`, cid: CID.decode(hexToBytes(raw.data)).toString() });
  }
  return { outputs, paidTx: paid[0].transactionHash };
}

export async function findSessions() {
  const next = await nextId("nextSessionId");
  const out = {};
  for (let id = Math.max(1, next - 200); id < next; id++) {
    const x = await pub.readContract({ address: C.cs, abi: ABI.ComputeService, functionName: "sessions", args: [BigInt(id)] }).catch(() => null);
    if (!x?.[0] || getAddress(x[0]) !== me) continue;
    const type = Object.keys(CFG.services ?? {}).find((t) => keccak256(toHex(t)) === x[6]);
    out[String(id)] = { sessionId: String(id), type: type ?? x[6].slice(0, 10), rate: formatUnits(x[3], 18),
      dataSetId: Number(x[5]), railId: String(x[2]), status: ["none", "waiting for the provider", "running", "closed"][Number(x[7])] };
  }
  if (!Object.keys(out).length) return out;
  // When the meter started and when it stopped. A per-epoch charge that the page cannot show honestly is
  // worse than no page at all, so these come from the events, not from what this browser remembers doing.
  const head = Number(await pub.getBlockNumber());
  for (const name of ["SessionReady", "SessionClosed"]) {
    for (const l of await inWindow((fromBlock, toBlock) => pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService,
      eventName: name, fromBlock, toBlock }).catch(() => []))) {
      const s = out[String(l.args.sessionId)];
      if (s) s[name === "SessionReady" ? "readyBlock" : "closedBlock"] = Number(l.blockNumber);
    }
  }
  for (const s of Object.values(out)) {
    if (!s.readyBlock) { s.epochs = 0; s.owed = "0"; continue; }
    s.epochs = Math.max(0, (s.closedBlock ?? head) - s.readyBlock);
    s.owed = (s.epochs * Number(s.rate)).toFixed(3);
    s.running = s.status === "running";
  }
  return out;
}

// Which pieces the provider may still clear away, and which it has already handed to PDP. mayRemove is the
// contract's own answer and needs no searching; only the scheduling has to be looked for in events.
async function marks(dataSetId, providerAddress, pieceIds) {
  const still = {};
  for (const pid of pieceIds) {
    still[pid] = await pub.readContract({ address: C.cs, abi: ABI.ComputeService, functionName: "mayRemove",
      args: [BigInt(dataSetId), getAddress(providerAddress), BigInt(pid)] }).catch(() => false);
  }
  const scheduled = new Set();
  for (const l of await inWindow((fromBlock, toBlock) => pub.getContractEvents({ address: C.pdp, abi: ABI.PDPVerifier,
    eventName: "PiecesScheduledForRemoval", fromBlock, toBlock }).catch(() => []))) {
    if (Number(l.args.setId) === Number(dataSetId)) for (const p of l.args.pieceIds) scheduled.add(String(p));
  }
  return { still, scheduled };
}

// ---------------------------------------------------------------- jobs

// A data set made elsewhere - or one whose second step failed - cannot receive job results until the client
// points it at ComputeService. One signature, and only the payer can do it.
export async function allowResults(dataSetId) {
  await onTheRightChain();
  step(`Letting providers add job results to data set #${dataSetId}, only while a job is open`);
  await send(C.fwss, FWSS_ABI, "setDataSetAuthorizer", [BigInt(dataSetId), C.cs]);
}

export async function order(providerId, dataSetId, type, policy, pieceIds) {
  const p = provider(providerId), spec = CFG.jobs[type];
  const price = parseUnits(spec.price, 18);
  const [, , available] = await pub.readContract({ address: C.payments, abi: ABI.FilecoinPayV1, functionName: "getAccountInfoIfSettled", args: [C.usdfc, me] });
  if (available < price) throw new Error(`this job costs ${spec.price} ${CFG.token} and only ${Number(formatUnits(available, 18)).toFixed(3)} is in Filecoin Pay. Move some across first.`);
  const [, rateAllowance, lockupAllowance, , lockupUsage, maxLockupPeriod] = await pub.readContract({ address: C.payments,
    abi: ABI.FilecoinPayV1, functionName: "operatorApprovals", args: [C.usdfc, me, C.cs] });
  if (lockupAllowance - lockupUsage < price) {
    step("Renewing the budget you give the compute service");
    await send(C.payments, ABI.FilecoinPayV1, "setOperatorApproval", [C.usdfc, C.cs, true, rateAllowance, lockupUsage + parseUnits("3", 18), maxLockupPeriod || 600n]);
  }
  const inputs = pieceIds.map((x) => BigInt(x));
  const removals = policy === "replace-inputs" ? inputs : [];
  const deadline = (await pub.getBlockNumber()) + BigInt(spec.deadlineEpochs ?? 40);
  step(`Ordering the job on ${inputs.length} file${inputs.length > 1 ? "s" : ""}: the price goes on hold`);
  const r = await send(C.cs, ABI.ComputeService, "postJob",
    [getAddress(p.address), keccak256(toHex(type)), BigInt(dataSetId), inputs, removals, price, deadline]);
  for (const log of r.logs) {
    try {
      const ev = decodeEventLog({ abi: ABI.ComputeService, data: log.data, topics: log.topics });
      if (ev.eventName === "JobPosted") return { jobId: String(ev.args.jobId), deadline: Number(deadline), tx: r.transactionHash };
    } catch { /* other contracts' events */ }
  }
  throw new Error("the job went on-chain but its number could not be read");
}

// ---------------------------------------------------------------- bringing your own program
//
// The contract stores imageDigest and never reads it, so a job has never had to come from anyone's catalogue.
// A digest says what to run, though, not where to find it, and there is no room on chain for a repository
// name. So the reference goes into the data set as a piece and is listed among the job's inputs: it arrives
// with the files, it is pinned by the job, and the provider checks the image it pulls against the digest the
// chain recorded. A spec naming a hostile repository cannot substitute code, because the chain pinned the code.

const IMAGE_REF = /^([\w.\-]+(?::\d+)?(?:\/[\w.\-]+)+)@sha256:([0-9a-f]{64})$/;

export function readImageRef(ref) {
  const m = IMAGE_REF.exec((ref ?? "").trim());
  if (!m) {
    throw new Error(`"${ref}" is not an image pinned by digest. It has to look like `
      + `ghcr.io/you/thing@sha256:… — a tag will not do, because a tag can be pointed at different code tomorrow `
      + `and the whole point is that the chain records exactly what ran.`);
  }
  return { repo: m[1], digest: `0x${m[2]}` };
}

export async function orderOwnJob(providerId, dataSetId, pieceIds, ref, priceText, deadlineEpochs = 60) {
  const p = provider(providerId);
  const { repo, digest } = readImageRef(ref);
  const price = parseUnits(String(priceText), 18);
  await onTheRightChain();

  const [, , available] = await pub.readContract({ address: C.payments, abi: ABI.FilecoinPayV1,
    functionName: "getAccountInfoIfSettled", args: [C.usdfc, me] });
  if (available < price) {
    throw new Error(`you offered ${priceText} ${CFG.token} and only ${Number(formatUnits(available, 18)).toFixed(3)} `
      + `is in Filecoin Pay. Move some across first.`);
  }
  const [, rateAllowance, lockupAllowance, , lockupUsage, maxLockupPeriod] = await pub.readContract({ address: C.payments,
    abi: ABI.FilecoinPayV1, functionName: "operatorApprovals", args: [C.usdfc, me, C.cs] });
  if (lockupAllowance - lockupUsage < price) {
    step("Renewing the budget you give the compute service");
    await send(C.payments, ABI.FilecoinPayV1, "setOperatorApproval",
      [C.usdfc, C.cs, true, rateAllowance, lockupUsage + price * 3n, maxLockupPeriod || 600n]);
  }

  // The spec piece first, so it exists before the job that lists it.
  const before = Number(await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier,
    functionName: "getNextPieceId", args: [BigInt(dataSetId)] }));
  const body = JSON.stringify({ image: repo, digest: `sha256:${digest.slice(2)}`, orderedBy: me,
    note: "Where to find the program this job names. The chain pins which code runs." }, null, 2);
  step("Telling the provider where your program lives (one file into your data set)");
  await addFiles(providerId, dataSetId, [new File([body + "\n"], "job-spec.json", { type: "application/json" })]);
  const after = Number(await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier,
    functionName: "getNextPieceId", args: [BigInt(dataSetId)] }));
  if (after <= before) throw new Error("the job spec did not reach your data set; nothing was ordered");
  const specPiece = BigInt(after - 1);

  const inputs = [...pieceIds.map((x) => BigInt(x)), specPiece];
  const deadline = (await pub.getBlockNumber()) + BigInt(deadlineEpochs);
  step(`Ordering your own program over ${pieceIds.length} file${pieceIds.length === 1 ? "" : "s"}: the price goes on hold`);
  const r = await send(C.cs, ABI.ComputeService, "postJob",
    [getAddress(p.address), digest, BigInt(dataSetId), inputs, [], price, deadline]);
  for (const log of r.logs) {
    try {
      const ev = decodeEventLog({ abi: ABI.ComputeService, data: log.data, topics: log.topics });
      if (ev.eventName === "JobPosted") {
        return { jobId: String(ev.args.jobId), deadline: Number(deadline), tx: r.transactionHash, image: `${repo}@sha256:${digest.slice(2)}` };
      }
    } catch { /* other contracts' events */ }
  }
  throw new Error("the job went on-chain but its number could not be read");
}

const JOB_STATUS = ["none", "waiting", "paid", "refunded"];

export async function jobStatus(jobId, fromBlock, type) {
  const j = await pub.readContract({ address: C.cs, abi: ABI.ComputeService, functionName: "jobs", args: [BigInt(jobId)] });
  const status = JOB_STATUS[Number(j[8])];
  const out = { status, dataSetId: Number(j[5]), deadline: Number(j[4]), price: formatUnits(j[3], 18), outputs: [] };
  if (status !== "paid") return out;
  const paid = await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, eventName: "JobPaid",
    fromBlock: BigInt(fromBlock), args: { jobId: BigInt(jobId) } }).catch(() => []);
  const names = CFG.jobs[type]?.outputs ?? [];
  for (const [i, pid] of (paid[0]?.args.outputPieceIds ?? []).entries()) {
    const raw = await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "getPieceCid", args: [BigInt(out.dataSetId), pid] });
    out.outputs.push({ pieceId: String(pid), name: names[i] ?? `result-${i + 1}`, cid: CID.decode(hexToBytes(raw.data)).toString() });
  }
  out.paidTx = paid[0]?.transactionHash;
  return out;
}

// ---------------------------------------------------------------- pay for time

export async function openSession(providerId, dataSetId, type) {
  await onTheRightChain();
  const p = provider(providerId), spec = CFG.services[type];
  const rate = parseUnits(spec.rate, 18);
  const epochs = BigInt(spec.lockupEpochs ?? 60);
  const needed = rate * epochs;
  const [, , available] = await pub.readContract({ address: C.payments, abi: ABI.FilecoinPayV1, functionName: "getAccountInfoIfSettled", args: [C.usdfc, me] });
  if (available < needed)
    throw new Error(`the provider holds ${formatUnits(needed, 18)} ${CFG.token} as a safety margin while this runs, and only ${Number(formatUnits(available, 18)).toFixed(3)} is in Filecoin Pay.`);
  const [, rateAllowance, lockupAllowance, rateUsage, lockupUsage, maxLockupPeriod] = await pub.readContract({ address: C.payments,
    abi: ABI.FilecoinPayV1, functionName: "operatorApprovals", args: [C.usdfc, me, C.cs] });
  if (rateAllowance - rateUsage < rate || lockupAllowance - lockupUsage < needed || maxLockupPeriod < epochs) {
    step("Renewing the budget you give the compute service");
    await send(C.payments, ABI.FilecoinPayV1, "setOperatorApproval",
      [C.usdfc, C.cs, true, rateUsage + rate * 4n, lockupUsage + needed * 4n, epochs * 4n > maxLockupPeriod ? epochs * 4n : maxLockupPeriod]);
  }
  step(`Opening the session at ${spec.rate} ${CFG.token} per epoch — nothing is charged until the provider says it is running`);
  const r = await send(C.cs, ABI.ComputeService, "openSession",
    [getAddress(p.address), keccak256(toHex(type)), rate, epochs, BigInt(dataSetId)]);
  for (const log of r.logs) {
    try {
      const ev = decodeEventLog({ abi: ABI.ComputeService, data: log.data, topics: log.topics });
      if (ev.eventName === "SessionOpened") return { sessionId: String(ev.args.sessionId), tx: r.transactionHash, fromBlock: Number(r.blockNumber) };
    } catch { /* other contracts' events */ }
  }
  throw new Error("the session went on-chain but its number could not be read");
}

export async function closeSession(sessionId) {
  step("Closing the session: the service stops and so does the charge, at this epoch");
  await send(C.cs, ABI.ComputeService, "closeSession", [BigInt(sessionId)]);
}

const SESSION_STATUS = ["none", "waiting for the provider", "running", "closed"];

export async function sessionStatus(sessionId, fromBlock, rate) {
  const s = await pub.readContract({ address: C.cs, abi: ABI.ComputeService, functionName: "sessions", args: [BigInt(sessionId)] });
  const out = { status: SESSION_STATUS[Number(s[7])] ?? "unknown", epochs: 0, spent: "0" };
  const ready = await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, eventName: "SessionReady",
    fromBlock: BigInt(fromBlock), args: { sessionId: BigInt(sessionId) } }).catch(() => []);
  if (!ready[0]) return out;
  const startedAt = Number(ready[0].args.epoch);
  const closed = await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, eventName: "SessionClosed",
    fromBlock: BigInt(fromBlock), args: { sessionId: BigInt(sessionId) } }).catch(() => []);
  const until = closed[0] ? Number(closed[0].blockNumber) : Number(await pub.getBlockNumber());
  out.epochs = Math.max(0, until - startedAt);
  out.spent = (Number(rate) * out.epochs).toFixed(4);
  out.startedAt = startedAt;
  return out;
}

export async function refund(jobId) {
  step("The deadline passed with no result: cancelling releases the price");
  await send(C.cs, ABI.ComputeService, "expire", [BigInt(jobId)]);
}

export const block = () => pub.getBlockNumber().then(Number);
