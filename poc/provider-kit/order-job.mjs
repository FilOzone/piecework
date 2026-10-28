// Order any catalogue job over a set of local files, end to end, and read the result back.
//
//   node provider-kit/order-job.mjs --job image-index:v1 --files a.jpg,b.jpg [--provider local]
//   node provider-kit/order-job.mjs --job frame-stability:v1 --files v.mp4,track.json
//
// take-e2e.mjs proves the video-gen loop specifically. This proves any job: it creates a data set with the
// files named, orders the job over the pieces that job can read, waits for the provider to deliver and be
// paid, and prints what came back. A job that has only ever run in Docker here has not been shown to work
// -- the thing a client buys is an ordered, paid job whose results land in their data set.
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

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error("FAILED:", m); process.exit(1); };

const JOB = arg("--job") ?? fail("need --job");
const SPEC = CFG.jobs[JOB] ?? fail(`${JOB} is not in the catalogue`);
const PROVIDERS = {
  local: { address: "0xA0C38545600fe067D79Cac5215049eEb4BF387d0", curioUrl: "http://localhost:8080" },
  james: { address: "0xa3971A7234a3379A1813d9867B531e7EeB20ae07", curioUrl: "https://calib.ezpdpz.net" },
};
const WHO = arg("--provider") ?? "local";
const PROVIDER = PROVIDERS[WHO] ?? fail(`no provider ${WHO}`);
const FILES = (arg("--files") ?? fail("need --files")).split(",").map((f) => f.trim()).filter(Boolean);

const account = privateKeyToAccount(
  fs.readFileSync(path.join(os.homedir(), ".foc-compute-poc/calibnet/demo-client.key"), "utf8").trim());
const transport = fallback([http(CFG.rpc), http("https://filecoin-calibration.chainup.net/rpc/v1")], { retryCount: 3 });
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
      eventName: "PieceAdded", args: { dataSetId }, fromBlock: to - 299n > 0n ? to - 299n : 0n, toBlock: to }).catch(() => []);
    for (const ev of logs) {
      const at = ev.args.keys?.indexOf("name") ?? -1;
      const p = out.find((x) => x.id === Number(ev.args.pieceId));
      if (at >= 0 && p) p.name = ev.args.values[at];
    }
    if (out.every((p) => !/^piece-\d+$/.test(p.name))) break;
  }
  return out;
}

async function ensureMoney(price) {
  const [, , available] = await pub.readContract({ address: C.payments, abi: ABI.FilecoinPayV1,
    functionName: "getAccountInfoIfSettled", args: [C.usdfc, account.address] });
  say(`Free in Filecoin Pay: ${Number(formatUnits(available, 18)).toFixed(3)}; this job costs ${SPEC.price}.`);
  const want = price + price / 2n;
  if (available < want) {
    const ERC = [{ type: "function", name: "approve", stateMutability: "nonpayable",
      inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
    const held = await pub.readContract({ address: C.usdfc, abi: ERC, functionName: "balanceOf", args: [account.address] });
    const top = want - available;
    if (held < top) fail(`needs ${formatUnits(top, 18)} more in Filecoin Pay, wallet holds ${formatUnits(held, 18)}`);
    say(`Depositing ${formatUnits(top, 18)}…`);
    await send(C.usdfc, ERC, "approve", [C.payments, top]);
    await send(C.payments, ABI.FilecoinPayV1, "deposit", [C.usdfc, account.address, top]);
  }
  const [, rate, lockup, , used, maxPeriod] = await pub.readContract({ address: C.payments,
    abi: ABI.FilecoinPayV1, functionName: "operatorApprovals", args: [C.usdfc, account.address, C.cs] });
  if (lockup - used < price) {
    say("Renewing the compute budget…");
    await send(C.payments, ABI.FilecoinPayV1, "setOperatorApproval",
      [C.usdfc, C.cs, true, rate, used + parseUnits("3", 18), maxPeriod || 600n]);
  }
  const [, r2, l2, ru2, u2, mp2] = await pub.readContract({ address: C.payments,
    abi: ABI.FilecoinPayV1, functionName: "operatorApprovals", args: [C.usdfc, account.address, C.fwss] });
  if (l2 - u2 < parseUnits("1", 18)) {
    say("Renewing the storage budget…");
    await send(C.payments, ABI.FilecoinPayV1, "setOperatorApproval",
      [C.usdfc, C.fwss, true, r2 > ru2 ? r2 : ru2 + parseUnits("0.1", 18), u2 + parseUnits("2", 18), mp2 || (1n << 40n)]);
  }
}

async function main() {
  say(`${JOB} → ${WHO} (${PROVIDER.curioUrl})`);
  const price = parseUnits(SPEC.price, 18);
  await ensureMoney(price);

  const reuse = arg("--data-set");
  if (reuse) {
    const dataSetId = BigInt(reuse);
    const have = (await piecesOf(dataSetId)).map((p) => p.name);
    const missing = FILES.filter((f) => f !== "x" && !have.includes(path.basename(f)));
    if (missing.length) {
      say(`Adding ${missing.map((f) => path.basename(f)).join(", ")} to data set #${dataSetId}…`);
      const add = [];
      for (const f of missing) {
        const data = new Uint8Array(fs.readFileSync(f));
        if (data.length < 127) fail(`${f} is ${data.length} bytes, under the 127-byte minimum piece`);
        const pieceCid = await Piece.calculate(data);
        await SP.uploadPiece({ serviceURL: PROVIDER.curioUrl, data, pieceCid });
        add.push({ pieceCid, metadata: { name: path.basename(f) } });
      }
      const d = await pub.readContract({ address: C.view, abi: ABI.FilecoinWarmStorageServiceStateView,
        functionName: "getDataSet", args: [dataSetId] });
      const r = await SP.addPieces(wallet, { serviceURL: PROVIDER.curioUrl, dataSetId,
        clientDataSetId: d.clientDataSetId, pieces: add });
      await SP.waitForAddPieces({ statusUrl: r.statusUrl, timeout: 10 * 60_000 }).catch(() => {});
    } else {
      say(`Reusing data set #${dataSetId} — nothing re-uploaded.`);
    }
    return await order(dataSetId);
  }
  say(`Storing ${FILES.length} file(s)…`);
  const pieces = [];
  for (const f of FILES) {
    const data = new Uint8Array(fs.readFileSync(f));
    if (data.length < 127) fail(`${f} is ${data.length} bytes, under the 127-byte minimum piece`);
    const pieceCid = await Piece.calculate(data);
    await SP.uploadPiece({ serviceURL: PROVIDER.curioUrl, data, pieceCid });
    pieces.push({ pieceCid, metadata: { name: path.basename(f) } });
  }
  const created = await SP.createDataSetAndAddPieces(wallet,
    { serviceURL: PROVIDER.curioUrl, payee: getAddress(PROVIDER.address), pieces, cdn: false });
  const done = await SP.waitForCreateDataSetAddPieces({ statusUrl: created.statusUrl });
  const dataSetId = BigInt(done.dataSetId);
  say(`Data set #${dataSetId} created.`);
  await send(C.fwss, FWSS_ABI, "setDataSetAuthorizer", [dataSetId, C.cs]);

  return await order(dataSetId);
}

async function order(dataSetId) {
  const price = parseUnits(SPEC.price, 18);
  const r0 = await pub.getBlockNumber();
  const all = await piecesOf(dataSetId);
  const exts = (SPEC.inputExtensions ?? []).map((e) => e.toLowerCase());
  const inputs = all.filter((p) => exts.some((e) => p.name.toLowerCase().endsWith(e)));
  say(`Pieces: ${all.map((p) => p.name).join(", ")}`);
  say(`${inputs.length} of them readable by ${JOB}.`);
  if (!inputs.length) fail("nothing this job can read");

  const deadline = (await pub.getBlockNumber()) + BigInt(SPEC.deadlineEpochs ?? 120);
  const r = await send(C.cs, ABI.ComputeService, "postJob",
    [getAddress(PROVIDER.address), keccak256(toHex(JOB)), dataSetId, inputs.map((p) => BigInt(p.id)), [], price, deadline]);
  const jobId = (await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, eventName: "JobPosted",
    fromBlock: r.blockNumber, toBlock: r.blockNumber })).find((l) => l.transactionHash === r.transactionHash).args.jobId;
  say(`Job #${jobId} posted. Waiting…`);

  for (;;) {
    const j = await pub.readContract({ address: C.cs, abi: ABI.ComputeService, functionName: "jobs", args: [jobId] });
    if (Number(j[8]) === 2) {
      const paid = await pub.getContractEvents({ address: C.cs, abi: ABI.ComputeService, eventName: "JobPaid",
        fromBlock: r.blockNumber, args: { jobId } });
      const outs = (paid[0]?.args.outputPieceIds ?? []).map(Number);
      say(`Job #${jobId} delivered and paid. Output pieces: #${outs.join(", #")}.`);
      const after = await piecesOf(dataSetId);
      const got = outs.map((o) => after.find((p) => p.id === o)).filter(Boolean);
      say(`Delivered: ${got.map((p) => p.name).join(", ")}`);
      // Read a result back rather than trusting that pieces appeared.
      for (const g of got.filter((p) => /\.(txt|json)$/i.test(p.name)).slice(0, 2)) {
        const text = await fetch(`${PROVIDER.curioUrl}/piece/${g.cid}`).then((x) => x.text()).catch(() => "");
        say(`--- ${g.name} (first lines) ---`);
        console.log(text.split("\n").slice(0, 12).map((l) => "    " + l).join("\n"));
      }
      say(`PASS — ${JOB} ran as an ordered job and was paid.`);
      return;
    }
    if (Number(j[8]) === 3) fail(`job #${jobId} refused on chain`);
    if ((await pub.getBlockNumber()) > deadline) fail(`deadline passed with no delivery (job #${jobId})`);
    await sleep(15_000);
  }
}
main().catch((e) => fail(e.shortMessage ?? e.message ?? e));
