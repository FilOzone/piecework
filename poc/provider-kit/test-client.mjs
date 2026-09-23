// Test client for the provider kit: plays the client against one provider, end to end, on Calibration.
//
//   node test-client.mjs --config client.config.json [--data-set <id>]
//
// 1. (without --data-set) creates a data set with the provider and stores the sample documents in it, through the
//    provider's Curio (Synapse's createDataSetAndAddPieces: the client signs, Curio submits);
// 2. makes ComputeService the data set's authorizer (so the provider may add job results while a job is open);
// 3. orders the PII job over the documents, and waits until the provider delivers and is paid (or the deadline passes).
// The client must already have USDFC deposited in Filecoin Pay and have approved Warm Storage and ComputeService as
// operators (the demo page's "Store my files" and "Deposit" steps do this).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, fallback, keccak256, toHex, parseUnits, getAddress } from "viem";
import { calibration } from "@filoz/synapse-core/chains";
import { privateKeyToAccount } from "viem/accounts";
import * as Piece from "@filoz/synapse-core/piece";
import * as SP from "@filoz/synapse-core/sp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ABI = JSON.parse(fs.readFileSync(path.join(HERE, "abi.json"), "utf8"));
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const cfg = JSON.parse(fs.readFileSync(arg("--config"), "utf8"));
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const account = privateKeyToAccount(fs.readFileSync(cfg.clientKeyFile.replace(/^~/, os.homedir()), "utf8").trim());
const transport = fallback(cfg.rpc.map((u) => http(u)), { retryCount: 2 });
const pub = createPublicClient({ chain: calibration, transport, pollingInterval: 4000 });
const wallet = createWalletClient({ chain: calibration, transport, account });
const C = cfg.contracts;
const FWSS_ABI = [{ type: "function", name: "setDataSetAuthorizer", stateMutability: "nonpayable",
  inputs: [{ name: "dataSetId", type: "uint256" }, { name: "authorizer", type: "address" }], outputs: [] }];

async function send(address, abi, functionName, args) {
  const { request } = await pub.simulateContract({ account, address, abi, functionName, args });
  const gas = (await pub.estimateContractGas({ account, address, abi, functionName, args })) * 3n / 2n;
  const hash = await wallet.writeContract({ ...request, gas });
  say(`  ${functionName} sent: ${hash}`);
  for (let attempt = 1; ; attempt++) {
    try { return await pub.waitForTransactionReceipt({ hash, timeout: 600_000 }); }
    catch (e) { if (attempt >= 6) throw e; await sleep(5000); }
  }
}

async function main() {
  say(`Client ${account.address}; provider ${cfg.provider} (Curio ${cfg.curioUrl}).`);
  let dataSetId = arg("--data-set") ? BigInt(arg("--data-set")) : undefined;
  const docsDir = path.join(HERE, "..", "data", "dataset");
  const docs = fs.readdirSync(docsDir).filter((f) => /^(loan-agreement|kyc-form|invoice|trade-confirmation)/.test(f)).sort();

  if (dataSetId === undefined) {
    say(`Storing ${docs.length} documents with the provider…`);
    const pieces = [];
    for (const f of docs) {
      const data = new Uint8Array(fs.readFileSync(path.join(docsDir, f)));
      const pieceCid = await Piece.calculate(data);
      await SP.uploadPiece({ serviceURL: cfg.curioUrl, data, pieceCid });
      pieces.push({ pieceCid, metadata: { name: f } });
    }
    const created = await SP.createDataSetAndAddPieces(wallet, { serviceURL: cfg.curioUrl, payee: getAddress(cfg.provider), pieces, cdn: false });
    const done = await SP.waitForCreateDataSetAddPieces({ statusUrl: created.statusUrl });
    dataSetId = BigInt(done.dataSetId);
    say(`Data set #${dataSetId} created with ${docs.length} pieces.`);
    await send(C.fwss, FWSS_ABI, "setDataSetAuthorizer", [dataSetId, C.computeService]);
    say("ComputeService is now the data set's authorizer.");
  }

  const next = await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "getNextPieceId", args: [dataSetId] });
  const inputs = [];
  for (let i = 0n; i < next; i++)
    if (await pub.readContract({ address: C.pdp, abi: ABI.PDPVerifier, functionName: "pieceLive", args: [dataSetId, i] })) inputs.push(i);
  const head = await pub.getBlockNumber();
  const deadline = head + BigInt(cfg.deadlineEpochs ?? 40);
  const price = parseUnits(String(cfg.priceUSDFC ?? "0.5"), 18);
  say(`Ordering the PII job on ${inputs.length} pieces of data set #${dataSetId}, price ${cfg.priceUSDFC ?? "0.5"} USDFC, deadline block ${deadline}…`);
  const PAY = [{ type: "function", name: "operatorApprovals", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "address" }],
    outputs: [{ type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "setOperatorApproval", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "bool" },
    { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [] }];
  const [, rateAllowance, lockupAllowance, , lockupUsage, maxLockupPeriod] = await pub.readContract({ address: C.payments, abi: PAY,
    functionName: "operatorApprovals", args: [C.usdfc, account.address, C.computeService] });
  if (lockupAllowance - lockupUsage < price) { // each paid job uses part of the approval for good (Filecoin Pay)
    say("Renewing the budget approved for ComputeService…");
    await send(C.payments, PAY, "setOperatorApproval", [C.usdfc, C.computeService, true, rateAllowance, lockupUsage + parseUnits("3", 18), maxLockupPeriod || 600n]);
  }
  const r = await send(C.computeService, ABI.ComputeService, "postJob",
    [getAddress(cfg.provider), keccak256(toHex("pii-redact:v1")), dataSetId, inputs, [], price, deadline]);
  const jobId = (await pub.getContractEvents({ address: C.computeService, abi: ABI.ComputeService, eventName: "JobPosted",
    fromBlock: r.blockNumber, toBlock: r.blockNumber })).find((l) => l.transactionHash === r.transactionHash).args.jobId;
  say(`Job #${jobId} posted. Waiting for the provider…`);
  for (;;) {
    const j = await pub.readContract({ address: C.computeService, abi: ABI.ComputeService, functionName: "jobs", args: [jobId] });
    if (Number(j[8]) === 2) {
      const paid = await pub.getContractEvents({ address: C.computeService, abi: ABI.ComputeService, eventName: "JobPaid",
        fromBlock: r.blockNumber, args: { jobId } });
      return say(`Job #${jobId} delivered and paid. Result pieces: #${paid[0]?.args.outputPieceIds.join(", #")}.`);
    }
    if ((await pub.getBlockNumber()) > deadline) return say(`Deadline passed without delivery: call expire(${jobId}) to get the money back.`);
    await sleep(15_000);
  }
}
main().catch((e) => { console.error("Failed:", e.shortMessage ?? e.message); process.exit(1); });
