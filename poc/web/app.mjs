// PieceWork, entirely in the browser: your wallet, your files, the provider's Curio, the chain. Nothing of
// this runs on anybody's server — the page is static, and every request goes either to a public Filecoin node
// or to the storage provider you picked.

import {
  createPublicClient, createWalletClient, custom, http, getAddress, parseUnits, formatUnits,
  keccak256, toHex, hexToBytes, decodeEventLog,
} from "https://cdn.jsdelivr.net/npm/viem@2.56.8/+esm";
import { CID } from "https://cdn.jsdelivr.net/npm/multiformats@13.3.6/+esm";
import { sp as SP, piece as Piece, chains as Chains } from "https://cdn.jsdelivr.net/npm/@filoz/synapse-core@0.9.1/+esm";

export const CFG = await fetch("config.json").then((r) => r.json());
export const ABI = await fetch("abi.json").then((r) => r.json());
for (const k of Object.keys(ABI)) if (k !== "Errors") ABI[k] = [...ABI[k], ...ABI.Errors]; // so reverts decode
const C = { ...CFG.contracts, cs: getAddress(CFG.computeService) };
const chain = CFG.chainId === 314 ? Chains.mainnet : Chains.calibration;
const pub = createPublicClient({ chain, transport: http(CFG.rpc) });
export { C, chain, pub };

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
  return pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
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
  step(`Letting Filecoin Pay take ${amount} ${CFG.token} from your wallet`);
  await send(C.usdfc, ERC20_ABI, "approve", [C.payments, value]);
  step("Depositing it into Filecoin Pay");
  await send(C.payments, ABI.FilecoinPayV1, "deposit", [C.usdfc, me, value]);
}

// ---------------------------------------------------------------- data sets

const provider = (id) => CFG.providers.find((p) => p.id === id) ?? CFG.providers[0];

export async function createSet(providerId, files, label) {
  const p = provider(providerId);
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
  const pieces = [];
  for (const f of files) {
    step(`Uploading ${f.name} to ${p.name}`);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const pieceCid = await Piece.calculate(bytes);
    await SP.uploadPiece({ serviceURL: p.curioUrl, data: bytes, pieceCid });
    pieces.push({ pieceCid, metadata: { name: f.name }, name: f.name });
  }
  step("Creating your data set with the provider (you sign, it submits)");
  const created = await SP.createDataSetAndAddPieces(wallet, { serviceURL: p.curioUrl, payee: getAddress(p.address),
    pieces: pieces.map(({ pieceCid, metadata }) => ({ pieceCid, metadata })), cdn: false });
  const done = await SP.waitForCreateDataSetAddPieces({ statusUrl: created.statusUrl, timeout: 10 * 60_000 });
  step(`Letting providers add job results to data set #${done.dataSetId}, only while a job is open`);
  await send(C.fwss, FWSS_ABI, "setDataSetAuthorizer", [done.dataSetId, C.cs]);
  return Number(done.dataSetId);
}

export async function addFiles(providerId, dataSetId, files) {
  const p = provider(providerId);
  await onTheRightChain();
  const pieces = [];
  for (const f of files) {
    step(`Uploading ${f.name}`);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const pieceCid = await Piece.calculate(bytes);
    await SP.uploadPiece({ serviceURL: p.curioUrl, data: bytes, pieceCid });
    pieces.push({ pieceCid, metadata: { name: f.name } });
  }
  step("Adding them to your data set (you sign, the provider submits)");
  const r = await SP.addPieces(wallet, { serviceURL: p.curioUrl, dataSetId: BigInt(dataSetId),
    clientDataSetId: await clientDataSetId(dataSetId), pieces });
  await SP.waitForAddPieces({ statusUrl: r.statusUrl, timeout: 10 * 60_000 });
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
export async function readSet(providerId, dataSetId) {
  const p = provider(providerId);
  const d = await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView, functionName: "getDataSet", args: [BigInt(dataSetId)] });
  if (!d?.payer || getAddress(d.payer) !== me) throw new Error(`data set #${dataSetId} is not paid for by your wallet`);
  if (getAddress(d.serviceProvider) !== getAddress(p.address)) throw new Error(`data set #${dataSetId} is not held by ${p.name}`);
  const next = Number(await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "getNextPieceId", args: [BigInt(dataSetId)] }));
  const names = await pieceNames(dataSetId);
  const files = {};
  for (let i = 0; i < next; i++) {
    if (!(await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "pieceLive", args: [BigInt(dataSetId), BigInt(i)] }))) continue;
    const raw = await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "getPieceCid", args: [BigInt(dataSetId), BigInt(i)] });
    files[i] = { name: names[String(i)] ?? `piece-${i}`, cid: CID.decode(hexToBytes(raw.data)).toString() };
  }
  return { dataSetId: Number(dataSetId), provider: p.id, files, authorizer: d.payer };
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

// ---------------------------------------------------------------- jobs

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

export async function refund(jobId) {
  step("The deadline passed with no result: cancelling releases the price");
  await send(C.cs, ABI.ComputeService, "expire", [BigInt(jobId)]);
}

export const block = () => pub.getBlockNumber().then(Number);
