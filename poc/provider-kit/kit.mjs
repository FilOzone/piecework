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
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, http, fallback, keccak256, toHex, hexToBytes, encodeAbiParameters, decodeEventLog, getAddress,
  formatUnits,
} from "viem";
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
const BY_DIGEST = Object.fromEntries(Object.keys(JOBS).map((name) => [keccak256(toHex(name)), name]));

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const cfg = JSON.parse(fs.readFileSync(arg("--config") ?? path.join(HERE, "kit.config.json"), "utf8"));
const chain = cfg.network === "mainnet" ? filecoin : filecoinCalibration;
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const account = privateKeyToAccount(fs.readFileSync(cfg.providerKeyFile.replace(/^~/, os.homedir()), "utf8").trim());
const transport = fallback(cfg.rpc.map((u) => http(u)), { retryCount: 2 });
const pub = createPublicClient({ chain, transport, pollingInterval: 4000 });
const wallet = createWalletClient({ chain, transport, account });
const WORK = (cfg.workDir ?? "~/.piecework-kit").replace(/^~/, os.homedir());
const STATE = path.join(WORK, "state.json");
fs.mkdirSync(WORK, { recursive: true });
let state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { lastBlock: 0, jobs: {} };
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
    message: { clientDataSetId, nonce, pieceData: cids.map((c) => ({ data: toHex(c.bytes) })), pieceMetadata: [] },
  });
  const extraData = encodeAbiParameters([{ type: "uint256" }, { type: "string[][]" }, { type: "string[][]" }, { type: "bytes" }],
    [nonce, [], [], signature]);
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
  const spec = JOBS[BY_DIGEST[imageDigest]];
  if (!spec) return say(`Job #${jobId}: unknown program ${imageDigest}; not mine to run.`);
  const job = await read(cfg.contracts.computeService, ABI.ComputeService, "jobs", [jobId]);
  if (Number(job[8]) !== 1) { state.jobs[key] = { done: true }; save(); return; } // already paid or expired
  const J = (state.jobs[key] = { client, dataSetId: String(dataSetId), stage: "running" });
  save();
  say(`Job #${jobId}: "${spec.name}" for ${client}, data set #${dataSetId}, deadline block ${deadline}.`);
  const dir = path.join(WORK, `job-${jobId}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "in"), { recursive: true });
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  for (const id of inputPieceIds) { // the client's files, as stored on this provider
    const c = await read(cfg.contracts.pdp, ABI.PDPVerifier, "getPieceCid", [dataSetId, id]);
    const pieceCid = CID.decode(hexToBytes(c.data)).toString();
    fs.writeFileSync(path.join(dir, "in", `piece-${id}${spec.inputExtension ?? ""}`), await fetchPiece(pieceCid));
  }
  const t0 = Date.now();
  const run = ["run", "--rm", "--network", "none", "-v", `${dir}/in:/in:ro`, "-v", `${dir}/out:/out`, spec.dockerImage];
  await execFile("docker", spec.script ? [...run, "sh", "-c", spec.script] : run, { maxBuffer: 1 << 26 });
  say(`Job #${jobId}: program finished in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
  if ((await pub.getBlockNumber()) > deadline) { J.stage = "late"; save(); return say(`Job #${jobId}: past the deadline; not delivering.`); }

  const { clientDataSetId } = await read(cfg.contracts.view, ABI.View, "getDataSet", [dataSetId]);
  const files = spec.outputs.map((name) => ({ name, bytes: new Uint8Array(fs.readFileSync(path.join(dir, "out", name))) }));
  J.stage = "storing"; save();
  const stored = await storeResults(dataSetId, clientDataSetId, files);
  say(`Job #${jobId}: results added to the client's data set as pieces #${stored.pieceIds.join(", #")} (tx ${stored.tx}).`);
  J.stage = "committing"; J.outputs = files.map((f, i) => ({ name: f.name, pieceId: String(stored.pieceIds[i]), cid: stored.cids[i] })); save();
  const r = await send(cfg.contracts.computeService, ABI.ComputeService, "commitOutputs", [jobId, stored.pieceIds]);
  J.stage = "paid"; J.done = true; J.commitTx = r.transactionHash; save();
  say(`Job #${jobId}: committed and paid (tx ${r.transactionHash}).`);
}

// ---------------------------------------------------------------- main loop

async function main() {
  say(`PieceWork provider kit. Provider ${account.address} on ${chain.name}; Curio at ${curio}.`);
  const ping = await fetch(`${curio}/pdp/ping`).then((r) => r.status).catch(() => "unreachable");
  say(`Curio PDP API: ${ping === 200 ? "reachable" : `not reachable (${ping})`}.`);
  const bal = await pub.getBalance({ address: account.address });
  say(`Gas balance: ${Number(formatUnits(bal, 18)).toFixed(3)} ${chain.nativeCurrency.symbol}.`);
  for (const [name, spec] of Object.entries(JOBS)) {
    const ok = await execFile("docker", ["image", "inspect", spec.dockerImage]).then(() => true, () => false);
    say(`Job type "${name}": image ${spec.dockerImage} ${ok ? "present" : "MISSING (build or pull it first)"}.`);
  }
  if (!state.lastBlock) state.lastBlock = Number(await pub.getBlockNumber()) - 100;
  const busy = new Set();
  for (;;) {
    try {
      const head = Number(await pub.getBlockNumber());
      for (let from = state.lastBlock + 1; from <= head; from += 1000) {
        const to = Math.min(head, from + 999);
        const logs = await pub.getContractEvents({ address: cfg.contracts.computeService, abi: ABI.ComputeService,
          eventName: "JobPosted", fromBlock: BigInt(from), toBlock: BigInt(to) });
        for (const l of logs) {
          if (getAddress(l.args.provider) !== account.address || busy.has(l.args.jobId)) continue;
          busy.add(l.args.jobId);
          runJob(l.args).catch((e) => say(`Job #${l.args.jobId} failed: ${e.shortMessage ?? e.message}`)).finally(() => busy.delete(l.args.jobId));
        }
        state.lastBlock = to; save();
      }
    } catch (e) { say(`(chain read failed, retrying: ${e.shortMessage ?? e.message})`); }
    await sleep(cfg.pollMs ?? 10_000);
  }
}
main().catch((e) => { console.error("Could not start:", e.shortMessage ?? e.message); process.exit(1); });
