// The take loop, end to end, without a browser.
//
//   node poc/provider-kit/take-e2e.mjs                 first take: makes a data set from sample/takes and orders one
//   node poc/provider-kit/take-e2e.mjs --data-set 123  the next take on top of an existing one
//
// This exists because the page was shipped without it. Every control on the Takes page was tested in
// isolation and the path a person actually walks — store pictures, order the job, get a video back with a
// record of what it came from — had never once been run. A filter on a field that does not exist meant no
// take could ever have been ordered, and nothing caught it.
//
// It plays the demo client against the provider on this machine, on Calibration, using the same rules the
// page uses: the same input selection, the same job digest, the same price and deadline out of the shared
// catalogue. If this passes, the page's order path is right; if the page then fails, the fault is in the
// page and not below it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, fallback, keccak256, toHex,
         parseUnits, formatUnits, getAddress, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CID } from "multiformats";
import { calibration } from "@filoz/synapse-core/chains";
import * as Piece from "@filoz/synapse-core/piece";
import * as SP from "@filoz/synapse-core/sp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POC = path.join(HERE, "..");
const CFG = JSON.parse(fs.readFileSync(path.join(POC, "web", "config.json"), "utf8"));
const ABI = JSON.parse(fs.readFileSync(path.join(POC, "web", "abi.json"), "utf8"));
const C = { ...CFG.contracts, cs: CFG.computeService };

const JOB = "video-gen:v1";
const SPEC = CFG.jobs[JOB];
// The same rule the page applies, kept identical on purpose: if these two ever disagree the test stops
// being evidence about the page.
const IS_PICTURE = /\.(jpe?g|png|webp|bmp|gif)$/i;
const IS_INPUT = /(\.(jpe?g|png|webp|bmp|gif)|^prompt\.json|^version-\d+\.mp4)$/i;

// The provider running on this machine, as the Takes build describes it.
const PROVIDER = { address: "0xA0C38545600fe067D79Cac5215049eEb4BF387d0", curioUrl: "http://localhost:8080" };

// A piece smaller than 127 bytes cannot be stored at all, and a short prompt makes one: the first take
// failed at upload, before anything reached the chain. The job keeps only the keys it knows
// (jobs/video-gen/generate.py), so a note carrying the file past the floor changes nothing it reads.
const MIN_PIECE = 127;
function promptBody(o) {
  let body = JSON.stringify(o, null, 2);
  if (new TextEncoder().encode(body).length < MIN_PIECE)
    body = JSON.stringify({ ...o, note: "padded to the smallest piece a provider will store (127 bytes)" }, null, 2);
  return body;
}

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error("FAILED:", m); process.exit(1); };

const account = privateKeyToAccount(
  fs.readFileSync(path.join(os.homedir(), ".foc-compute-poc/calibnet/demo-client.key"), "utf8").trim());
const transport = fallback([http(CFG.rpc)], { retryCount: 3 });
const pub = createPublicClient({ chain: calibration, transport, pollingInterval: 4000 });
const wallet = createWalletClient({ chain: calibration, transport, account });

async function send(address, abi, functionName, args) {
  const { request } = await pub.simulateContract({ account, address, abi, functionName, args });
  const gas = (await pub.estimateContractGas({ account, address, abi, functionName, args })) * 3n / 2n;
  const hash = await wallet.writeContract({ ...request, gas });
  for (let i = 1; ; i++) {
    try { return await pub.waitForTransactionReceipt({ hash, timeout: 600_000 }); }
    catch (e) { if (i >= 6) throw e; await sleep(5000); }
  }
}

const FWSS_ABI = [{ type: "function", name: "setDataSetAuthorizer", stateMutability: "nonpayable",
  inputs: [{ name: "dataSetId", type: "uint256" }, { name: "authorizer", type: "address" }], outputs: [] }];

// Every live piece with its name and CID, read the way the page reads them: the names are in the events
// that added the pieces, not in anything the provider serves.
async function piecesOf(dataSetId) {
  const next = Number(await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier,
    functionName: "getNextPieceId", args: [dataSetId] }));
  const out = [];
  for (let i = 0; i < next; i++) {
    if (!(await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier,
      functionName: "pieceLive", args: [dataSetId, BigInt(i)] }))) continue;
    const raw = await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier,
      functionName: "getPieceCid", args: [dataSetId, BigInt(i)] });
    out.push({ id: i, cid: CID.decode(hexToBytes(raw.data)).toString(), name: `piece-${i}` });
  }
  const head = await pub.getBlockNumber();
  for (let to = head, n = 0; n < 60 && to > 0n; to -= 300n, n++) {
    const logs = await pub.getContractEvents({ address: C.fwss, abi: ABI.FilecoinWarmStorageService,
      eventName: "PieceAdded", args: { dataSetId },
      fromBlock: to - 299n > 0n ? to - 299n : 0n, toBlock: to }).catch(() => []);
    for (const ev of logs) {
      const at = ev.args.keys?.indexOf("name") ?? -1;
      const p = out.find((x) => x.id === Number(ev.args.pieceId));
      if (at >= 0 && p) p.name = ev.args.values[at];
    }
    if (out.every((p) => !/^piece-\d+$/.test(p.name))) break;
  }
  return out;
}

// Money has to be in Filecoin Pay before anything, and most of what is there is already locked by earlier
// data sets, so "it has a balance" is not the question — what is free is.
async function ensureDeposited(want) {
  const [, , available] = await pub.readContract({ address: C.payments, abi: ABI.FilecoinPayV1,
    functionName: "getAccountInfoIfSettled", args: [C.usdfc, account.address] });
  say(`Free in Filecoin Pay: ${Number(formatUnits(available, 18)).toFixed(3)} tUSDFC.`);
  if (available >= want) return;
  const ERC = [{ type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
  const held = await pub.readContract({ address: C.usdfc, abi: ERC, functionName: "balanceOf", args: [account.address] });
  const top = want - available;
  if (held < top) fail(`needs ${formatUnits(top, 18)} more in Filecoin Pay but the wallet holds only ${formatUnits(held, 18)}`);
  say(`Depositing ${formatUnits(top, 18)} tUSDFC…`);
  await send(C.usdfc, ERC, "approve", [C.payments, top]);
  await send(C.payments, ABI.FilecoinPayV1, "deposit", [C.usdfc, account.address, top]);
}

// Creating a data set reverts with InsufficientLockupFunds unless Warm Storage has an approval to lock
// against — the page does this in createSet, and the test has to do the same or it fails before the part
// it is meant to be testing.
async function ensureStorageBudget() {
  const [, rate, lockup, rateUsed, used, maxPeriod] = await pub.readContract({ address: C.payments,
    abi: ABI.FilecoinPayV1, functionName: "operatorApprovals", args: [C.usdfc, account.address, C.fwss] });
  if (lockup - used >= parseUnits("1", 18)) return say("Warm Storage already has budget to lock against.");
  say("Renewing the budget approved for Warm Storage…");
  await send(C.payments, ABI.FilecoinPayV1, "setOperatorApproval",
    [C.usdfc, C.fwss, true, rate > rateUsed ? rate : rateUsed + parseUnits("0.1", 18),
     used + parseUnits("2", 18), maxPeriod || (1n << 40n)]);
}

async function ensureMoney(price) {
  const [, , available] = await pub.readContract({ address: C.payments, abi: ABI.FilecoinPayV1,
    functionName: "getAccountInfoIfSettled", args: [C.usdfc, account.address] });
  say(`Filecoin Pay holds ${Number(formatUnits(available, 18)).toFixed(3)}; the take costs ${SPEC.price}.`);
  if (available < price) {
    const want = parseUnits("2", 18);
    say("Depositing 2 tUSDFC into Filecoin Pay…");
    const ERC = [{ type: "function", name: "approve", stateMutability: "nonpayable",
      inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }];
    await send(C.usdfc, ERC, "approve", [C.payments, want]);
    await send(C.payments, ABI.FilecoinPayV1, "deposit", [C.usdfc, account.address, want]);
  }
  const [, rate, lockup, , used, maxPeriod] = await pub.readContract({ address: C.payments,
    abi: ABI.FilecoinPayV1, functionName: "operatorApprovals", args: [C.usdfc, account.address, C.cs] });
  if (lockup - used < price) {
    say("Renewing the budget approved for the compute service…");
    await send(C.payments, ABI.FilecoinPayV1, "setOperatorApproval",
      [C.usdfc, C.cs, true, rate, used + parseUnits("3", 18), maxPeriod || 600n]);
  }
}

async function main() {
  say(`Client ${account.address} → provider ${PROVIDER.address} (${PROVIDER.curioUrl}).`);
  const health = await fetch(PROVIDER.curioUrl + "/piece/bafkqaaa").then((r) => r.status).catch(() => null);
  if (health === null) fail(`nothing is answering at ${PROVIDER.curioUrl} — start the provider first`);

  let dataSetId = arg("--data-set") ? BigInt(arg("--data-set")) : undefined;
  const prompt = promptBody({ prompt: arg("--prompt") ?? "a slow drift across the valley from dawn to night",
                              seconds: 4, fps: 12, seed: Number(arg("--seed") ?? 0) });

  if (dataSetId === undefined) {
    // Storage first: a data set cannot be created without it, whatever the compute costs later.
    await ensureDeposited(parseUnits("3", 18));
    await ensureStorageBudget();
    const dir = path.join(HERE, "..", "..", "sample", "takes");
    const names = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
    if (!names.length) fail(`no sample pictures in ${dir}`);
    say(`Storing ${names.length} pictures and the prompt with the provider…`);
    const pieces = [];
    for (const f of [...names, "prompt.json"]) {
      const data = f === "prompt.json"
        ? new TextEncoder().encode(prompt)
        : new Uint8Array(fs.readFileSync(path.join(dir, f)));
      const pieceCid = await Piece.calculate(data);
      await SP.uploadPiece({ serviceURL: PROVIDER.curioUrl, data, pieceCid });
      pieces.push({ pieceCid, metadata: { name: f } });
    }
    const created = await SP.createDataSetAndAddPieces(wallet,
      { serviceURL: PROVIDER.curioUrl, payee: getAddress(PROVIDER.address), pieces, cdn: false });
    const done = await SP.waitForCreateDataSetAddPieces({ statusUrl: created.statusUrl });
    dataSetId = BigInt(done.dataSetId);
    say(`Data set #${dataSetId} created with ${pieces.length} pieces.`);
    await send(C.fwss, FWSS_ABI, "setDataSetAuthorizer", [dataSetId, C.cs]);
    say("ComputeService may now add results to it.");
  } else {
    say(`Adding a fresh prompt to data set #${dataSetId}…`);
    const data = new TextEncoder().encode(prompt);
    const pieceCid = await Piece.calculate(data);
    await SP.uploadPiece({ serviceURL: PROVIDER.curioUrl, data, pieceCid });
    const had = Number(await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier,
      functionName: "getNextPieceId", args: [dataSetId] }));
    // addPieces is signed by the client over its own per-client data set number, which Warm Storage keeps;
    // passing the data set's id here instead is what "Cannot convert undefined to a BigInt" was.
    const d = await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView,
      functionName: "getDataSet", args: [dataSetId] });
    const added = await SP.addPieces(wallet, { serviceURL: PROVIDER.curioUrl, dataSetId,
      clientDataSetId: d.clientDataSetId, pieces: [{ pieceCid, metadata: { name: "prompt.json" } }] });
    await SP.waitForAddPieces({ statusUrl: added.statusUrl, timeout: 10 * 60_000 }).catch(async () => {
      const now = Number(await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier,
        functionName: "getNextPieceId", args: [dataSetId] }));
      if (now < had + 1) fail("the prompt was not added to the data set");
    });
    say("A fresh prompt is in the data set.");
  }

  // The page keeps the pieces the job can read, by name. Do the same, so the selection under test is the
  // selection the page makes.
  const all = await piecesOf(dataSetId);
  const inputs = all.filter((p) => IS_INPUT.test(p.name));
  say(`Data set #${dataSetId}: ${all.length} live pieces [${all.map((p) => p.name).join(", ")}]`);
  say(`${inputs.length} of them are inputs for this job.`);
  if (!inputs.length) fail(`no inputs selected out of ${all.length} live pieces`);

  const price = parseUnits(SPEC.price, 18);
  await ensureMoney(price);

  const deadline = (await pub.getBlockNumber()) + BigInt(SPEC.deadlineEpochs ?? 40);
  say(`Ordering ${JOB} over ${inputs.length} pieces, ${SPEC.price} tUSDFC, deadline block ${deadline}…`);
  const r = await send(C.cs, ABI.ComputeService, "postJob",
    [getAddress(PROVIDER.address), keccak256(toHex(JOB)), dataSetId, inputs.map((p) => BigInt(p.id)), [], price, deadline]);
  const jobId = (await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, eventName: "JobPosted",
    fromBlock: r.blockNumber, toBlock: r.blockNumber })).find((l) => l.transactionHash === r.transactionHash).args.jobId;
  say(`Job #${jobId} posted. Waiting for the provider…`);

  for (;;) {
    const j = await pub.readContract({ address: C.cs, abi: ABI.ComputeService, functionName: "jobs", args: [jobId] });
    if (Number(j[8]) === 2) {
      const paid = await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, eventName: "JobPaid",
        fromBlock: r.blockNumber, args: { jobId } });
      const outs = paid[0]?.args.outputPieceIds ?? [];
      say(`Job #${jobId} delivered and paid. Result pieces: #${outs.join(", #")}.`);
      await inspect(dataSetId, outs, prompt);
      return;
    }
    if (Number(j[8]) === 3) fail(`job #${jobId} was refused on chain`);
    if ((await pub.getBlockNumber()) > deadline) fail(`deadline passed with no delivery (job #${jobId})`);
    await sleep(15_000);
  }
}

// The point of the job is the record beside the video, so the test is not finished until that record has
// been read back and checked. A video with no manifest, or a manifest naming a parent nothing matches, is
// the failure this whole page exists to make visible.
async function inspect(dataSetId, outs, prompt) {
  const all = await piecesOf(dataSetId);
  const got = outs.map((o) => all.find((p) => p.id === Number(o))).filter(Boolean);
  say(`Delivered: ${got.map((p) => p.name).join(", ") || "(nothing readable)"}`);
  const video = got.find((p) => /^version-\d+\.mp4$/i.test(p.name));
  const record = got.find((p) => /^version-\d+\.json$/i.test(p.name));
  if (!video) fail(`no version-N.mp4 came back (got: ${got.map((p) => p.name).join(", ")})`);
  if (!record) fail(`the video came back without its record (got: ${got.map((p) => p.name).join(", ")})`);

  const head = await fetch(`${PROVIDER.curioUrl}/piece/${video.cid}`).then((r) => r.ok ? r.arrayBuffer() : null);
  if (!head) fail("the video piece is on chain but the provider will not serve it");
  say(`${video.name}: ${(head.byteLength / 1024).toFixed(1)} kB served back.`);

  const m = await fetch(`${PROVIDER.curioUrl}/piece/${record.cid}`).then((r) => r.json());
  say(`Record: ${m.produced?.name}, ${m.produced?.frames} frames, sha256 ${String(m.produced?.sha256).slice(0, 12)}…`);
  say(`Prompt: ${JSON.stringify(m.prompt)}`);
  say(`Built on: ${m.from?.parent ? `${m.from.parent.name} ${String(m.from.parent.sha256).slice(0, 12)}…` : "nothing (first take)"}`);
  say(`Inputs named: ${(m.from?.images ?? []).map((i) => i.name).join(", ") || "(none)"}`);
  if (!m.produced?.sha256) fail("the record does not say what it produced");

  const sent = JSON.parse(prompt);
  if (m.prompt !== sent.prompt)
    fail(`the record's prompt is ${JSON.stringify(m.prompt)}, not the ${JSON.stringify(sent.prompt)} that was sent`);
  const named = (m.from?.images ?? []).map((i) => i.name).sort();
  const expected = all.filter((p) => IS_PICTURE.test(p.name)).map((p) => p.name).sort();
  if (JSON.stringify(named) !== JSON.stringify(expected))
    fail(`the record names ${named.join(", ") || "nothing"} but the data set holds ${expected.join(", ")}`);
  say("The record names the pictures that were uploaded, and the prompt that was sent.");

  // A second take has to name the first, and name it by the hash the first published for itself. That claim
  // is the product; an unchecked one is worth nothing.
  if (m.from?.parent) {
    const parentRec = all.find((p) => p.name === m.from.parent.name.replace(/\.mp4$/i, ".json"));
    if (!parentRec) say(`NOTE: parent ${m.from.parent.name} named but its record is not in this data set.`);
    else {
      const pm = await fetch(`${PROVIDER.curioUrl}/piece/${parentRec.cid}`).then((r) => r.json());
      if (pm.produced?.sha256 === m.from.parent.sha256) say("Lineage checks out: the parent hash matches what the parent published.");
      else fail(`lineage broken: parent published ${pm.produced?.sha256}, this take claims ${m.from.parent.sha256}`);
    }
  }
  say("PASS — a take came back with a record of what it was made from.");
}

main().catch((e) => {
  // The library wraps the provider's answer; without the cause the message is just "Failed to create
  // data set", which says nothing about why.
  for (let c = e, n = 0; c && n < 5; c = c.cause, n++)
    console.error(n ? `  caused by: ${c.shortMessage ?? c.message ?? c}` : `FAILED: ${c.shortMessage ?? c.message ?? c}`,
      c.details ? `\n    details: ${JSON.stringify(c.details).slice(0, 600)}` : "");
  process.exit(1);
});
