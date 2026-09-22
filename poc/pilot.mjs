// Client console for the provider pilot (served at /client.html, only to this machine).
//
// Plays a client with the demo wallet against any provider in providers.json: stores documents in a data set at that
// provider through its Curio (FilOz's Synapse library, the same calls every FOC client makes), uploads extra files,
// orders jobs, and shows the results, read back from the provider's Curio. Each long action runs as a "task" whose
// steps the page shows while it waits for the chain.

import fs from "node:fs";
import path from "node:path";
import { createWalletClient, http, fallback, keccak256, toHex, hexToBytes, parseUnits, formatUnits, getAddress } from "viem";
import { CID } from "multiformats/cid";
import { calibration } from "@filoz/synapse-core/chains";
import * as Piece from "@filoz/synapse-core/piece";
import * as SP from "@filoz/synapse-core/sp";

const DOC = /^(loan-agreement|kyc-form|invoice|trade-confirmation)/;
const FWSS_ABI = [{ type: "function", name: "setDataSetAuthorizer", stateMutability: "nonpayable",
  inputs: [{ name: "dataSetId", type: "uint256" }, { name: "authorizer", type: "address" }], outputs: [] }];

export function createPilot({ HERE, RUN, NET, C, ABI, pub, demoAcct, say, demoDataSet }) {
  const PROVIDERS_FILE = path.join(HERE, "providers.json");
  const JOBS = JSON.parse(fs.readFileSync(path.join(HERE, "provider-kit", "jobs.json"), "utf8"));
  const STATE_FILE = path.join(RUN, "pilot.json");
  const st = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { sets: {}, jobs: {} };
  const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(st, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const wallet = createWalletClient({ chain: calibration, account: demoAcct,
    transport: fallback([http(NET.rpc), http(NET.rpcBackup)], { retryCount: 2 }) });
  const providers = () => JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
  const provider = (id) => { const p = providers().find((x) => x.id === id); if (!p?.address || !p.curioUrl) throw new Error("this provider is not set up yet"); return p; };

  // The laptop provider already holds the demo wallet's main data set: reuse it.
  const seed = demoDataSet();
  if (seed && !st.sets.laptop) { st.sets.laptop = { dataSetId: seed.dataSetId, files: seed.files }; save(); }

  let task = null; // { title, steps: [{ text, done }], error, done }
  async function run(title, fn) {
    if (task && !task.done) throw new Error("another action is still running");
    task = { title, steps: [], done: false };
    const step = (text) => { task.steps.forEach((s) => (s.done = true)); task.steps.push({ text, done: false }); say(`[client console] ${text}`); };
    fn(step).then(() => { task.steps.forEach((s) => (s.done = true)); task.done = true; },
      (e) => { task.error = e.shortMessage ?? e.message; task.done = true; say(`[client console] failed: ${task.error}`); });
  }
  async function send(address, abi, functionName, args) {
    const { request } = await pub.simulateContract({ account: demoAcct, address, abi, functionName, args });
    const gas = (await pub.estimateContractGas({ account: demoAcct, address, abi, functionName, args })) * 3n / 2n;
    const hash = await wallet.writeContract({ ...request, gas });
    for (let i = 1; ; i++) {
      try { return await pub.waitForTransactionReceipt({ hash, timeout: 600_000 }); }
      catch (e) { if (i >= 6) throw e; await new Promise((r) => setTimeout(r, 5000)); }
    }
  }
  const upload = async (p, bytes) => { const pieceCid = await Piece.calculate(bytes); await SP.uploadPiece({ serviceURL: p.curioUrl, data: bytes, pieceCid }); return pieceCid; };

  // ---------------------------------------------------------------- actions

  function store(id) {
    const p = provider(id);
    if (st.sets[id]) throw new Error("you already have a data set with this provider");
    return run(`Store the sample documents with ${p.name}`, async (step) => {
      const dir = path.join(HERE, "data", "dataset");
      const docs = fs.readdirSync(dir).filter((f) => DOC.test(f)).sort();
      step(`Uploading ${docs.length} documents to the provider's Curio`);
      const pieces = [];
      for (const f of docs) pieces.push({ pieceCid: await upload(p, new Uint8Array(fs.readFileSync(path.join(dir, f)))), metadata: { name: f }, name: f });
      step("Creating your data set with the provider and adding the documents (you sign, Curio submits; one block)");
      const created = await SP.createDataSetAndAddPieces(wallet, { serviceURL: p.curioUrl, payee: getAddress(p.address),
        pieces: pieces.map(({ pieceCid, metadata }) => ({ pieceCid, metadata })), cdn: false });
      const done = await SP.waitForCreateDataSetAddPieces({ statusUrl: created.statusUrl });
      const files = Object.fromEntries(done.piecesIds.map((pid, i) => [String(pid), { name: pieces[i].name, cid: String(pieces[i].pieceCid), kind: "input" }]));
      st.sets[id] = { dataSetId: Number(done.dataSetId), files }; save();
      step(`Letting providers add job results to data set #${done.dataSetId}, only while you have a job open with them (one block)`);
      await send(C.fwss, FWSS_ABI, "setDataSetAuthorizer", [done.dataSetId, C.cs]);
    });
  }

  function uploadFile(id, name, base64) {
    const p = provider(id), set = st.sets[id];
    if (!set) throw new Error("store the sample documents first: that creates your data set with this provider");
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));
    if (bytes.length < 127) throw new Error("the file is too small to store (minimum 127 bytes)");
    if (bytes.length > 50_000_000) throw new Error("the file is too large for this demo (maximum 50 MB)");
    return run(`Upload ${name} to ${p.name}`, async (step) => {
      step("Uploading the file to the provider's Curio");
      const pieceCid = await upload(p, bytes);
      step(`Adding it to your data set #${set.dataSetId} (you sign, Curio submits; one block)`);
      const r = await SP.addPieces(wallet, { serviceURL: p.curioUrl, dataSetId: BigInt(set.dataSetId), clientDataSetId: await clientDataSetId(set.dataSetId),
        pieces: [{ pieceCid, metadata: { name } }] });
      const done = await SP.waitForAddPieces({ statusUrl: r.statusUrl });
      set.files[String(done.confirmedPieceIds[0])] = { name, cid: String(pieceCid), kind: "input" }; save();
    });
  }

  async function clientDataSetId(dataSetId) {
    const d = await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView, functionName: "getDataSet", args: [BigInt(dataSetId)] });
    return d.clientDataSetId;
  }

  function order(id, type) {
    const p = provider(id), set = st.sets[id], spec = JOBS[type];
    if (!set) throw new Error("store the sample documents first");
    if (!spec) throw new Error("unknown job type");
    const inputs = Object.entries(set.files).filter(([, f]) => f.kind === "input" && f.name.endsWith(spec.inputExtension ?? "")).map(([pid]) => BigInt(pid));
    if (!inputs.length) throw new Error(`no ${spec.inputExtension} files in your data set for this job`);
    const price = parseUnits(spec.price ?? "0.5", 18);
    return run(`Order "${spec.name}" from ${p.name}`, async (step) => {
      const [, rateAllowance, lockupAllowance, , lockupUsage, maxLockupPeriod] = await pub.readContract({ address: C.payments, abi: ABI.FilecoinPayV1,
        functionName: "operatorApprovals", args: [C.usdfc, demoAcct.address, C.cs] });
      if (lockupAllowance - lockupUsage < price) {
        step("Renewing your budget for the compute service (each paid job uses part of it; one block)");
        await send(C.payments, ABI.FilecoinPayV1, "setOperatorApproval", [C.usdfc, C.cs, true, rateAllowance, lockupUsage + parseUnits("3", 18), maxLockupPeriod || 600n]);
      }
      const deadline = (await pub.getBlockNumber()) + BigInt(spec.deadlineEpochs ?? 40);
      step(`Ordering the job on ${inputs.length} files: the price is put on hold (one block)`);
      const r = await send(C.cs, ABI.ComputeService, "postJob", [getAddress(p.address), keccak256(toHex(type)), BigInt(set.dataSetId), inputs, price, deadline]);
      const ev = (await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, eventName: "JobPosted", fromBlock: r.blockNumber, toBlock: r.blockNumber }))
        .find((l) => l.transactionHash === r.transactionHash);
      st.jobs[String(ev.args.jobId)] = { provider: id, type, dataSetId: set.dataSetId, inputs: inputs.length, price: spec.price ?? "0.5",
        deadline: String(deadline), fromBlock: String(r.blockNumber), postTx: r.transactionHash };
      save();
    });
  }

  // ---------------------------------------------------------------- state for the page

  async function jobStatus(jobId, j) {
    if (j.status === "paid" || j.status === "expired") return j;
    const c = await pub.readContract({ address: C.cs, abi: ABI.ComputeService, functionName: "jobs", args: [BigInt(jobId)] });
    const s = Number(c[8]);
    if (s === 2) {
      const paid = await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, eventName: "JobPaid", fromBlock: BigInt(j.fromBlock), args: { jobId: BigInt(jobId) } });
      const ids = paid[0]?.args.outputPieceIds ?? [];
      const names = JOBS[j.type]?.outputs ?? [];
      const outputs = [];
      for (const [i, pid] of ids.entries()) {
        const cid = CID.decode(hexToBytes((await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "getPieceCid", args: [BigInt(j.dataSetId), pid] })).data)).toString();
        outputs.push({ pieceId: String(pid), name: names[i] ?? `result-${i + 1}`, cid });
        const set = st.sets[j.provider];
        if (set) set.files[String(pid)] = { name: `${names[i] ?? "result"} (job #${jobId})`, cid, kind: "output" };
      }
      j.outputs = outputs; j.status = "paid"; j.paidTx = paid[0]?.transactionHash; save();
    } else if (s === 3) { j.status = "expired"; save(); }
    else j.status = (await pub.getBlockNumber()) > BigInt(j.deadline) ? "late" : "waiting";
    return j;
  }

  async function state() {
    const ps = await Promise.all(providers().map(async (p) => {
      const ready = !!(p.address && p.curioUrl);
      const reachable = ready ? await fetch(`${p.curioUrl}/pdp/ping`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false) : false;
      return { ...p, ready, reachable, set: st.sets[p.id] ?? null };
    }));
    const jobs = [];
    for (const [id, j] of Object.entries(st.jobs).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 20))
      jobs.push({ id, ...(await jobStatus(id, j).catch(() => j)), name: JOBS[j.type]?.name });
    const [, , available] = await pub.readContract({ address: C.payments, abi: ABI.FilecoinPayV1, functionName: "getAccountInfoIfSettled", args: [C.usdfc, demoAcct.address] });
    return { client: demoAcct.address, available: formatUnits(available, 18), token: NET.token, explorer: NET.explorer,
      providers: ps, jobs, jobTypes: Object.entries(JOBS).map(([type, j]) => ({ type, name: j.name, price: j.price ?? "0.5", inputExtension: j.inputExtension })), task };
  }

  async function file(id, pieceId) {
    const p = provider(id), f = st.sets[id]?.files[pieceId];
    if (!f) throw new Error("unknown file");
    const r = await fetch(`${p.curioUrl}/piece/${f.cid}`);
    if (!r.ok) throw new Error(`the provider did not return the file (HTTP ${r.status})`);
    return Buffer.from(await r.arrayBuffer());
  }

  function expire(jobId) {
    const j = st.jobs[String(jobId)];
    if (!j) throw new Error("unknown job");
    return run(`Get your money back for job #${jobId}`, async (step) => {
      step("The deadline passed with no result: cancelling the job releases the price (one block)");
      const r = await send(C.cs, ABI.ComputeService, "expire", [BigInt(jobId)]);
      j.status = "expired"; j.expireTx = r.transactionHash; save();
    });
  }

  return { state, store, uploadFile, order, file, expire };
}
