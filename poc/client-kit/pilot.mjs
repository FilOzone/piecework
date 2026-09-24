// Client console for the provider pilot (served at /client.html, only to this machine).
//
// Plays a client with the demo wallet against any provider in providers.json: creates data sets at that provider
// through its Curio (FilOz's Synapse library, the same calls every FOC client makes), adds and removes files,
// orders jobs, and shows the results, read back from the provider's Curio. Each long action runs as a "task"
// whose steps the page shows while it waits for the chain.

import fs from "node:fs";
import path from "node:path";
import { createWalletClient, http, fallback, keccak256, toHex, hexToBytes, parseUnits, formatUnits, getAddress, decodeEventLog } from "viem";
import { CID } from "multiformats/cid";
import { calibration } from "@filoz/synapse-core/chains";
import * as Piece from "@filoz/synapse-core/piece";
import * as SP from "@filoz/synapse-core/sp";

const DOC = /^(loan-agreement|kyc-form|invoice|trade-confirmation)/;
const FWSS_ABI = [{ type: "function", name: "setDataSetAuthorizer", stateMutability: "nonpayable",
  inputs: [{ name: "dataSetId", type: "uint256" }, { name: "authorizer", type: "address" }], outputs: [] }];

export function createPilot({ HERE, RUN, NET, C, ABI, pub, demoAcct, say, demoDataSet, paths = {} }) {
  const PROVIDERS_FILE = paths.providers ?? path.join(HERE, "providers.json");
  const SAMPLES_DIR = paths.samples ?? path.join(HERE, "data", "dataset");
  const JOBS = JSON.parse(fs.readFileSync(paths.jobs ?? path.join(HERE, "provider-kit", "jobs.json"), "utf8"));
  const STATE_FILE = path.join(RUN, "pilot.json");
  const st = load();
  const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(st, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const wallet = createWalletClient({ chain: calibration, account: demoAcct,
    transport: fallback([http(NET.rpc), http(NET.rpcBackup)], { retryCount: 2 }) });
  const providers = () => JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
  const provider = (id) => { const p = providers().find((x) => x.id === id); if (!p?.address || !p.curioUrl) throw new Error("this provider is not set up yet"); return p; };

  // State: one entry per data set, so a client can hold several with the same provider.
  // (v1 kept a single data set per provider; migrate it.)
  function load() {
    const s = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { v: 2, sets: {}, jobs: {} };
    if (s.v === 2) return s;
    const sets = {};
    for (const [providerId, set] of Object.entries(s.sets ?? {}))
      sets[String(set.dataSetId)] = { provider: providerId, dataSetId: set.dataSetId, files: set.files ?? {}, label: "First data set" };
    return { v: 2, sets, jobs: s.jobs ?? {} };
  }
  const getSet = (dataSetId) => { const s = st.sets[String(dataSetId)]; if (!s) throw new Error(`you have no data set #${dataSetId}`); return s; };

  // The laptop provider already holds the demo wallet's main data set: reuse it.
  const seed = demoDataSet?.();
  if (seed && !st.sets[String(seed.dataSetId)])
    st.sets[String(seed.dataSetId)] = { provider: "laptop", dataSetId: seed.dataSetId, files: seed.files, label: "First data set" };
  save();

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

  // A file the page sent: { name, data } with data base64-encoded.
  function decode(files) {
    return files.map(({ name, data }) => {
      const bytes = new Uint8Array(Buffer.from(data, "base64"));
      if (bytes.length < 127) throw new Error(`${name} is too small to store (minimum 127 bytes)`);
      if (bytes.length > 50_000_000) throw new Error(`${name} is too large for this demo (maximum 50 MB)`);
      return { name, bytes };
    });
  }

  // ---------------------------------------------------------------- data sets

  // Creates a new data set at this provider. Either with the synthetic financial documents, or with files
  // the client dropped on the page. A data set is always created together with its first pieces.
  function createSet(id, { files, label } = {}) {
    const p = provider(id);
    const chosen = files?.length
      ? decode(files)
      : (fs.existsSync(SAMPLES_DIR) ? fs.readdirSync(SAMPLES_DIR).filter((f) => DOC.test(f)).sort() : [])
        .map((f) => ({ name: f, bytes: new Uint8Array(fs.readFileSync(path.join(SAMPLES_DIR, f))) }));
    if (!chosen.length) throw new Error("no files to put in the data set: drop some files on the page");
    const name = label?.trim() || (files?.length ? `${chosen.length} file${chosen.length > 1 ? "s" : ""}` : "Sample financial documents");
    return run(`Create a data set with ${p.name}`, async (step) => {
      // Warm Storage holds a reserve for every data set (Rails.sol L90: lockupAllowance >= lockupUsage + requiredLockup).
      // Each new data set eats into the budget the client gave Warm Storage, so top it up when it runs low.
      const [, rateAllowance, lockupAllowance, rateUsage, lockupUsage, maxLockupPeriod] = await pub.readContract({ address: C.payments,
        abi: ABI.FilecoinPayV1, functionName: "operatorApprovals", args: [C.usdfc, demoAcct.address, C.fwss] });
      if (lockupAllowance - lockupUsage < parseUnits("1", 18)) {
        step("Renewing your storage budget with Warm Storage (each data set holds a reserve; one block)");
        await send(C.payments, ABI.FilecoinPayV1, "setOperatorApproval",
          [C.usdfc, C.fwss, true, rateAllowance > rateUsage ? rateAllowance : rateUsage + parseUnits("0.1", 18),
            lockupUsage + parseUnits("2", 18), maxLockupPeriod]);
      }
      step(`Uploading ${chosen.length} file${chosen.length > 1 ? "s" : ""} to the provider's Curio`);
      const pieces = [];
      for (const f of chosen) pieces.push({ pieceCid: await upload(p, f.bytes), metadata: { name: f.name }, name: f.name });
      step("Creating your data set with the provider and adding the files (you sign, Curio submits; one block)");
      const created = await SP.createDataSetAndAddPieces(wallet, { serviceURL: p.curioUrl, payee: getAddress(p.address),
        pieces: pieces.map(({ pieceCid, metadata }) => ({ pieceCid, metadata })), cdn: false });
      const done = await SP.waitForCreateDataSetAddPieces({ statusUrl: created.statusUrl });
      const stored = Object.fromEntries(done.piecesIds.map((pid, i) => [String(pid), { name: pieces[i].name, cid: String(pieces[i].pieceCid), kind: "input" }]));
      st.sets[String(done.dataSetId)] = { provider: id, dataSetId: Number(done.dataSetId), files: stored, label: name, created: Date.now() };
      save();
      step(`Letting providers add job results to data set #${done.dataSetId}, only while you have a job open with them (one block)`);
      await send(C.fwss, FWSS_ABI, "setDataSetAuthorizer", [done.dataSetId, C.cs]);
    });
  }

  function addFiles(dataSetId, files) {
    const set = getSet(dataSetId), p = provider(set.provider);
    const chosen = decode(files ?? []);
    if (!chosen.length) throw new Error("no files to add");
    return run(`Add ${chosen.length} file${chosen.length > 1 ? "s" : ""} to data set #${dataSetId}`, async (step) => {
      step(`Uploading ${chosen.length > 1 ? "the files" : chosen[0].name} to the provider's Curio`);
      const pieces = [];
      for (const f of chosen) pieces.push({ pieceCid: await upload(p, f.bytes), metadata: { name: f.name }, name: f.name });
      step(`Adding ${chosen.length > 1 ? "them" : "it"} to your data set #${dataSetId} (you sign, Curio submits; one block)`);
      const r = await SP.addPieces(wallet, { serviceURL: p.curioUrl, dataSetId: BigInt(dataSetId), clientDataSetId: await clientDataSetId(dataSetId),
        pieces: pieces.map(({ pieceCid, metadata }) => ({ pieceCid, metadata })) });
      const done = await SP.waitForAddPieces({ statusUrl: r.statusUrl });
      done.confirmedPieceIds.forEach((pid, i) => (set.files[String(pid)] = { name: pieces[i].name, cid: String(pieces[i].pieceCid), kind: "input" }));
      save();
    });
  }

  // The client removing its own files: the client signs, the provider's Curio submits it to PDPVerifier.
  // Warm Storage asks ComputeService (the data set's authorizer) and it allows it, because the signer is the
  // payer (ComputeService.isAuthorized, L311). PDP removes the pieces at the provider's next proving period.
  function removeFiles(dataSetId, pieceIds) {
    const set = getSet(dataSetId), p = provider(set.provider);
    const ids = (pieceIds ?? []).map((x) => BigInt(x));
    if (!ids.length) throw new Error("no files to remove");
    for (const id of ids) if (!set.files[String(id)]) throw new Error(`piece #${id} is not in this data set`);
    return run(`Remove ${ids.length} file${ids.length > 1 ? "s" : ""} from data set #${dataSetId}`, async (step) => {
      step("Signing the removal and handing it to the provider, which submits it to PDP (one block)");
      const r = await SP.schedulePieceDeletions(wallet, { serviceURL: p.curioUrl, dataSetId: BigInt(dataSetId),
        clientDataSetId: await clientDataSetId(dataSetId), pieceIds: ids });
      for (const id of ids) { set.files[String(id)].removing = true; set.files[String(id)].removeTx = r.hash; }
      save();
      step("Scheduled: PDP drops the pieces at the provider's next proving period, and you stop paying for them");
    });
  }

  async function clientDataSetId(dataSetId) {
    const d = await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView, functionName: "getDataSet", args: [BigInt(dataSetId)] });
    return d.clientDataSetId;
  }

  // ---------------------------------------------------------------- jobs

  // What happens to the client's files once the job has delivered. The client lists the pieces the provider may
  // then remove; the contract allows those and nothing else, once each.
  function removalsFor(policy, set, inputs) {
    if (policy === "replace-inputs") return inputs;
    if (policy === "replace-previous") {
      return Object.entries(set.files).filter(([, f]) => f.kind === "output" && !f.removing).map(([pid]) => BigInt(pid));
    }
    return [];
  }

  function order(dataSetId, type, policy = "keep") {
    const set = getSet(dataSetId), p = provider(set.provider), spec = JOBS[type];
    if (!spec) throw new Error("unknown job type");
    const inputs = Object.entries(set.files)
      .filter(([, f]) => f.kind === "input" && !f.removing && f.name.endsWith(spec.inputExtension ?? "")).map(([pid]) => BigInt(pid));
    if (!inputs.length) throw new Error(`no ${spec.inputExtension} files in this data set for this job`);
    const price = parseUnits(spec.price ?? "0.5", 18);
    const removals = removalsFor(policy, set, inputs);
    return run(`Order "${spec.name}" from ${p.name}`, async (step) => {
      const [, rateAllowance, lockupAllowance, , lockupUsage, maxLockupPeriod] = await pub.readContract({ address: C.payments, abi: ABI.FilecoinPayV1,
        functionName: "operatorApprovals", args: [C.usdfc, demoAcct.address, C.cs] });
      if (lockupAllowance - lockupUsage < price) {
        step("Renewing your budget for the compute service (each paid job uses part of it; one block)");
        await send(C.payments, ABI.FilecoinPayV1, "setOperatorApproval", [C.usdfc, C.cs, true, rateAllowance, lockupUsage + parseUnits("3", 18), maxLockupPeriod || 600n]);
      }
      const deadline = (await pub.getBlockNumber()) + BigInt(spec.deadlineEpochs ?? 40);
      step(`Ordering the job on ${inputs.length} files: the price is put on hold (one block)`);
      if (removals.length) step(`The provider will be allowed to remove ${removals.length} old ${removals.length === 1 ? "file" : "files"} once it has delivered`);
      const r = await send(C.cs, ABI.ComputeService, "postJob",
        [getAddress(p.address), keccak256(toHex(type)), BigInt(set.dataSetId), inputs, removals, price, deadline]);
      let posted = null; // read the job id from this transaction's own logs
      for (const log of r.logs) {
        try {
          const ev = decodeEventLog({ abi: ABI.ComputeService, data: log.data, topics: log.topics });
          if (ev.eventName === "JobPosted") posted = ev.args;
        } catch { /* other contracts' events */ }
      }
      if (!posted) throw new Error("the job went on-chain but its id could not be read; it will be picked up on the next refresh");
      st.jobs[String(posted.jobId)] = { contract: C.cs, provider: set.provider, type, policy, dataSetId: set.dataSetId, inputs: inputs.length, price: spec.price ?? "0.5",
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
      const set = st.sets[String(j.dataSetId)];
      for (const [i, pid] of ids.entries()) {
        const cid = CID.decode(hexToBytes((await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "getPieceCid", args: [BigInt(j.dataSetId), pid] })).data)).toString();
        outputs.push({ pieceId: String(pid), name: names[i] ?? `result-${i + 1}`, cid });
        if (set) set.files[String(pid)] = { name: `${names[i] ?? "result"} (job #${jobId})`, cid, kind: "output" };
      }
      j.outputs = outputs; j.status = "paid"; j.paidTx = paid[0]?.transactionHash;
      if (set && j.policy && j.policy !== "keep") { // the provider may now remove those pieces; mark them
        for (const [pid, f] of Object.entries(set.files))
          if ((j.policy === "replace-inputs" && f.kind === "input") || (j.policy === "replace-previous" && f.kind === "output" && !outputs.some((o) => o.pieceId === pid))) f.removable = true;
      }
      save();
    } else if (s === 3) { j.status = "expired"; save(); }
    else j.status = (await pub.getBlockNumber()) > BigInt(j.deadline) ? "late" : "waiting";
    return j;
  }

  // Jobs left over from an earlier deployment of ComputeService: the current contract has never heard of them,
  // so drop them instead of showing phantom "late" jobs with a refund button that would revert.
  let pruned = false;
  async function pruneStaleJobs() {
    if (pruned) return;
    pruned = true;
    for (const [id, j] of Object.entries(st.jobs)) {
      if (j.contract === C.cs) continue;
      const c = await pub.readContract({ address: C.cs, abi: ABI.ComputeService, functionName: "jobs", args: [BigInt(id)] })
        .catch(() => null);
      if (!c) { pruned = false; return; } // the node is unhappy: try again next time
      if (getAddress(c[0]) === getAddress(demoAcct.address) && Number(c[5]) === Number(j.dataSetId)) j.contract = C.cs;
      else { delete st.jobs[id]; say(`[client console] job #${id} belonged to an earlier contract; removed from the list`); }
    }
    save();
  }

  async function findLostJobs() {
    const head = await pub.getBlockNumber();
    const from = head > 2000n ? head - 2000n : 0n;
    const logs = await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, eventName: "JobPosted",
      args: { client: demoAcct.address }, fromBlock: from, toBlock: head }).catch(() => []);
    for (const l of logs) {
      const id = String(l.args.jobId);
      if (st.jobs[id]) continue;
      const set = st.sets[String(l.args.dataSetId)];
      if (!set) continue;
      st.jobs[id] = { contract: C.cs, provider: set.provider, type: Object.keys(JOBS).find((t) => keccak256(toHex(t)) === l.args.imageDigest) ?? "unknown",
        dataSetId: Number(l.args.dataSetId), inputs: l.args.inputPieceIds.length, price: formatUnits(l.args.price, 18),
        deadline: String(l.args.deadline), fromBlock: String(l.blockNumber), postTx: l.transactionHash };
      say(`[client console] found job #${id} ordered earlier from ${providers().find((p) => p.id === set.provider)?.name ?? set.provider}`);
    }
    save();
  }

  async function state() {
    await pruneStaleJobs().catch(() => {});
    await findLostJobs().catch(() => {});
    const ps = await Promise.all(providers().map(async (p) => {
      const ready = !!(p.address && p.curioUrl);
      const reachable = ready ? await fetch(`${p.curioUrl}/pdp/ping`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false) : false;
      const sets = Object.values(st.sets).filter((s) => s.provider === p.id).sort((a, b) => a.dataSetId - b.dataSetId);
      return { ...p, ready, reachable, sets };
    }));
    const jobs = [];
    for (const [id, j] of Object.entries(st.jobs).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 20))
      jobs.push({ id, ...(await jobStatus(id, j).catch(() => j)), name: JOBS[j.type]?.name });
    const [, , available] = await pub.readContract({ address: C.payments, abi: ABI.FilecoinPayV1, functionName: "getAccountInfoIfSettled", args: [C.usdfc, demoAcct.address] });
    return { client: demoAcct.address, available: formatUnits(available, 18), token: NET.token, explorer: NET.explorer,
      block: Number(await pub.getBlockNumber()),
      policies: [{ id: "keep", label: "Keep everything (default)" },
        { id: "replace-previous", label: "Keep only the newest result: the provider may remove earlier results" },
        { id: "replace-inputs", label: "Replace the originals: the provider may remove the files it read" }],
      providers: ps, jobs, jobTypes: Object.entries(JOBS).map(([type, j]) => ({ type, name: j.name, price: j.price ?? "0.5", inputExtension: j.inputExtension })), task };
  }

  async function file(dataSetId, pieceId) {
    const set = getSet(dataSetId), p = provider(set.provider), f = set.files[String(pieceId)];
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

  return { state, createSet, addFiles, removeFiles, order, file, expire };
}
