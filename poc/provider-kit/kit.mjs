// PieceWork provider kit: lets a storage provider that runs Curio (with PDP) sell compute over the data sets it
// already stores, paid through Filecoin Pay via ComputeService.
//
//   node kit.mjs --config kit.config.json
//
// What it does, in a loop:
//   1. watches ComputeService for jobs addressed to this provider (JobPosted events);
//   2. reads the job's input pieces from the provider's own Curio: GET <curio>/piece/<pieceCid>;
//   3. runs the job's container image with Docker, no network, inputs read-only (/in), results in /out;
//   4. stores the results through Curio's PDP API (upload, then add to the client's data set). The add is
//      signed with the provider's key; Warm Storage accepts it because the client made ComputeService the
//      data set's authorizer, and ComputeService allows it only while the client has a job open with this provider;
//   5. calls ComputeService.commitOutputs: the contract checks the results are new, live and on time, and pays.
//
// The provider key is the address the provider is registered with (the one Curio uses for PDP): ComputeService
// only pays, and only accepts results from, the provider that holds the client's data set. The key is read from
// a file on this machine and never leaves it.

import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, http, fallback, keccak256, toHex, hexToBytes, encodeAbiParameters, encodePacked, decodeEventLog,
  getAddress, formatUnits, concat, hashDomain,
} from "viem";
import { parseGpu, whyNotRunnable, whyProverMismatched } from "./capability.mjs";

const EIP712_DOMAIN = [{ name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }];
import { filecoinCalibration, filecoin } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { CID } from "multiformats/cid";
import * as Piece from "@filoz/synapse-core/piece";
import { EIP712Types } from "@filoz/synapse-core/typed-data";
import * as SP from "@filoz/synapse-core/sp";

const execFile = promisify(execFileCb);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ABI = JSON.parse(fs.readFileSync(path.join(HERE, "abi.json"), "utf8"));
const JOBS = JSON.parse(fs.readFileSync(path.join(HERE, "jobs.json"), "utf8"));
// poc/, mounted read-only into the prover so it can reach zk/sp1. The guest's ELF is compiled into the host
// binary, so nothing is read from the repo at run time; this is for the binary itself.
const PROVER_REPO = path.resolve(HERE, "..");
// Named volume holding SP1's Groth16 circuit: 9.4 GB, fetched once, reused by every proof after.
const PROVER_CACHE = "piecework-sp1";
// A proved job is found by its verification key, because that is what the client puts on chain as the
// imageDigest and what the chain's verifier checks the proof against. Everything else is still keccak256 of
// the image name — a label the provider could quietly change what runs behind, which is exactly the
// weakness the proved path does not have.
const BY_DIGEST = Object.fromEntries(Object.entries(JOBS).map(([name, j]) =>
  [(j.vkey ?? keccak256(toHex(name))).toLowerCase(), name]));
// Services sold by the epoch rather than by the job: the client opens a session, this kit starts the service
// next to the client's data and says it is ready, which is when the meter starts.
const SERVICES = fs.existsSync(path.join(HERE, "services.json")) ? JSON.parse(fs.readFileSync(path.join(HERE, "services.json"), "utf8")) : {};
const SERVICE_BY_DIGEST = Object.fromEntries(Object.keys(SERVICES).map((name) => [keccak256(toHex(name)), name]));

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const cfg = JSON.parse(fs.readFileSync(arg("--config") ?? path.join(HERE, "kit.config.json"), "utf8"));
const chain = cfg.network === "mainnet" ? filecoin : filecoinCalibration;
const LOG = []; // recent lines, for the dashboard
const say = (...a) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${a.join(" ")}`;
  console.log(line); LOG.push(line); if (LOG.length > 200) LOG.shift();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const account = privateKeyToAccount(fs.readFileSync(cfg.providerKeyFile.replace(/^~/, os.homedir()), "utf8").trim());
const transport = fallback(cfg.rpc.map((u) => http(u)), { retryCount: 2 });
const pub = createPublicClient({ chain, transport, pollingInterval: 4000 });
const wallet = createWalletClient({ chain, transport, account });
const WORK = (cfg.workDir ?? "~/.piecework-kit").replace(/^~/, os.homedir());
const STATE = path.join(WORK, "state.json");
fs.mkdirSync(WORK, { recursive: true });
let state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { lastBlock: 0, jobs: {} };
// Job and session numbers start again from 1 in a new ComputeService, so what we remember about the old one
// would hide the new work. Start clean whenever the contract we are pointed at changes.
if (state.computeService && state.computeService !== cfg.contracts.computeService) {
  console.log(`ComputeService changed to ${cfg.contracts.computeService}; forgetting the jobs and sessions of ${state.computeService}.`);
  state = { lastBlock: 0, jobs: {}, sessions: {} };
}
state.computeService = cfg.contracts.computeService;
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
async function send(address, abi, functionName, args) {
  const { request } = await pub.simulateContract({ account, address, abi, functionName, args });
  const gas = (await pub.estimateContractGas({ account, address, abi, functionName, args })) * 3n / 2n;
  const hash = await wallet.writeContract({ ...request, gas });
  for (let attempt = 1; ; attempt++) { // public nodes sometimes fail a request: the transaction is already sent
    try { return await pub.waitForTransactionReceipt({ hash, timeout: 600_000 }); }
    catch (e) { if (attempt >= 6) throw e; await sleep(5000); }
  }
}

// ---------------------------------------------------------------- Curio (the provider's own PDP service)

const curio = cfg.curioUrl.replace(/\/$/, "");

async function fetchPiece(pieceCid) {
  const res = await fetch(`${curio}/piece/${pieceCid}`);
  if (!res.ok) throw new Error(`Curio has no piece ${pieceCid} (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/// The names the client gave the pieces of a data set, from Warm Storage's PieceAdded events (one scan per job,
/// over recent blocks). Pieces stored without a name simply have none.
const nameCache = {};
async function pieceNames(dataSetId, fresh = false, want = null) {
  const key = String(dataSetId);
  // A job looks the names up once and finishes, so caching them is free. A live service runs for hours over a
  // data set the client keeps adding to: a cached answer has no name for anything that arrives after it was
  // built, the extension filter then rejects every new file, and the service quietly does nothing for as long
  // as it is being paid. Callers that run in a loop ask for a fresh lookup.
  if (fresh) delete nameCache[key];
  if (nameCache[key]) return nameCache[key];
  const head = Number(await pub.getBlockNumber());
  // Public Calibration nodes refuse an eth_getLogs range of more than a few hundred blocks: ask in steps of 100.
  // (With 2000 every request was refused and the client's file names were silently lost.)
  const step = cfg.nameLookbackStep ?? 100;
  const requests = cfg.nameLookbackRequests ?? 45;
  const names = {};
  // Forty-five steps is about thirty-seven hours, which is fine for a data set in use today and wrong for one
  // filled last week. A piece whose name has scrolled out of range is handed to the job as "piece-11", the
  // extension filter rejects it, and the client pays for work over files the provider never passed in. So
  // when the caller says which pieces it needs, keep looking until they are all named — bounded, because a
  // piece added without name metadata can never be found however far back one goes.
  const missing = () => !want || want.some((id) => names[String(id)] === undefined);
  const deepest = cfg.nameLookbackDeep ?? 400; // ~40k blocks, a fortnight, and only reached while something is unnamed
  const limit = want ? deepest : requests;
  for (let to = head, n = 0; n < limit && to > 0; to -= step, n++) {
    if (n >= requests && !missing()) break;
    const logs = await pub.getContractEvents({ address: cfg.contracts.fwss, abi: ABI.FWSS, eventName: "PieceAdded",
      args: { dataSetId }, fromBlock: BigInt(Math.max(0, to - step + 1)), toBlock: BigInt(to) }).catch(() => []);
    for (const ev of logs) {
      const i = ev.args.keys.indexOf("name");
      if (i >= 0) names[String(ev.args.pieceId)] = ev.args.values[i];
    }
  }
  return (nameCache[key] = names);
}

/// Adds result files to the client's data set through Curio, signed by this provider. Returns their piece ids.
async function storeResults(dataSetId, clientDataSetId, files) {
  const cids = [];
  for (const f of files) {
    const cid = await Piece.calculate(f.bytes);
    await SP.uploadPiece({ serviceURL: curio, data: f.bytes, pieceCid: cid });
    cids.push(cid);
  }
  const nonce = BigInt(toHex(crypto.randomBytes(31)));
  const signature = await account.signTypedData({
    domain: { name: "FilecoinWarmStorageService", version: "1", chainId: chain.id, verifyingContract: getAddress(cfg.contracts.fwss) },
    types: EIP712Types, primaryType: "AddPieces",
    message: { clientDataSetId, nonce, pieceData: cids.map((c) => ({ data: toHex(c.bytes) })),
      pieceMetadata: files.map((f, i) => ({ pieceIndex: BigInt(i), metadata: [{ key: "name", value: f.name }] })) },
  });
  const extraData = encodeAbiParameters([{ type: "uint256" }, { type: "string[][]" }, { type: "string[][]" }, { type: "bytes" }],
    [nonce, files.map(() => ["name"]), files.map((f) => [f.name]), signature]);
  const { statusUrl, txHash } = await SP.addPiecesApiRequest({ serviceURL: curio, dataSetId, pieces: cids, extraData });
  say(`  Curio submitted addPieces ${txHash}; waiting for confirmation…`);
  const done = await SP.waitForAddPieces({ statusUrl, timeout: 900_000 });
  return { pieceIds: done.confirmedPieceIds.map(BigInt), tx: done.confirmedTxHash ?? txHash, cids: cids.map(String) };
}

// ---------------------------------------------------------------- jobs

async function runJob(ev) {
  const { jobId, client, dataSetId, imageDigest, inputPieceIds, deadline } = ev;
  const key = String(jobId);
  if (state.jobs[key]?.done) return;
  if (state.jobs[key]?.stage === "storing" || state.jobs[key]?.stage === "committing") return; // do not run twice
  const job = await read(cfg.contracts.computeService, ABI.ComputeService, "jobs", [jobId]);
  if (Number(job[8]) !== 1) { state.jobs[key] = { done: true }; save(); return; } // already paid or expired
  const now = () => new Date().toISOString();

  // A digest this kit does not recognise is a client bringing its own program. That is what the contract has
  // always allowed — it stores the digest and never reads it — and what this kit refused for want of a policy.
  // The policy is here: no network, the client's files read-only, a ceiling on what the program may consume,
  // and a price the provider is willing to accept for that ceiling. What the program is remains unknown and
  // does not need to be known: it cannot reach the network, and it can only write into a folder we collect.
  let spec = JOBS[BY_DIGEST[imageDigest.toLowerCase()]];
  const byo = cfg.bringYourOwnJob;
  if (!spec) {
    if (!byo?.enabled) return say(`Job #${jobId}: unknown program ${imageDigest.slice(0, 12)}…, and I only run my own catalogue.`);
    const price = Number(formatUnits(job[3], 18));
    const floor = Number(byo.minPrice ?? 0);
    if (price < floor) {
      return say(`Job #${jobId}: a program I do not know, offered at ${price} — I run those at ${floor} or more.`);
    }
    spec = { name: "a program the client brought", byo: true, seconds: byo.maxSeconds ?? 600,
      cpus: String(byo.cpus ?? 2), memory: String(byo.memory ?? "4g") };
  }

  // Can this machine actually run it? Checked here, before accepting, rather than discovered by failing.
  //
  // A job marked gpu:true was accepted by any provider and then died inside `docker run --gpus` with a
  // daemon error, after the client had already waited; one needing more VRAM than the card has died later
  // still, somewhere inside the model. Both now cost seconds and say why.
  //
  // This is also what makes "only a provider with a card can take this" a real category instead of a label.
  // Nothing a GPU computes is beyond a CPU -- the difference is always throughput -- so a GPU-only job is
  // one whose requirement is written down and checked. VRAM is the honest requirement to write down,
  // because a model that does not fit does not run at all, where "slower" merely misses a deadline.
  const cannotRun = whyNotRunnable(spec, await gpuInfo());
  if (cannotRun) return say(`Job #${jobId}: "${spec.name}" ${cannotRun}`);

  // And does my prover still agree with my catalogue? Asked before the ten minutes, not after.
  if (spec.prove) {
    say(`Job #${jobId}: checking my prover's key against the catalogue before starting…`);
    const mismatch = whyProverMismatched(spec, await proverVkey(spec));
    if (mismatch) return say(`Job #${jobId}: "${spec.name}" ${mismatch}`);
  }

  // A retry must resume, not start again. Delivery and payment are two transactions, and the second one can
  // fail on its own — a dropped RPC request is enough. The results are already in the client's data set by
  // then; running the program a second time re-does the work at the provider's expense, adds a second copy
  // the client pays to store, and leaves the first copy orphaned. If we already know the output pieces and
  // they are still live, the only thing left to do is claim the money.
  const prior = state.jobs[key];
  if (prior?.outputs?.length) {
    const ids = prior.outputs.map((o) => BigInt(o.pieceId));
    const live = await Promise.all(ids.map((id) =>
      read(cfg.contracts.pdp, ABI.PDPVerifier, "pieceLive", [BigInt(dataSetId), id]).catch(() => false)));
    if (live.every(Boolean)) {
      say(`Job #${jobId}: the results are already in the data set as pieces #${ids.join(", #")}; claiming payment `
        + `without running the program again.`);
      prior.stage = "committing"; save();
      // A proved job must carry its proof here too. The whole point of resuming is not to redo work the
      // provider has already paid for, and for this job that work is eight minutes of proving — so the
      // proof is read back from the job directory rather than regenerated. Claiming without it would be
      // refused by the verifier, which looks identical to a bad proof.
      const pr = spec.prove ? JSON.parse(fs.readFileSync(path.join(WORK, `job-${jobId}`, "proof.json"), "utf8")) : null;
      const r = pr
        ? await send(cfg.contracts.computeService, ABI.ComputeService, "commitOutputs",
            [jobId, ids, encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [pr.publicValues, pr.proofBytes])])
        : await send(cfg.contracts.computeService, ABI.ComputeService, "commitOutputs", [jobId, ids]);
      prior.stage = "paid"; prior.t = { ...prior.t, paid: now() }; prior.done = true; prior.commitTx = r.transactionHash; save();
      say(`Job #${jobId}: committed and paid (tx ${r.transactionHash}).`);
      const { clientDataSetId } = await read(cfg.contracts.view, ABI.View, "getDataSet", [BigInt(dataSetId)]);
      await afterCommit(jobId, dataSetId, clientDataSetId, r);
      return;
    }
    say(`Job #${jobId}: the earlier results are no longer in the data set; running it again.`);
  }

  const J = (state.jobs[key] = { id: key, name: spec.name, client, dataSetId: String(dataSetId), stage: "fetching",
    price: formatUnits(job[3], 18), deadline: String(deadline), inputs: inputPieceIds.length, t: { received: now() } });
  save();
  say(`Job #${jobId}: "${spec.name}" for ${client}, data set #${dataSetId}, deadline block ${deadline}.`);
  const dir = path.join(WORK, `job-${jobId}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "in"), { recursive: true });
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  const names = await pieceNames(dataSetId, false, inputPieceIds.map(String)).catch(() => ({}));
  const inputFiles = []; // in inputPieceIds order: a proved job's commitment depends on it
  for (const id of inputPieceIds) { // the client's files, as stored on this provider, under the names the client gave them
    const c = await read(cfg.contracts.pdp, ABI.PDPVerifier, "getPieceCid", [dataSetId, id]);
    const pieceCid = CID.decode(hexToBytes(c.data)).toString();
    const given = names[String(id)];
    const ext = spec.inputExtensions?.[0] ?? spec.inputExtension ?? "";
    const safe = given && /^[\w .()-]{1,80}$/.test(given) ? given : `piece-${id}${ext}`;
    const file = fs.existsSync(path.join(dir, "in", safe)) ? `${id}-${safe}` : safe;
    fs.writeFileSync(path.join(dir, "in", file), await fetchPiece(pieceCid));
    inputFiles.push(file);
  }
  J.inputBytes = fs.readdirSync(path.join(dir, "in")).reduce((n, f) => n + fs.statSync(path.join(dir, "in", f)).size, 0);
  J.stage = "running"; J.t.running = now(); save();
  const t0 = Date.now();
  if (spec.byo) {
    const want = `sha256:${imageDigest.slice(2)}`;
    // The simplest way to hand a provider a program is the way the client already hands it everything else:
    // as a piece in its own data set. `docker save` writes the image to a tar, the tar goes in with the files,
    // and nothing needs a registry — no account anywhere, nothing public, nothing to keep alive. Loading it
    // proves itself: if the tar does not contain the image the chain pinned, the id is not there afterwards.
    const tarFile = fs.readdirSync(path.join(dir, "in")).find((f) => /\.tar$/i.test(f));
    if (tarFile) {
      const at = path.join(dir, "in", tarFile);
      say(`Job #${jobId}: the client brought its own program as a file, ${tarFile} (${(fs.statSync(at).size / 1e6).toFixed(1)} MB). Loading it.`);
      await execFile("docker", ["load", "-i", at], { maxBuffer: 1 << 28 });
      await execFile("docker", ["inspect", "--format", "{{.Id}}", want]).catch(() => {
        throw new Error(`${tarFile} does not contain ${want.slice(0, 19)}…, which is the program the client named on chain`);
      });
      fs.rmSync(at); // the program is not one of its own inputs
      spec.dockerImage = want;
      J.image = want; save();
      say(`Job #${jobId}: loaded, and it is the program the chain pinned. Running it with no network, `
        + `${spec.cpus} cores, ${spec.memory} of memory and ${spec.seconds} s.`);
    } else {
    // Otherwise the client named a registry. A digest says what to run, not where to find it, and the contract
    // has no room for a repository name, so the client puts one in a piece listed among the job's inputs.
    // Docker then checks the pulled image against the digest the chain recorded: a spec naming a hostile
    // repository cannot substitute different code, because the chain pinned the code.
    const specFile = fs.readdirSync(path.join(dir, "in")).find((f) => /^job-spec.*\.json$/i.test(f));
    if (!specFile) throw new Error("a program I do not know, and neither a .tar of it nor a job-spec.json saying where to find it");
    const wanted = JSON.parse(fs.readFileSync(path.join(dir, "in", specFile), "utf8"));
    if (typeof wanted.image !== "string" || !/^[\w.\-]+(:\d+)?(\/[\w.\-]+)+$/.test(wanted.image)) {
      throw new Error(`job-spec.json does not name a repository I can pull from`);
    }
    spec.dockerImage = `${wanted.image}@sha256:${imageDigest.slice(2)}`;
    J.image = spec.dockerImage; save();
    say(`Job #${jobId}: the client brought its own program, ${spec.dockerImage}. Pulling it.`);
    await execFile("docker", ["pull", "--quiet", spec.dockerImage], { maxBuffer: 1 << 26 });
    say(`Job #${jobId}: pulled, and the digest matches what the client put on chain. Running it with no network, `
      + `${spec.cpus} cores, ${spec.memory} of memory and ${spec.seconds} s.`);
    }
  }
  // Docker has no run timeout of its own: killing the client would leave the container running. Name it, and
  // remove it by force when the time is up.
  // A job that asks for a GPU gets every GPU the machine has. Sealing rigs already own cards that sit idle
  // between proofs, and the jobs that fit them are exactly the ones where moving the data costs more than
  // doing the work. Needs the nvidia container toolkit on the provider; without it docker refuses and the
  // job fails honestly rather than running a hundred times slower on the CPU without saying so.
  const gpu = spec.gpu ? ["--gpus", String(cfg.gpus ?? "all")] : [];
  const mounts = ["--network", "none", ...gpu, "-v", `${dir}/in:/in:ro`, "-v", `${dir}/out:/out`];
  await slot(`Job #${jobId}`);
  try {
    if (spec.byo) {
      await runBounded(`piecework-job-${jobId}`,
        [...mounts, "--cpus", spec.cpus, "--memory", spec.memory, "--pids-limit", "512", spec.dockerImage],
        spec.seconds);
    } else if (spec.prove) {
      // The repo goes in read-only — the guest's ELF is compiled into the binary, so nothing is read from
      // it at run time — and /root/.sp1 is a named volume holding the Groth16 circuit. With that cached the
      // run needs no network, so --network none still holds for a job that produces a proof.
      say(`Job #${jobId}: this one has to be proved. Running the zkVM guest and wrapping the result in a `
        + `Groth16 proof; expect several minutes, most of it the wrap rather than the work.`);
      // --shm-size: from about 64 KB of input the native executor dies with SIGBUS on Docker's default
      // 64 MB /dev/shm and the prover then hangs with no error at all, which is the worst way for this to
      // fail. Found on a 2 TB machine, so it is not a memory shortage — it is the shared-memory segment.
      //
      // The network is open only while the Groth16 circuit is missing. It is 9.4 GB and SP1 fetches it on
      // first use; with --network none and a cold cache the run fails with "artifact not found". After the
      // first fetch the cache volume persists and every later job runs sealed off, which is what the job
      // contract promises. A provider that would rather never open it can pre-fetch with warm-prover.sh.
      const warm = await execFile("docker", ["run", "--rm", "-v", `${PROVER_CACHE}:/root/.sp1`,
        "alpine", "sh", "-c", "ls /root/.sp1/circuits/groth16/*/ >/dev/null 2>&1 && echo yes || echo no"])
        .then((r) => r.stdout.trim() === "yes").catch(() => false);
      if (!warm) {
        say(`Job #${jobId}: the Groth16 circuit (9.4 GB) is not cached yet, so this first proof needs the `
          + `network to fetch it. Later proofs run with no network at all.`);
      }
      await execFile("docker", ["run", "--rm", ...(warm ? ["--network", "none"] : []),
        "--shm-size", String(cfg.proverShmSize ?? "16g"),
        "-v", `${PROVER_REPO}:/work:ro`, "-v", `${PROVER_CACHE}:/root/.sp1`,
        "-v", `${dir}:/job`, "-w", "/work/zk/sp1", spec.proverImage ?? "piecework/sp1:v6",
        "./target/release/piecework", "--prove", "--mode", "groth16", "--term", String(spec.term ?? "payment"),
        // Which guest, and so which verification key the proof will carry. Defaulting to the bound one is
        // safe in the sense that a mismatch is always refused rather than mispaid: the key is the job's
        // identity on chain, so proving the wrong guest produces a proof no catalogue entry names.
        "--guest", String(spec.guest ?? "bound"),
        "--out", "/job/out", "--proof", "/job/proof.json",
        ...inputFiles.map((f) => `/job/in/${f}`)], { maxBuffer: 1 << 28 });
    } else {
      const run = ["run", "--rm", ...mounts, spec.dockerImage];
      await execFile("docker", spec.script ? [...run, "sh", "-c", spec.script] : run, { maxBuffer: 1 << 26 });
    }
  } finally { release(); }
  J.runSeconds = (Date.now() - t0) / 1000;
  say(`Job #${jobId}: program finished in ${J.runSeconds.toFixed(1)} s.`);
  if ((await pub.getBlockNumber()) > deadline) { J.stage = "late"; save(); return say(`Job #${jobId}: past the deadline; not delivering.`); }

  const { clientDataSetId } = await read(cfg.contracts.view, ABI.View, "getDataSet", [dataSetId]);
  // Some programs know their outputs by name; some cannot. Transcoding names its results after the client's
  // own files, so what it writes depends on what it was given. Those declare "*" and we deliver the lot.
  const everything = spec.byo || spec.outputs === "*";
  const produced = everything
    ? fs.readdirSync(path.join(dir, "out")).filter((n) => fs.statSync(path.join(dir, "out", n)).isFile())
    : spec.outputs;
  if (everything && !produced.length) throw new Error("the program wrote nothing to /out, so there is nothing to deliver");
  const files = produced.map((name) => ({ name, bytes: new Uint8Array(fs.readFileSync(path.join(dir, "out", name))) }));
  J.stage = "storing"; J.t.storing = now(); save();
  const stored = await storeResults(dataSetId, clientDataSetId, files);
  say(`Job #${jobId}: results added to the client's data set as pieces #${stored.pieceIds.join(", #")} (tx ${stored.tx}).`);
  J.stage = "committing"; J.t.committing = now(); J.addTx = stored.tx; J.outputs = files.map((f, i) => ({ name: f.name, pieceId: String(stored.pieceIds[i]), cid: stored.cids[i] })); save();
  let r;
  if (spec.prove) {
    const pr = JSON.parse(fs.readFileSync(path.join(dir, "proof.json"), "utf8"));
    const proof = encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [pr.publicValues, pr.proofBytes]);
    J.vkey = pr.vkey; save();
    say(`Job #${jobId}: proved. vkey ${pr.vkey}, journal ${pr.publicValues.slice(0, 18)}… — claiming payment, `
      + `which only moves if the chain's verifier agrees.`);
    try {
      r = await send(cfg.contracts.computeService, ABI.ComputeService, "commitOutputs", [jobId, stored.pieceIds, proof]);
    } catch (e) {
      J.stage = "rejected"; save();
      return say(`Job #${jobId}: the chain refused my proof (${e.shortMessage ?? e.message}). I am not paid, and `
        + `the client can take the price back at the deadline.`);
    }
  } else {
    r = await send(cfg.contracts.computeService, ABI.ComputeService, "commitOutputs", [jobId, stored.pieceIds]);
  }
  J.stage = "paid"; J.t.paid = now(); J.done = true; J.commitTx = r.transactionHash; save();
  say(`Job #${jobId}: committed and paid (tx ${r.transactionHash}).`);

  await afterCommit(jobId, dataSetId, clientDataSetId, r);
}

/// If the client asked for old files to be replaced, the contract allowed exactly those pieces on delivery.
async function afterCommit(jobId, dataSetId, clientDataSetId, r) {
  const allowed = [];
  for (const log of r.logs) {
    try {
      const ev = decodeEventLog({ abi: ABI.ComputeService, data: log.data, topics: log.topics });
      if (ev.eventName === "RemovalAllowed" && ev.args.jobId === jobId) allowed.push(...ev.args.pieceIds);
    } catch { /* other contracts' events */ }
  }
  if (allowed.length) await removePieces(jobId, dataSetId, clientDataSetId, allowed).catch((e) => say(`Job #${jobId}: could not remove the old files: ${e.shortMessage ?? e.message}`));
}

/// Schedules the removal of the pieces the client allowed with this job. PDP removes them at the provider's
/// next proving period; Warm Storage checks with ComputeService, which allows each piece once.
async function removePieces(jobId, dataSetId, clientDataSetId, pieceIds) {
  const structHash = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
    [keccak256(toHex("SchedulePieceRemovals(uint256 clientDataSetId,uint256[] pieceIds)")), clientDataSetId,
      keccak256(encodePacked(["uint256[]"], [pieceIds]))],
  ));
  const domain = { name: "FilecoinWarmStorageService", version: "1", chainId: chain.id, verifyingContract: getAddress(cfg.contracts.fwss) };
  const signature = await account.sign({ hash: keccak256(concat(["0x1901", hashDomain({ domain, types: { EIP712Domain: EIP712_DOMAIN } }), structHash])) });
  const r = await send(cfg.contracts.pdp, ABI.PDPVerifier, "schedulePieceDeletions", [dataSetId, pieceIds, encodeAbiParameters([{ type: "bytes" }], [signature])]);
  say(`Job #${jobId}: the client asked to replace ${pieceIds.length} old file${pieceIds.length > 1 ? "s" : ""}; removal scheduled (tx ${r.transactionHash}). PDP removes them at my next proving period.`);
}

// ---------------------------------------------------------------- pay for time (sessions)
//
// The client opens a session on ComputeService naming a service and a rate per epoch. This kit starts the
// service in a container with the client's files mounted read-only, then calls sessionReady, which is the
// moment the rate starts. It collects what it has earned every so often (settleRail), and when either side
// closes the session it shuts the container down. Closing stops the charge at that epoch.

// A provider's machine is finite, and nothing above this line says so: ten jobs arriving together would start
// ten containers. Work waits its turn here instead. Raise maxConcurrent if your hardware can take it.
const MAX_RUNNING = Math.max(1, cfg.maxConcurrent ?? 2);
let running = 0;
const waiting = [];
async function slot(what) {
  if (running >= MAX_RUNNING) {
    say(`${what}: ${running} already running (limit ${MAX_RUNNING}); queued.`);
    await new Promise((resolve) => waiting.push(resolve));
  }
  running++;
}
function release() {
  running--;
  waiting.shift()?.();
}

// "pii-report.txt" also matches pii-report-1.txt and pii-report-s3r1.txt: the same output, whichever round
// or session wrote it.
function namePattern(n) {
  const dot = n.lastIndexOf(".");
  const stem = n.slice(0, dot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${stem}(-[\\w-]+)?\\${n.slice(dot)}$`, "i");
}

// Bounding a container's run by killing the docker client does not work: the signal does not reach the
// container, and `docker run` returns only when the program finishes anyway — a twenty-second run survived a
// three-second timeout and exited cleanly. Start it detached, watch the clock ourselves, and remove it by
// force when the time is up. The only thing that can stop a program someone else wrote is the daemon.
async function runBounded(name, runArgs, seconds) {
  await execFile("docker", ["rm", "-f", name]).catch(() => {}); // a container left by an earlier attempt
  await execFile("docker", ["run", "-d", "--name", name, ...runArgs], { maxBuffer: 1 << 26 });
  const until = Date.now() + seconds * 1000;
  try {
    for (;;) {
      const { stdout } = await execFile("docker", ["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", name])
        .catch(() => ({ stdout: "false 125" }));
      const [running, code] = stdout.trim().split(/\s+/);
      if (running === "false") {
        if (Number(code) !== 0) throw new Error(`the program exited with code ${code}`);
        return;
      }
      if (Date.now() > until) throw new Error(`the program was still running after ${seconds} s and was stopped`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await execFile("docker", ["rm", "-f", name]).catch(() => {});
  }
}

const container = (id) => `piecework-session-${id}`;
const toSettle = new Set(Object.values(state.sessions ?? {}).filter((s) => !s.closed).map((s) => s.railId));

async function startSession(ev) {
  const { sessionId, client, dataSetId, imageDigest, rate, railId } = ev;
  const key = String(sessionId);
  if (state.sessions?.[key]) return;
  const name = SERVICE_BY_DIGEST[imageDigest];
  const spec = SERVICES[name];
  if (!spec) return say(`Session #${sessionId}: I do not offer ${imageDigest.slice(0, 10)}…; not mine to run.`);
  const s = await read(cfg.contracts.computeService, ABI.ComputeService, "sessions", [sessionId]);
  if (Number(s[7]) !== 1) return; // not open any more
  state.sessions ??= {};
  const S = (state.sessions[key] = { id: key, name: spec.name, client, dataSetId: String(dataSetId), railId: String(railId),
    rate: formatUnits(rate, 18), stage: "starting", since: new Date().toISOString() });
  save();
  S.type = SERVICE_BY_DIGEST[imageDigest];
  say(`Session #${sessionId}: "${spec.name}" for ${client} over data set #${dataSetId}, ${formatUnits(rate, 18)} ${cfg.token ?? "USDFC"} per epoch.`);

  // A live service has nothing to hold open: the work is the watching. Start the meter, then keep the data
  // set's property true for as long as the client pays for it.
  if (spec.mode === "live") {
    S.scanned = 0;
    const r = await send(cfg.contracts.computeService, ABI.ComputeService, "sessionReady", [sessionId]);
    S.stage = "running"; S.readyTx = r.transactionHash; S.readyBlock = Number(r.blockNumber); save();
    toSettle.add(String(railId));
    say(`Session #${sessionId}: watching data set #${dataSetId}. Every new file gets "${spec.name}" run over it and the `
      + `result written back. The meter starts at block ${r.blockNumber} (tx ${r.transactionHash}).`);
    watchLive(sessionId, spec);
    return;
  }
  const dir = path.join(WORK, `session-${sessionId}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  try {
    const names = await pieceNames(dataSetId).catch(() => ({}));
    const next = Number(await read(cfg.contracts.pdp, ABI.PDPVerifier, "getNextPieceId", [dataSetId]));
    let files = 0;
    for (let id = 0; id < next; id++) { // everything of the client's that is still live in the data set
      if (!(await read(cfg.contracts.pdp, ABI.PDPVerifier, "pieceLive", [dataSetId, BigInt(id)]))) continue;
      const c = await read(cfg.contracts.pdp, ABI.PDPVerifier, "getPieceCid", [dataSetId, BigInt(id)]);
      const given = names[String(id)];
      const safe = given && /^[\w .()-]{1,80}$/.test(given) ? given : `piece-${id}`;
      fs.writeFileSync(path.join(dir, "data", fs.existsSync(path.join(dir, "data", safe)) ? `${id}-${safe}` : safe),
        await fetchPiece(CID.decode(hexToBytes(c.data)).toString()));
      files++;
    }
    S.files = files;
    await execFile("docker", ["run", "-d", "--rm", "--name", container(sessionId), "--network", "none",
      "-v", `${dir}/data:/data:ro`, spec.dockerImage, ...(spec.command ?? ["sleep", "infinity"])], { maxBuffer: 1 << 26 });
    say(`Session #${sessionId}: service running with ${files} of the client's files at /data. Telling the contract it is ready.`);
    const r = await send(cfg.contracts.computeService, ABI.ComputeService, "sessionReady", [sessionId]);
    S.stage = "running"; S.readyTx = r.transactionHash; S.readyBlock = Number(r.blockNumber); save();
    toSettle.add(String(railId));
    say(`Session #${sessionId}: the meter starts at block ${r.blockNumber} (tx ${r.transactionHash}).`);
  } catch (e) {
    S.stage = "failed"; S.error = e.shortMessage ?? e.message; save();
    say(`Session #${sessionId}: could not start (${S.error}). Closing it so the client is not charged.`);
    await stopSessionContainer(sessionId);
    await send(cfg.contracts.computeService, ABI.ComputeService, "closeSession", [sessionId]).catch(() => {});
  }
}

// A service billed by the epoch that produces nothing is just a meter. These keep a property of the data set
// true: whenever the client adds a file, the program runs over what is new and the results are written back
// into the same data set. The contract allows that write for exactly as long as the session is running.
const watchers = new Map();

async function liveRound(sessionId) {
  const key = String(sessionId);
  const S = state.sessions?.[key];
  if (!S || S.closed || S.busy) return;
  const spec = SERVICES[S.type];
  if (!spec) return;
  const dataSetId = BigInt(S.dataSetId);
  const next = Number(await read(cfg.contracts.pdp, ABI.PDPVerifier, "getNextPieceId", [dataSetId]));
  if (next <= (S.scanned ?? 0)) return; // nothing new since the last look
  const names = await pieceNames(dataSetId, true).catch(() => ({}));
  const exts = spec.inputExtensions ?? [];
  const match = spec.inputMatch ? new RegExp(spec.inputMatch, "i") : null;
  const mine = new Set(S.mine ?? []);
  // Knowing only the pieces this session wrote is not enough: a second session over the same data set finds the
  // first one's results, treats them as new input, and redacts the redaction. A service has to recognise its own
  // output by name, whoever produced it, or the data set grows a layer with every session.
  // Everything any service or job writes is derived: results, reports, vectors, answers. Feeding those back in
  // is how a keyword index came to outrank a real document, and how a question came to be its own best match.
  // A service reads the client's own documents, and the one kind of derived file it is built to read.
  const derived = [...Object.values(SERVICES), ...Object.values(JOBS)]
    .flatMap((x) => x.outputs ?? [])
    .map((n) => namePattern(n));
  const questions = Object.values(SERVICES).map((x) => x.inputMatch).filter(Boolean).map((r) => new RegExp(r, "i"));
  const mineToRead = spec.inputMatch ? new RegExp(spec.inputMatch, "i") : null;
  const ours = (spec.outputs ?? []).map(namePattern);
  const fresh = [];
  for (let id = S.scanned ?? 0; id < next; id++) {
    if (mine.has(String(id))) continue; // our own output, not new input
    if (!(await read(cfg.contracts.pdp, ABI.PDPVerifier, "pieceLive", [dataSetId, BigInt(id)]))) continue;
    const given = names[String(id)] ?? "";
    if (ours.some((r) => r.test(given))) continue; // something this service wrote, in this session or an earlier one
    if (!mineToRead?.test(given)) {
      if (derived.some((r) => r.test(given))) continue;      // produced by some service or job, not a document
      if (questions.some((r) => r.test(given))) continue;    // somebody's question, not something to work over
    }
    if (match ? !match.test(given) : exts.length && !exts.some((e) => given.toLowerCase().endsWith(e))) continue;
    fresh.push({ id, name: /^[\w .()-]{1,80}$/.test(given) ? given : `piece-${id}` });
  }
  S.scanned = next;
  save();
  if (!fresh.length) return;

  S.busy = true;
  const round = (S.rounds ?? 0) + 1;
  say(`Session #${sessionId}: ${fresh.length} new file${fresh.length > 1 ? "s" : ""} in data set #${S.dataSetId} `
    + `(${fresh.map((f) => f.name).join(", ")}); running "${spec.name}" over ${fresh.length > 1 ? "them" : "it"}.`);
  const dir = path.join(WORK, `session-${sessionId}-round-${round}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "in"), { recursive: true });
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.mkdirSync(path.join(dir, "context"), { recursive: true });
  try {
    for (const f of fresh) {
      const c = await read(cfg.contracts.pdp, ABI.PDPVerifier, "getPieceCid", [dataSetId, BigInt(f.id)]);
      // Two pieces in a data set can carry the same name. Writing both under that name would leave one of
      // them unread while the client pays for the round, so the second keeps its piece id.
      const at = path.join(dir, "in", f.name);
      fs.writeFileSync(fs.existsSync(at) ? path.join(dir, "in", `${f.id}-${f.name}`) : at,
        await fetchPiece(CID.decode(hexToBytes(c.data)).toString()));
    }
    // Some services answer from what is already in the data set — the vectors an earlier service wrote, for
    // instance. Those go in read-only at /context, so the program can tell them apart from what just arrived.
    if (spec.context?.match) {
      const ctx = new RegExp(spec.context.match, "i");
      let ids = [];
      for (let id = 0; id < next; id++) {
        const given = names[String(id)] ?? "";
        if (!ctx.test(given)) continue;
        if (!(await read(cfg.contracts.pdp, ABI.PDPVerifier, "pieceLive", [dataSetId, BigInt(id)]))) continue;
        ids.push(id);
      }
      // Each run of a service writes a fresh file covering everything it saw, so the older ones are the same
      // chunks again. Loading them all counted every passage twice and made the corpus look bigger than it is.
      if (spec.context.latestOnly && ids.length) ids = [Math.max(...ids)];
      for (const id of ids) {
        const c = await read(cfg.contracts.pdp, ABI.PDPVerifier, "getPieceCid", [dataSetId, BigInt(id)]);
        fs.writeFileSync(path.join(dir, "context", `${id}-${names[String(id)]}`), await fetchPiece(CID.decode(hexToBytes(c.data)).toString()));
      }
    }
    const run = ["run", "--rm", "--network", "none", ...(spec.gpu ? ["--gpus", String(cfg.gpus ?? "all")] : []),
      "-v", `${dir}/in:/in:ro`, "-v", `${dir}/context:/context:ro`,
      "-v", `${dir}/out:/out`, spec.dockerImage];
    await slot(`Session #${sessionId} round ${round}`);
    try {
      await execFile("docker", spec.script ? [...run, "sh", "-c", spec.script] : run, { maxBuffer: 1 << 26 });
    } finally { release(); }
    // Each round writes its own files: the client's data set keeps every round, not just the last one.
    const files = spec.outputs
      .filter((n) => fs.existsSync(path.join(dir, "out", n)))
      .map((n) => ({ name: n.replace(/(\.[^.]+)$/, `-s${sessionId}r${round}$1`), bytes: new Uint8Array(fs.readFileSync(path.join(dir, "out", n))) }));
    if (!files.length) throw new Error("the program produced nothing");
    const { clientDataSetId } = await read(cfg.contracts.view, ABI.View, "getDataSet", [dataSetId]);
    const stored = await storeResults(dataSetId, clientDataSetId, files);
    S.mine = [...(S.mine ?? []), ...stored.pieceIds.map(String)];
    S.rounds = round;
    S.scanned = Number(await read(cfg.contracts.pdp, ABI.PDPVerifier, "getNextPieceId", [dataSetId]));
    S.lastRound = { at: new Date().toISOString(), inputs: fresh.map((f) => f.name), outputs: files.map((f) => f.name), tx: stored.tx };
    say(`Session #${sessionId}: written back as piece${stored.pieceIds.length > 1 ? "s" : ""} #${stored.pieceIds.join(", #")} `
      + `(${files.map((f) => f.name).join(", ")}, tx ${stored.tx}). The client did not have to ask.`);
  } catch (e) {
    say(`Session #${sessionId}: this round failed (${e.shortMessage ?? e.message}); the service keeps running and will try the next file.`);
  } finally {
    S.busy = false;
    save();
  }
}

function watchLive(sessionId, spec) {
  const every = Math.max(1, spec.everyEpochs ?? 2) * 30_000;
  const t = setInterval(() => liveRound(sessionId).catch(() => {}), every);
  watchers.set(String(sessionId), t);
  liveRound(sessionId).catch(() => {});
}

async function stopSessionContainer(id) {
  const t = watchers.get(String(id));
  if (t) { clearInterval(t); watchers.delete(String(id)); }
  return stopSessionContainerOnly(id);
}

async function stopSessionContainerOnly(id) { try { await execFile("docker", ["rm", "-f", container(id)]); } catch { /* already gone */ } }

async function onSessionClosed(ev) {
  const key = String(ev.sessionId);
  const S = state.sessions?.[key];
  if (!S || S.closed) return;
  S.closed = new Date().toISOString();
  S.stage = ev.rateStoppedAtClose ? "closed" : "closed (client was short of funds)";
  save();
  await stopSessionContainer(ev.sessionId);
  say(`Session #${ev.sessionId}: closed by ${ev.closedBy === account.address ? "me" : "the client"}; service shut down`
    + (ev.rateStoppedAtClose ? " and the charge stopped at this epoch." : "; the client was underfunded, so the rail runs to its safety margin."));
  await settle(true);
}

// Collect what the running sessions have earned so far. Filecoin Pay pays out to this provider's account.
let lastSettle = 0;
async function settle(force = false) {
  if (!toSettle.size) return;
  const now = Date.now();
  if (!force && now - lastSettle < (cfg.settleEveryMs ?? 10 * 60_000)) return;
  lastSettle = now;
  const block = await pub.getBlockNumber();
  for (const railId of [...toSettle]) {
    try {
      const before = (await read(cfg.contracts.payments, ABI.FilecoinPayV1, "accounts", [cfg.contracts.usdfc, account.address]))[0];
      const r = await send(cfg.contracts.payments, ABI.FilecoinPayV1, "settleRail", [BigInt(railId), block]);
      const after = (await read(cfg.contracts.payments, ABI.FilecoinPayV1, "accounts", [cfg.contracts.usdfc, account.address]))[0];
      if (after > before) say(`Collected ${formatUnits(after - before, 18)} ${cfg.token ?? "USDFC"} from rail #${railId} (tx ${r.transactionHash}).`);
    } catch { /* nothing to collect yet */ }
    const done = await read(cfg.contracts.payments, ABI.FilecoinPayV1, "getRail", [BigInt(railId)]).then(() => false, () => true);
    if (done) toSettle.delete(railId);
  }
}

// ---------------------------------------------------------------- health and dashboard

// What card this provider has, probed once and remembered.
//
// nvidia-smi is the only thing that answers this without starting a container, and its absence is the
// honest signal that there is no usable GPU here: `docker run --gpus` needs the NVIDIA container toolkit,
// which ships with the driver that provides nvidia-smi. A machine without it cannot run a GPU job however
// many cards are physically in it.
//
// Reported in gigabytes because that is the number job specs are written against, and because VRAM is the
// one hardware limit around here that is a hard wall rather than a slowdown: a model that does not fit does
// not run at all. SP1's CUDA prover, for instance, asks for 24 GB before it will produce a core proof.
let gpuProbe;
const gpuInfo = () => (gpuProbe ??= execFile("nvidia-smi",
  ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
  .then(({ stdout }) => parseGpu(stdout))
  .catch(() => null));

// What key this provider's prover actually produces, asked of the binary rather than assumed from the
// catalogue, and remembered per guest because the answer costs a couple of minutes to get.
//
// Paid once, when the first proved job of that kind arrives, against ten minutes of proving and a refused
// payment every time it is wrong. Nothing is mounted but the repository and the circuit cache: --vkey runs
// the setup and prints, it does not touch a job.
const proverKeys = new Map();
const proverVkey = (spec) => {
  const guest = String(spec.guest ?? "bound");
  if (!proverKeys.has(guest)) {
    proverKeys.set(guest, execFile("docker", ["run", "--rm",
      "-v", `${PROVER_REPO}:/work:ro`, "-v", `${PROVER_CACHE}:/root/.sp1`,
      "-w", "/work/zk/sp1", spec.proverImage ?? "piecework/sp1:v6",
      "./target/release/piecework", "--vkey", "--guest", guest], { maxBuffer: 1 << 24 })
      .then(({ stdout }) => (stdout.match(/0x[0-9a-fA-F]{64}/) ?? [null])[0])
      .catch(() => null));
  }
  return proverKeys.get(guest);
};

const health = { checkedAt: null, curio: null, gas: null, images: {}, block: null, gpu: null };
async function checkHealth(verbose) {
  const ping = await fetch(`${curio}/pdp/ping`).then((r) => r.status).catch(() => "unreachable");
  health.curio = ping === 200 ? "reachable" : `not reachable (${ping})`;
  health.gas = Number(formatUnits(await pub.getBalance({ address: account.address }), 18)).toFixed(3);
  for (const [name, spec] of Object.entries(JOBS)) {
    // A proved job has no job image: the SP1 guest is the program, and what has to be present is the
    // prover. Reading dockerImage for it reported "image undefined MISSING", which says a runnable job
    // cannot run — the kind of startup line a provider reads once and believes.
    const image = spec.prove ? (spec.proverImage ?? "piecework/sp1:v6") : spec.dockerImage;
    health.images[name] = { image, ready: await execFile("docker", ["image", "inspect", image]).then(() => true, () => false) };
  }
  health.gpu = await gpuInfo();
  health.block = Number(await pub.getBlockNumber());
  health.checkedAt = new Date().toISOString();
  if (verbose) {
    say(`Curio PDP API: ${health.curio}.`);
    say(`Gas balance: ${health.gas} ${chain.nativeCurrency.symbol}.`);
    say(health.gpu
      ? `GPU: ${health.gpu.name}, ${health.gpu.vramGb} GB. I can take the jobs that need one.`
      : `GPU: none detected (nvidia-smi did not answer). Jobs marked as needing a card will be declined, `
        + `which is the right outcome: taking one would waste the client's deadline before failing.`);
    for (const [name, x] of Object.entries(health.images)) {
      const needs = JOBS[name]?.gpu
        ? (health.gpu ? "" : " — needs a GPU, which I do not have")
        : "";
      say(`Job type "${name}": image ${x.image} ${x.ready ? "present" : "MISSING (build or pull it first)"}${needs}.`);
    }
  }
}

function dashboard() {
  const port = cfg.dashboardPort ?? 8090, host = cfg.dashboardHost ?? "127.0.0.1"; // only this machine, unless configured
  createServer((req, res) => {
    if (req.url === "/api/status") {
      const jobs = Object.entries(state.jobs).filter(([, j]) => j.client).map(([id, j]) => ({ ...j, id, name: j.name ?? "Find and remove personal data in my documents" })).sort((a, b) => Number(b.id) - Number(a.id));
      const earned = jobs.filter((j) => j.stage === "paid").reduce((n, j) => n + Number(j.price ?? 0), 0);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ provider: account.address, network: chain.name, chainId: chain.id, curio, token: cfg.token ?? "USDFC",
        gasSymbol: chain.nativeCurrency.symbol, explorer: cfg.explorer ?? "https://filecoin-testnet.blockscout.com", health, jobs, earned, log: LOG.slice(-60) }));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(HERE, "dashboard.html")));
  }).listen(port, host, () => say(`Dashboard: http://${host === "0.0.0.0" ? "localhost" : host}:${port}`));
}

// ---------------------------------------------------------------- main loop

async function main() {
  say(`PieceWork provider kit. Provider ${account.address} on ${chain.name}; Curio at ${curio}.`);
  await checkHealth(true);
  for (const [id, J] of Object.entries(state.jobs)) { // fill in jobs recorded by earlier versions of the kit
    if (!J.client || J.price) continue;
    const j = await read(cfg.contracts.computeService, ABI.ComputeService, "jobs", [BigInt(id)]).catch(() => null);
    if (!j) continue;
    if (!J.commitTx) { delete state.jobs[id]; continue; } // not delivered by this kit
    Object.assign(J, { price: formatUnits(j[3], 18), deadline: String(j[4]) });
  }
  save();
  dashboard();
  setInterval(() => checkHealth(false).catch(() => {}), 60_000);
  // A live service is started by a SessionOpened event, and after a restart that event is in the past: the
  // session is still running and still being paid for, but nothing would be watching the data set. Pick the
  // watchers back up from what was saved, and check with the contract that the session really is still open.
  for (const [id, S] of Object.entries(state.sessions ?? {})) {
    const spec = SERVICES[S.type];
    if (S.closed || spec?.mode !== "live") continue;
    const onChain = await read(cfg.contracts.computeService, ABI.ComputeService, "sessions", [BigInt(id)]).catch(() => null);
    if (!onChain || Number(onChain[7]) !== 2) { S.closed = new Date().toISOString(); S.stage = "closed"; save(); continue; }
    say(`Session #${id}: "${spec.name}" is still running for ${S.client}; watching data set #${S.dataSetId} again.`);
    watchLive(Number(id), spec);
  }
  if (!state.lastBlock) state.lastBlock = Number(await pub.getBlockNumber()) - 100;
  {
    const behind = Number(await pub.getBlockNumber()) - state.lastBlock;
    if (behind > 2000) say(`Catching up ${behind.toLocaleString()} blocks since I last ran; this takes a few minutes.`);
  }
  const busy = new Set();
  const pending = new Map(); // jobs seen in this run, so a failed one can be retried
  setInterval(() => retryFailed().catch((e) => say(`Could not check for jobs to retry: ${e.shortMessage ?? e.message}`)), 30_000);
  async function retryFailed() { // retry jobs that failed before delivering, while the deadline allows it
    const head = await pub.getBlockNumber();
    for (const [id, ev] of pending) {
      const J = state.jobs[id];
      if (!J || J.done || busy.has(ev.jobId) || J.stage !== "failed" || head > ev.deadline) continue;
      say(`Job #${id}: retrying after the earlier failure.`);
      busy.add(ev.jobId);
      runJob(ev).catch((e) => say(`Job #${id} failed again: ${e.shortMessage ?? e.message}`)).finally(() => busy.delete(ev.jobId));
    }
  }
  for (;;) {
    try {
      const head = Number(await pub.getBlockNumber());
      // Public Filecoin nodes cap an eth_getLogs range: Glif and Ankr refuse anything over 360 blocks
      // ("block range exceeds maximum of 360"), and a chunk that is always refused never gets past a restart.
      // Your own Lotus will serve a wider range; raise blockChunk in the configuration if you run one.
      const chunk = Math.max(1, cfg.blockChunk ?? 300);
      for (let from = state.lastBlock + 1; from <= head; from += chunk) {
        const to = Math.min(head, from + chunk - 1);
        for (const l of await pub.getContractEvents({ address: cfg.contracts.computeService, abi: ABI.ComputeService,
          eventName: "SessionOpened", fromBlock: BigInt(from), toBlock: BigInt(to) })) {
          if (getAddress(l.args.provider) !== account.address || busy.has(`s${l.args.sessionId}`)) continue;
          busy.add(`s${l.args.sessionId}`);
          startSession(l.args).catch((e) => say(`Session #${l.args.sessionId} failed: ${e.shortMessage ?? e.message}`))
            .finally(() => busy.delete(`s${l.args.sessionId}`));
        }
        for (const l of await pub.getContractEvents({ address: cfg.contracts.computeService, abi: ABI.ComputeService,
          eventName: "SessionClosed", fromBlock: BigInt(from), toBlock: BigInt(to) })) {
          await onSessionClosed(l.args).catch((e) => say(`Session #${l.args.sessionId}: ${e.shortMessage ?? e.message}`));
        }
        const logs = await pub.getContractEvents({ address: cfg.contracts.computeService, abi: ABI.ComputeService,
          eventName: "JobPosted", fromBlock: BigInt(from), toBlock: BigInt(to) });
        for (const l of logs) {
          if (getAddress(l.args.provider) !== account.address || busy.has(l.args.jobId)) continue;
          busy.add(l.args.jobId);
          pending.set(String(l.args.jobId), l.args);
          runJob(l.args).catch((e) => {
            say(`Job #${l.args.jobId} failed: ${e.shortMessage ?? e.message}`);
            if (process.env.KIT_DEBUG) console.error(e);
            const J = state.jobs[String(l.args.jobId)];
            if (J && !J.done) { J.stage = "failed"; J.error = e.shortMessage ?? e.message; save(); }
          }).finally(() => busy.delete(l.args.jobId));
        }
        state.lastBlock = to; save();
      }
      await settle().catch(() => {});
    } catch (e) { say(`(chain read failed, retrying: ${e.shortMessage ?? e.message})`); }
    await sleep(cfg.pollMs ?? 10_000);
  }
}
process.on("SIGINT", async () => { // leave nothing running that the client is still paying for
  for (const [id, S] of Object.entries(state.sessions ?? {})) if (!S.closed) await stopSessionContainer(id);
  process.exit(0);
});
// A provider runs for weeks. Public RPC endpoints time out, rate-limit and go away, and node treats an
// unhandled rejection as fatal — so one slow request would end a provider's day without warning. Nothing
// here is worth exiting for: say so and keep going. A genuine failure still shows up in the job's own log,
// and the chain is the record of what happened either way.
process.on("unhandledRejection", (e) => say(`Ignoring an error nothing was waiting for: ${e?.shortMessage ?? e?.message ?? e}`));
process.on("uncaughtException", (e) => say(`Ignoring an unexpected error: ${e?.shortMessage ?? e?.message ?? e}`));

main().catch((e) => { console.error("Could not start:", e.shortMessage ?? e.message); process.exit(1); });
