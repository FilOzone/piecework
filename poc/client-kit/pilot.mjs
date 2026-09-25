// What the client console does: data sets at a provider, files in them, jobs over them, refunds.
//
// It talks to the provider's Curio with FilOz's Synapse library (the same calls every FOC client makes) and to
// ComputeService, Filecoin Pay and PDPVerifier on the chain. Each long action runs as a "task" whose steps the
// page shows while it waits for a block.
//
// Signing is left to the caller: `signer` gives an account (a key file on this machine, or the wallet in the
// browser - see console.mjs) and a way to send a transaction. Nothing here ever sees a key.

import fs from "node:fs";
import path from "node:path";
import { createWalletClient, http, fallback, keccak256, toHex, hexToBytes, parseUnits, formatUnits, getAddress, decodeEventLog } from "viem";
import { calibration, mainnet } from "@filoz/synapse-core/chains";
import { CID } from "multiformats/cid";
import * as Piece from "@filoz/synapse-core/piece";
import * as SP from "@filoz/synapse-core/sp";

const DOC = /^(loan-agreement|kyc-form|invoice|trade-confirmation)/;
const FWSS_ABI = [{ type: "function", name: "setDataSetAuthorizer", stateMutability: "nonpayable",
  inputs: [{ name: "dataSetId", type: "uint256" }, { name: "authorizer", type: "address" }], outputs: [] }];
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
];
// Free test tokens on Calibration, for when the wallet runs dry. The USDFC faucet has a CAPTCHA and a small
// daily limit; when it refuses, mint USDFC against tFIL in Secured Finance's testnet app instead.
const FAUCETS = {
  tFIL: "https://faucet.calibnet.chainsafe-fil.io/funds.html",
  USDFC: "https://forest-explorer.chainsafe.dev/faucet/calibnet_usdfc",
  "USDFC (mint against tFIL)": "https://stg.usdfc.net",
};

export function createPilot({ HERE, RUN, NET, C, ABI, pub, signer, say, demoDataSet, paths = {} }) {
  const PROVIDERS_FILE = paths.providers ?? path.join(HERE, "providers.json");
  const SAMPLES_DIR = paths.samples ?? path.join(HERE, "data", "dataset");
  const JOBS = JSON.parse(fs.readFileSync(paths.jobs ?? path.join(HERE, "provider-kit", "jobs.json"), "utf8"));
  const SERVICES_FILE = paths.services ?? path.join(HERE, "provider-kit", "services.json");
  const SERVICES = fs.existsSync(SERVICES_FILE) ? JSON.parse(fs.readFileSync(SERVICES_FILE, "utf8")) : {};
  const STATE_FILE = path.join(RUN, "pilot.json");
  const st = load();
  const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(st, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const providers = () => JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
  const provider = (id) => { const p = providers().find((x) => x.id === id); if (!p?.address || !p.curioUrl) throw new Error("this provider is not set up yet"); return p; };

  // Who is paying. With a key file this is fixed; with a wallet in the browser it is whichever account the
  // page connected, so it is read at the moment it is needed, never kept.
  const me = () => {
    const a = signer.address;
    if (!a) throw new Error("connect your wallet in the page first");
    return getAddress(a);
  };
  // Synapse insists on its own chain objects (asChain, synapse-core/chains), so the client it signs through is
  // built here, from this module's copy of the library, rather than handed in.
  const chain = NET.chain?.id === mainnet.id ? mainnet : calibration;
  const transport = fallback([http(NET.rpc), http(NET.rpcBackup ?? NET.rpc)], { retryCount: 2 });
  const signing = () => createWalletClient({ chain, account: signer.account(), transport });
  const mine = (x) => !x.client || getAddress(x.client) === me();

  // State: one entry per data set, each stamped with the wallet that owns it, so switching accounts in the
  // browser does not mix them up. (v1 kept a single data set per provider; migrate it.)
  function load() {
    const s = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { v: 2, sets: {}, jobs: {} };
    if (s.v === 2) return s;
    const sets = {};
    for (const [providerId, set] of Object.entries(s.sets ?? {}))
      sets[String(set.dataSetId)] = { provider: providerId, dataSetId: set.dataSetId, files: set.files ?? {}, label: "First data set" };
    return { v: 2, sets, jobs: s.jobs ?? {} };
  }
  // A provider taken out of the list must not take its data sets with it: point them at whichever entry holds
  // the data set now. Warm Storage knows who that is, so ask it rather than guess.
  let rehomed = false;
  async function rehomeSets() {
    if (rehomed) return;
    rehomed = true;
    const list = providers();
    let moved = false;
    for (const set of Object.values(st.sets)) {
      if (list.some((p) => p.id === set.provider)) continue;
      let addr = set.address;
      if (!addr) {
        const d = await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView, functionName: "getDataSet", args: [BigInt(set.dataSetId)] })
          .catch(() => null);
        if (!d) { rehomed = false; return; }
        addr = d.serviceProvider;
      }
      const same = list.find((p) => p.address && getAddress(p.address) === getAddress(addr));
      if (same) { set.provider = same.id; set.address = getAddress(addr); moved = true; say(`[client console] data set #${set.dataSetId} now listed under ${same.name}`); }
    }
    if (moved) save();
  }

  const getSet = (dataSetId) => {
    const s = st.sets[String(dataSetId)];
    if (!s || !mine(s)) throw new Error(`you have no data set #${dataSetId}`);
    return s;
  };

  // The demo program already holds the demo wallet's main data set: reuse it.
  const seed = demoDataSet?.();
  if (seed && !st.sets[String(seed.dataSetId)])
    st.sets[String(seed.dataSetId)] = { provider: "laptop", dataSetId: seed.dataSetId, files: seed.files, label: "First data set", client: signer.address };
  save();

  let task = null; // { title, steps: [{ text, done }], error, done, startedAt }
  async function run(title, fn) {
    if (task && !task.done) throw new Error("another action is still running");
    const mine = (task = { title, steps: [], done: false, startedAt: Date.now() });
    const step = (text) => {
      if (mine.abandoned) return;
      mine.steps.forEach((s) => (s.done = true));
      mine.steps.push({ text, done: false, at: Date.now() });
      say(`[client console] ${text}`);
    };
    fn(step).then(() => { if (mine.abandoned) return; mine.steps.forEach((s) => (s.done = true)); mine.done = true; },
      (e) => { if (mine.abandoned) return; mine.error = plain(e); mine.done = true; say(`[client console] failed: ${mine.error}`); });
  }

  // Contracts explain themselves to other contracts. Say the few common ones in words a person can act on.
  function plain(e) {
    const raw = e.shortMessage ?? e.message ?? String(e);
    if (/insufficient funds to cover lockup/i.test(raw))
      return `there is not enough ${NET.token} inside Filecoin Pay to hold this job's price. Move some across with the button at the top of the page, then try again.`;
    if (/OperatorLockupAllowanceExceeded|lockup allowance/i.test(raw))
      return `the budget you gave the compute service is used up. Ordering again renews it; if it keeps failing, tell me.`;
    if (/InsufficientLockupAllowance/i.test(raw))
      return `the budget you gave Warm Storage for storing data sets is used up. Creating the data set again renews it.`;
    if (/RPC Request failed|HTTP request failed|fetch failed/i.test(raw))
      return `the Filecoin node did not answer. Nothing was sent; try again.`;
    if (/Piece ID already scheduled for removal/i.test(raw))
      return `those pieces are already on their way out of the data set.`;
    return raw;
  }

  // The provider is taking too long and the client wants the page back. The work carries on in the background
  // (we cannot recall a signature already handed to a provider), but it no longer blocks anything here.
  function stopWaiting() {
    if (!task || task.done) return;
    task.abandoned = true;
    say(`[client console] stopped waiting for "${task.title}"; it may still finish at the provider`);
    task = { ...task, done: true, error: "you stopped waiting; the provider may still finish it, and the page will show the result if it does" };
  }
  async function send(address, abi, functionName, args) {
    // Public nodes drop requests now and then ("RPC Request failed"); the dry run and the gas estimate are
    // read-only, so just ask again before giving up. Only a real revert is reported to the page.
    const attempt = async (fn) => {
      for (let i = 1; ; i++) {
        try { return await fn(); }
        catch (e) {
          const transient = /RPC Request failed|HTTP request failed|timed out|fetch failed/i.test(e.shortMessage ?? e.message ?? "");
          if (!transient || i >= 4) throw e;
          say(`[client console] the node did not answer, trying again (${i})`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };
    const { request } = await attempt(() => pub.simulateContract({ account: me(), address, abi, functionName, args }));
    const gas = (await attempt(() => pub.estimateContractGas({ account: me(), address, abi, functionName, args }))) * 3n / 2n;
    // the dry run was done for an address, which viem turns into a "the node holds this account" account.
    // Public Filecoin nodes hold nothing and refuse eth_sendTransaction, so hand the signer the call and let
    // it use its own account: a key on this machine, or the wallet in the browser.
    const { account: _dryRunAccount, ...call } = request;
    const hash = await attempt(() => signer.submit({ ...call, gas }));
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

  // Any storage provider running Curio with PDP and the provider kit can be added here: the contract has no
  // list of allowed providers, it only requires that the provider is the one holding the client's data set.
  async function addProvider({ name, address, curioUrl, note }) {
    const url = String(curioUrl ?? "").trim().replace(/\/$/, "");
    const addr = getAddress(String(address ?? "").trim());
    if (!/^https?:\/\//.test(url)) throw new Error("the Curio URL should start with http:// or https://");
    const list = providers();
    if (list.some((p) => p.address && getAddress(p.address) === addr && p.curioUrl === url)) throw new Error("that provider is already in the list");
    const id = (String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `sp-${addr.slice(2, 8).toLowerCase()}`);
    const reachable = await fetch(`${url}/pdp/ping`, { signal: AbortSignal.timeout(6000) }).then((r) => r.ok, () => false);
    list.push({ id: list.some((p) => p.id === id) ? `${id}-${list.length}` : id, name: String(name ?? "").trim() || addr,
      address: addr, curioUrl: url, note: String(note ?? "").trim() || "Added from the console." });
    fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(list, null, 2) + "\n");
    say(`[client console] added provider ${id} (${addr}) at ${url}${reachable ? "" : " - its Curio did not answer just now"}`);
    return { reachable };
  }

  // ---------------------------------------------------------------- data sets

  // Creates a new data set at this provider. Either with the synthetic financial documents, or with files
  // the client dropped on the page. A data set is always created together with its first pieces.
  function createSet(id, { files, label, protect } = {}) {
    const p = provider(id);
    const chosen = files?.length
      ? decode(files)
      : (fs.existsSync(SAMPLES_DIR) ? fs.readdirSync(SAMPLES_DIR).filter((f) => DOC.test(f)).sort() : [])
        .map((f) => ({ name: f, bytes: new Uint8Array(fs.readFileSync(path.join(SAMPLES_DIR, f))) }));
    if (!chosen.length) throw new Error("no files to put in the data set: drop some files on the page");
    const name = label?.trim() || (files?.length ? `${chosen.length} file${chosen.length > 1 ? "s" : ""}` : "Sample financial documents");
    const client = me();
    return run(`Create a data set with ${p.name}`, async (step) => {
      // Warm Storage holds a reserve for every data set (Rails.sol L90: lockupAllowance >= lockupUsage + requiredLockup).
      // Each new data set eats into the budget the client gave Warm Storage, so top it up when it runs low.
      const [, rateAllowance, lockupAllowance, rateUsage, lockupUsage, maxLockupPeriod] = await pub.readContract({ address: C.payments,
        abi: ABI.FilecoinPayV1, functionName: "operatorApprovals", args: [C.usdfc, client, C.fwss] });
      if (lockupAllowance - lockupUsage < parseUnits("1", 18)) {
        step("Renewing your storage budget with Warm Storage (each data set holds a reserve; one block)");
        await send(C.payments, ABI.FilecoinPayV1, "setOperatorApproval",
          [C.usdfc, C.fwss, true, rateAllowance > rateUsage ? rateAllowance : rateUsage + parseUnits("0.1", 18),
            lockupUsage + parseUnits("2", 18), maxLockupPeriod || 1n << 40n]);
      }
      step(`Uploading ${chosen.length} file${chosen.length > 1 ? "s" : ""} to the provider's Curio`);
      const pieces = [];
      for (const f of chosen) pieces.push({ pieceCid: await upload(p, f.bytes), metadata: { name: f.name }, name: f.name });
      step("Creating your data set with the provider and adding the files (you sign, Curio submits; one block)");
      const created = await SP.createDataSetAndAddPieces(signing(), { serviceURL: p.curioUrl, payee: getAddress(p.address),
        pieces: pieces.map(({ pieceCid, metadata }) => ({ pieceCid, metadata })), cdn: false });
      const done = await SP.waitForCreateDataSetAddPieces({ statusUrl: created.statusUrl, timeout: 10 * 60_000 });
      const stored = Object.fromEntries(done.piecesIds.map((pid, i) => [String(pid), { name: pieces[i].name, cid: String(pieces[i].pieceCid), kind: "input", ...(protect ? { protected: true } : {}) }]));
      st.sets[String(done.dataSetId)] = { provider: id, address: getAddress(p.address), dataSetId: Number(done.dataSetId), files: stored, label: name, client, created: Date.now() };
      save();
      step(`Letting providers add job results to data set #${done.dataSetId}, only while you have a job open with them (one block)`);
      await send(C.fwss, FWSS_ABI, "setDataSetAuthorizer", [done.dataSetId, C.cs]);
    });
  }

  // A data set this wallet already has with this provider, made somewhere else (Synapse, filecoin-pin, an
  // earlier run). The chain is the source of truth: it says who pays for it, who holds it, and what is in it.
  function adoptSet(id, dataSetId) {
    const p = provider(id);
    const client = me();
    return run(`Look up data set #${dataSetId} at ${p.name}`, async (step) => {
      step("Reading the data set from Warm Storage: who pays for it and who holds it");
      const d = await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView, functionName: "getDataSet", args: [BigInt(dataSetId)] });
      if (!d?.payer || getAddress(d.payer) !== client) throw new Error(`data set #${dataSetId} is not paid for by your wallet`);
      if (getAddress(d.serviceProvider) !== getAddress(p.address) && getAddress(d.payee) !== getAddress(p.address))
        throw new Error(`data set #${dataSetId} is not held by ${p.name}`);
      step("Listing the pieces that are still live in it");
      const next = Number(await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "getNextPieceId", args: [BigInt(dataSetId)] }));
      const names = await pieceNames(dataSetId).catch(() => ({}));
      const files = {};
      for (let i = 0; i < next; i++) {
        if (!(await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "pieceLive", args: [BigInt(dataSetId), BigInt(i)] }))) continue;
        const raw = await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "getPieceCid", args: [BigInt(dataSetId), BigInt(i)] });
        files[String(i)] = { name: names[String(i)] ?? `piece-${i}`, cid: CID.decode(hexToBytes(raw.data)).toString(), kind: "input" };
      }
      const known = st.sets[String(dataSetId)];
      for (const [pid, f] of Object.entries(known?.files ?? {})) { // keep names, job results and marks we already have
        if (files[pid]) files[pid] = { ...f, cid: files[pid].cid };
        else files[pid] = { ...f, gone: true };
      }
      st.sets[String(dataSetId)] = { provider: id, address: getAddress(p.address), dataSetId: Number(dataSetId), files, client,
        label: known?.label ?? `Data set #${dataSetId}`, adopted: Date.now() };
      save();
      step(`Found ${Object.keys(files).length} live pieces. Letting providers add job results to it while you have a job open (one block)`);
      await send(C.fwss, FWSS_ABI, "setDataSetAuthorizer", [BigInt(dataSetId), C.cs]);
    });
  }

  // The names the client gave its pieces, from Warm Storage's PieceAdded events (the same lookup the provider kit does).
  const nameCache = {};
  async function pieceNames(dataSetId) {
    const key = String(dataSetId);
    if (nameCache[key]) return nameCache[key];
    if (!ABI.FilecoinWarmStorageService) return {};
    const head = Number(await pub.getBlockNumber());
    // Public Calibration nodes refuse an eth_getLogs range of more than a few hundred blocks, so ask in
    // steps of 100 and stop after a bounded number of them (about a day and a half of blocks).
    const STEP = 100, MAX_REQUESTS = 45;
    const names = {};
    for (let to = head, n = 0; n < MAX_REQUESTS; to -= STEP, n++) {
      const logs = await pub.getContractEvents({ address: C.fwss, abi: ABI.FilecoinWarmStorageService, eventName: "PieceAdded",
        args: { dataSetId: BigInt(dataSetId) }, fromBlock: BigInt(Math.max(0, to - STEP + 1)), toBlock: BigInt(to) }).catch(() => []);
      for (const ev of logs) {
        const i = ev.args.keys?.indexOf("name") ?? -1;
        if (i >= 0) names[String(ev.args.pieceId)] = ev.args.values[i];
      }
    }
    return (nameCache[key] = names);
  }

  function addFiles(dataSetId, files, protect = false) {
    const set = getSet(dataSetId), p = provider(set.provider);
    const chosen = decode(files ?? []);
    if (!chosen.length) throw new Error("no files to add");
    return run(`Add ${chosen.length} file${chosen.length > 1 ? "s" : ""} to data set #${dataSetId}`, async (step) => {
      step(`Uploading ${chosen.length > 1 ? "the files" : chosen[0].name} to the provider's Curio`);
      const pieces = [];
      for (const f of chosen) pieces.push({ pieceCid: await upload(p, f.bytes), metadata: { name: f.name }, name: f.name });
      step(`Adding ${chosen.length > 1 ? "them" : "it"} to your data set #${dataSetId} (you sign, Curio submits; one block)`);
      const r = await SP.addPieces(signing(), { serviceURL: p.curioUrl, dataSetId: BigInt(dataSetId), clientDataSetId: await clientDataSetId(dataSetId),
        pieces: pieces.map(({ pieceCid, metadata }) => ({ pieceCid, metadata })) });
      const done = await SP.waitForAddPieces({ statusUrl: r.statusUrl, timeout: 10 * 60_000 });
      done.confirmedPieceIds.forEach((pid, i) => (set.files[String(pid)] = { name: pieces[i].name, cid: String(pieces[i].pieceCid), kind: "input", ...(protect ? { protected: true } : {}) }));
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
      const r = await SP.schedulePieceDeletions(signing(), { serviceURL: p.curioUrl, dataSetId: BigInt(dataSetId),
        clientDataSetId: await clientDataSetId(dataSetId), pieceIds: ids });
      for (const id of ids) { set.files[String(id)].removing = true; set.files[String(id)].removeTx = r.hash; }
      save();
      step("Scheduled: PDP drops the pieces at the provider's next proving period, and you stop paying for them");
    });
  }

  // Files the client never wants cleared away, whatever policy a later job is ordered with. The contract only
  // ever grants what the client lists at order time, so keeping these out of that list is the whole mechanism.
  function protectFiles(dataSetId, pieceIds, on = true) {
    const set = getSet(dataSetId);
    for (const pid of pieceIds ?? []) {
      const f = set.files[String(pid)];
      if (!f) throw new Error(`piece #${pid} is not in this data set`);
      if (on) f.protected = true; else delete f.protected;
    }
    save();
    say(`[client console] ${on ? "protected" : "unprotected"} ${pieceIds.length} file(s) in data set #${dataSetId}`);
    return { ok: true };
  }

  // Taking a permission back, on chain, before the provider has used it (ComputeService.revokeRemoval).
  function revokeRemoval(dataSetId, pieceIds) {
    const set = getSet(dataSetId), p = provider(set.provider);
    const ids = (pieceIds ?? []).map((x) => BigInt(x));
    if (!ids.length) throw new Error("nothing to take back");
    return run(`Take back permission over ${ids.length} file${ids.length > 1 ? "s" : ""}`, async (step) => {
      step("Telling the contract the provider may no longer remove them (one block)");
      await send(C.cs, ABI.ComputeService, "revokeRemoval", [BigInt(dataSetId), getAddress(p.address), ids]);
      for (const id of ids) { const f = set.files[String(id)]; if (f) { delete f.removable; delete f.removableJob; f.protected = true; } }
      save();
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
    const keep = (pid) => !set.files[String(pid)]?.protected;
    if (policy === "replace-inputs") return inputs.filter(keep);
    if (policy === "replace-previous") {
      return Object.entries(set.files).filter(([pid, f]) => f.kind === "output" && !f.removing && keep(pid)).map(([pid]) => BigInt(pid));
    }
    return [];
  }

  // The job runs over the pieces the client names. With none named it takes every file of the client's own
  // in the data set that the program can read; the contract is given the list either way (postJob's inputPieceIds).
  function order(dataSetId, type, policy = "keep", pieceIds = null) {
    const set = getSet(dataSetId), p = provider(set.provider), spec = JOBS[type];
    if (!spec) throw new Error("unknown job type");
    const usable = ([pid, f]) => f.kind === "input" && !f.removing && !f.gone && f.name.endsWith(spec.inputExtension ?? "");
    let inputs;
    if (pieceIds?.length) {
      for (const pid of pieceIds) {
        const f = set.files[String(pid)];
        if (!f) throw new Error(`piece #${pid} is not in this data set`);
        if (f.gone || f.removing) throw new Error(`${f.name} is on its way out of the data set and cannot be used`);
        if (!f.name.endsWith(spec.inputExtension ?? "")) throw new Error(`${f.name} is not a ${spec.inputExtension} file, which is what this job reads`);
      }
      inputs = pieceIds.map((x) => BigInt(x));
    } else {
      inputs = Object.entries(set.files).filter(usable).map(([pid]) => BigInt(pid));
    }
    if (!inputs.length) throw new Error(`no ${spec.inputExtension} files in this data set for this job`);
    const price = parseUnits(spec.price ?? "0.5", 18);
    const removals = removalsFor(policy, set, inputs);
    const client = me();
    return run(`Order "${spec.name}" from ${p.name}`, async (step) => {
      // Filecoin Pay refuses the job with "insufficient funds to cover lockup", which says nothing useful to
      // someone looking at a wallet full of tokens: the money has to be inside Filecoin Pay, not in the wallet.
      const [, , available] = await pub.readContract({ address: C.payments, abi: ABI.FilecoinPayV1, functionName: "getAccountInfoIfSettled", args: [C.usdfc, client] });
      if (available < price) {
        const held = await pub.readContract({ address: C.usdfc, abi: ERC20_ABI, functionName: "balanceOf", args: [client] }).catch(() => 0n);
        throw new Error(`this job costs ${formatUnits(price, 18)} ${NET.token} and only ${Number(formatUnits(available, 18)).toFixed(3)} is in Filecoin Pay`
          + (held > 0n ? `. Your wallet holds ${Number(formatUnits(held, 18)).toFixed(3)} ${NET.token}: move some across with the button at the top of the page, then order again.`
            : `, and your wallet is empty too. Get test ${NET.token} from the faucet, then move it into Filecoin Pay.`));
      }
      const [, rateAllowance, lockupAllowance, , lockupUsage, maxLockupPeriod] = await pub.readContract({ address: C.payments, abi: ABI.FilecoinPayV1,
        functionName: "operatorApprovals", args: [C.usdfc, client, C.cs] });
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
      st.jobs[String(posted.jobId)] = { contract: C.cs, client, provider: set.provider, type, policy, dataSetId: set.dataSetId, inputs: inputs.length,
        chosen: pieceIds?.length ? pieceIds.map(String) : null,
        price: spec.price ?? "0.5", deadline: String(deadline), fromBlock: String(r.blockNumber), postTx: r.transactionHash };
      save();
    });
  }

  // Moving money from the wallet into Filecoin Pay, which is where jobs are paid from. Two steps, as with any
  // ERC-20: let Filecoin Pay take the amount, then deposit it.
  function deposit(amount) {
    const value = parseUnits(String(amount), 18);
    if (value <= 0n) throw new Error("nothing to add");
    const client = me();
    return run(`Add ${amount} ${NET.token} to Filecoin Pay`, async (step) => {
      const held = await pub.readContract({ address: C.usdfc, abi: ERC20_ABI, functionName: "balanceOf", args: [client] });
      if (held < value)
        throw new Error(`your wallet holds ${formatUnits(held, 18)} ${NET.token}, less than the ${amount} you asked for. Get free test tokens from the faucet, then try again.`);
      step(`Letting Filecoin Pay take ${amount} ${NET.token} from your wallet (one block)`);
      await send(C.usdfc, ERC20_ABI, "approve", [C.payments, value]);
      step(`Depositing it into Filecoin Pay (one block)`);
      await send(C.payments, ABI.FilecoinPayV1, "deposit", [C.usdfc, client, value]);
    });
  }

  // ---------------------------------------------------------------- pay for time
  //
  // The other way to buy: instead of a price for a result, a rate per epoch for a service that runs next to the
  // data. The client opens the session, the provider starts the service and says it is ready - which is when the
  // meter starts - and either side can close it. Closing stops the charge at that epoch.

  const LOCKUP_EPOCHS = 60; // half an hour of Calibration epochs held as the provider's safety margin

  function openSession(dataSetId, type) {
    const set = getSet(dataSetId), p = provider(set.provider), spec = SERVICES[type];
    if (!spec) throw new Error("unknown service");
    const rate = parseUnits(spec.rate ?? "0.01", 18);
    const needed = rate * BigInt(LOCKUP_EPOCHS);
    const client = me();
    return run(`Start "${spec.name}" at ${p.name}`, async (step) => {
      const [, , available] = await pub.readContract({ address: C.payments, abi: ABI.FilecoinPayV1, functionName: "getAccountInfoIfSettled", args: [C.usdfc, client] });
      if (available < needed)
        throw new Error(`the provider holds ${formatUnits(needed, 18)} ${NET.token} as a safety margin while this runs, and only `
          + `${Number(formatUnits(available, 18)).toFixed(3)} is in Filecoin Pay. Move some across with the button at the top of the page, then try again.`);
      const [, rateAllowance, lockupAllowance, rateUsage, lockupUsage, maxLockupPeriod] = await pub.readContract({ address: C.payments,
        abi: ABI.FilecoinPayV1, functionName: "operatorApprovals", args: [C.usdfc, client, C.cs] });
      if (rateAllowance - rateUsage < rate || lockupAllowance - lockupUsage < needed || maxLockupPeriod < BigInt(LOCKUP_EPOCHS)) {
        step("Renewing your budget for the compute service (one block)");
        await send(C.payments, ABI.FilecoinPayV1, "setOperatorApproval",
          [C.usdfc, C.cs, true, rateUsage + rate * 4n, lockupUsage + needed * 4n, BigInt(Math.max(Number(maxLockupPeriod), LOCKUP_EPOCHS * 4))]);
      }
      step(`Opening the session: ${formatUnits(rate, 18)} ${NET.token} per epoch, charged only once the provider says the service is running (one block)`);
      const r = await send(C.cs, ABI.ComputeService, "openSession",
        [getAddress(p.address), keccak256(toHex(type)), rate, BigInt(LOCKUP_EPOCHS), BigInt(set.dataSetId)]);
      let opened = null;
      for (const log of r.logs) {
        try {
          const ev = decodeEventLog({ abi: ABI.ComputeService, data: log.data, topics: log.topics });
          if (ev.eventName === "SessionOpened") opened = ev.args;
        } catch { /* other contracts' events */ }
      }
      if (!opened) throw new Error("the session went on-chain but its id could not be read");
      st.sessions ??= {};
      st.sessions[String(opened.sessionId)] = { contract: C.cs, client, provider: set.provider, type, dataSetId: set.dataSetId,
        rate: spec.rate ?? "0.01", name: spec.name, openTx: r.transactionHash, fromBlock: String(r.blockNumber) };
      save();
      step("Waiting for the provider to start the service; nothing is charged until it does");
    });
  }

  function closeSession(sessionId) {
    const x = st.sessions?.[String(sessionId)];
    if (!x || !mine(x)) throw new Error("unknown session");
    return run(`Stop session #${sessionId}`, async (step) => {
      step("Closing the session: the service is shut down and the charge stops at this epoch (one block)");
      const r = await send(C.cs, ABI.ComputeService, "closeSession", [BigInt(sessionId)]);
      x.closeTx = r.transactionHash; save();
    });
  }

  const SESSION_STATUS = ["none", "waiting for the provider", "running", "closed"];

  async function sessionStatus(id, x) {
    const s = await pub.readContract({ address: C.cs, abi: ABI.ComputeService, functionName: "sessions", args: [BigInt(id)] });
    const status = SESSION_STATUS[Number(s[7])] ?? "unknown";
    if (!x.readyBlock && Number(s[7]) >= 2) {
      const ready = await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, eventName: "SessionReady",
        fromBlock: BigInt(x.fromBlock), args: { sessionId: BigInt(id) } }).catch(() => []);
      if (ready[0]) { x.readyBlock = Number(ready[0].args.epoch); save(); }
    }
    if (Number(s[7]) === 3 && !x.stopBlock) {
      const closed = await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, eventName: "SessionClosed",
        fromBlock: BigInt(x.fromBlock), args: { sessionId: BigInt(id) } }).catch(() => []);
      if (closed[0]) { x.stopBlock = Number(closed[0].blockNumber); x.rateStopped = closed[0].args.rateStoppedAtClose; save(); }
    }
    const head = Number(await pub.getBlockNumber());
    const until = x.stopBlock ?? head;
    const epochs = x.readyBlock ? Math.max(0, until - x.readyBlock) : 0;
    return { ...x, status, epochs, spent: (Number(x.rate) * epochs).toFixed(4) };
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
          if ((j.policy === "replace-inputs" && f.kind === "input") || (j.policy === "replace-previous" && f.kind === "output" && !outputs.some((o) => o.pieceId === pid))) {
            f.removable = true;
            f.removableJob = String(jobId);
          }
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
    for (const [id, x] of Object.entries(st.sessions ?? {})) { // same for sessions: an earlier contract's are not ours
      if (x.contract && x.contract !== C.cs) { delete st.sessions[id]; say(`[client console] session #${id} belonged to an earlier contract; removed from the list`); }
    }
    for (const [id, j] of Object.entries(st.jobs)) {
      if (j.contract === C.cs) continue;
      const c = await pub.readContract({ address: C.cs, abi: ABI.ComputeService, functionName: "jobs", args: [BigInt(id)] }).catch(() => null);
      if (!c) { pruned = false; return; } // the node is unhappy: try again next time
      if (Number(c[5]) === Number(j.dataSetId) && st.sets[String(j.dataSetId)]) { j.contract = C.cs; j.client ??= getAddress(c[0]); }
      else { delete st.jobs[id]; say(`[client console] job #${id} belonged to an earlier contract; removed from the list`); }
    }
    save();
  }

  async function findLostJobs() {
    const head = await pub.getBlockNumber();
    const from = head > 2000n ? head - 2000n : 0n;
    const logs = await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, eventName: "JobPosted",
      args: { client: me() }, fromBlock: from, toBlock: head }).catch(() => []);
    for (const l of logs) {
      const id = String(l.args.jobId);
      if (st.jobs[id]) continue;
      const set = st.sets[String(l.args.dataSetId)];
      if (!set) continue;
      st.jobs[id] = { contract: C.cs, client: me(), provider: set.provider, type: Object.keys(JOBS).find((t) => keccak256(toHex(t)) === l.args.imageDigest) ?? "unknown",
        dataSetId: Number(l.args.dataSetId), inputs: l.args.inputPieceIds.length, price: formatUnits(l.args.price, 18),
        deadline: String(l.args.deadline), fromBlock: String(l.blockNumber), postTx: l.transactionHash };
      say(`[client console] found job #${id} ordered earlier from ${providers().find((p) => p.id === set.provider)?.name ?? set.provider}`);
    }
    save();
  }

  async function state() {
    const connected = !!signer.address;
    const base = { signer: signer.mode, client: signer.address ?? null, token: NET.token, explorer: NET.explorer,
      chainId: NET.chain.id, task, jobTypes: Object.entries(JOBS).map(([type, j]) => ({ type, name: j.name, price: j.price ?? "0.5", inputExtension: j.inputExtension })),
      services: Object.entries(SERVICES).map(([type, x]) => ({ type, name: x.name, rate: x.rate ?? "0.01", note: x.note ?? "" })),
      policies: [{ id: "keep", label: "Keep everything (default)" },
        { id: "replace-previous", label: "Keep only the newest result: the provider may remove earlier results" },
        { id: "replace-inputs", label: "Replace the originals: the provider may remove the files it read" }] };
    if (!connected) return { ...base, providers: [], jobs: [], available: "0", block: null };
    await rehomeSets().catch(() => { rehomed = false; });
    await pruneStaleJobs().catch(() => {});
    await findLostJobs().catch(() => {});
    const ps = await Promise.all(providers().map(async (p) => {
      const ready = !!(p.address && p.curioUrl);
      const reachable = ready ? await fetch(`${p.curioUrl}/pdp/ping`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false) : false;
      const sets = Object.values(st.sets).filter((s) => s.provider === p.id && mine(s)).sort((a, b) => a.dataSetId - b.dataSetId);
      for (const set of sets) await refreshRemovable(set, p).catch(() => {});
      return { ...p, ready, reachable, sets };
    }));
    const jobs = [];
    for (const [id, j] of Object.entries(st.jobs).filter(([, j]) => mine(j)).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 20))
      jobs.push({ id, ...(await jobStatus(id, j).catch(() => j)), name: JOBS[j.type]?.name });
    // a piece that a job delivered is a result, however the data set was rebuilt since
    for (const j of jobs) {
      const set = st.sets[String(j.dataSetId)];
      for (const o of j.outputs ?? []) {
        const f = set?.files?.[o.pieceId];
        if (f && f.kind !== "output") { f.kind = "output"; f.name = `${o.name} (job #${j.id})`; save(); }
      }
    }
    const [, , available] = await pub.readContract({ address: C.payments, abi: ABI.FilecoinPayV1, functionName: "getAccountInfoIfSettled", args: [C.usdfc, me()] });
    const wallet = await pub.readContract({ address: C.usdfc, abi: ERC20_ABI, functionName: "balanceOf", args: [me()] }).catch(() => 0n);
    const gas = await pub.getBalance({ address: me() }).catch(() => 0n);
    const sessions = [];
    for (const [id, x] of Object.entries(st.sessions ?? {}).filter(([, x]) => mine(x)).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 10))
      sessions.push({ id, ...(await sessionStatus(id, x).catch(() => x)) });
    return { ...base, available: formatUnits(available, 18), wallet: formatUnits(wallet, 18), gas: formatUnits(gas, 18),
      faucets: FAUCETS, block: Number(await pub.getBlockNumber()), providers: ps, jobs, sessions };
  }

  // A piece the client allowed the provider to remove is in one of three states: the permission is still
  // unused, the provider has used it and PDP will drop the piece at the next proving period, or it is gone.
  // The chain knows which, so ask it rather than leaving a stale warning on the page.
  async function refreshRemovable(set, p) {
    for (const [pid, f] of Object.entries(set.files)) {
      if (!f.removable || f.removing) continue;
      const still = await pub.readContract({ address: C.cs, abi: ABI.ComputeService, functionName: "mayRemove",
        args: [BigInt(set.dataSetId), getAddress(p.address), BigInt(pid)] });
      if (still) continue;
      delete f.removable;
      const live = await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "pieceLive", args: [BigInt(set.dataSetId), BigInt(pid)] });
      if (live) f.removing = true; else f.gone = true;
      save();
    }
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
    if (!j || !mine(j)) throw new Error("unknown job");
    return run(`Get your money back for job #${jobId}`, async (step) => {
      step("The deadline passed with no result: cancelling the job releases the price (one block)");
      const r = await send(C.cs, ABI.ComputeService, "expire", [BigInt(jobId)]);
      j.status = "expired"; j.expireTx = r.transactionHash; save();
    });
  }

  return { state, createSet, adoptSet, addFiles, removeFiles, protectFiles, revokeRemoval, order, file, expire, deposit, addProvider, stopWaiting, openSession, closeSession };
}
