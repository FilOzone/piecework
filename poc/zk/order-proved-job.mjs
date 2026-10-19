// Order a proved job on the local chain, as a client would, and report whether the money moved.
//
//   node start.mjs                      # in one terminal: anvil, the FOC stack, the stand-in provider
//   node zk/order-proved-job.mjs        # in another: this
//
// Why this exists rather than clicking the page: a proved job takes about ten minutes, and the thing worth
// testing is whether payment is released against a real Groth16 proof — not whether a checkbox renders.
// Driving it from a script means the cycle can be run repeatedly, and failed, without a browser in the way.
//
// It also runs the control, which is the half that gives the result meaning: the same job ordered with the
// verifier set and a proof over different inputs must not pay. That case lives in the contract tests
// (test_Z4, test_R4); here it is checked against a live chain and a real prover.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseUnits, getAddress } from "viem";
import { foundry } from "viem/chains";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POC = path.join(HERE, "..");
const RPC = "http://127.0.0.1:8545";
const PAGE = "http://127.0.0.1:8080"; // the demo serves its own state; saveState() only writes a file on calibnet

const abi = (f, c = f) =>
  JSON.parse(fs.readFileSync(path.join(POC, "..", "contracts", "out", `${f}.sol`, `${c}.json`), "utf8")).abi;

const pub = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 300 });
const wallet = createWalletClient({ chain: foundry, transport: http(RPC) });
const CS = abi("ComputeService");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// Ask the running demo what it set up, rather than guessing at deterministic anvil addresses. Two calls:
// the first to learn which account the demo treats as the client, the second to get that client's data set.
async function demo() {
  const get = async (q = "") => {
    const r = await fetch(`${PAGE}/api/state${q}`);
    if (!r.ok) throw new Error(`the demo answered ${r.status} — is node start.mjs running?`);
    return r.json();
  };
  const base = await get();
  const who = base.testClient ?? base.client?.address;
  if (!who) throw new Error("the demo has no test client yet — let start.mjs finish its setup");
  const s = await get(`?client=${who}`);
  if (s.dataSetId == null) throw new Error("the test client has no data set yet — let start.mjs finish");
  return { contracts: s.contracts, provider: s.provider, client: getAddress(who),
           dataSetId: BigInt(s.dataSetId), files: s.files ?? [] };
}

async function write(account, address, functionName, args, abi_ = CS) {
  const { request } = await pub.simulateContract({ account, address, abi: abi_, functionName, args });
  const hash = await wallet.writeContract({ ...request, chain: foundry, gas: 15_000_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}

const d = await demo();
const C = d.contracts;
if (!C.verifier) throw new Error("no verifier deployed — start.mjs needs the version that deploys SP1ComputeVerifier");

// One small .txt piece. Proving costs 227 cycles/byte with no economy of scale, so the input is chosen to
// be small on purpose; a megabyte would be 237M cycles and hours of proving for the same demonstration.
const piece = d.files
  .filter((f) => /\.txt$/.test(f.name) && !/^term-count/.test(f.name) && f.pieceId != null)
  .sort((a, b) => Number(a.pieceId) - Number(b.pieceId))[0];
if (!piece) throw new Error("no .txt piece in the client's data set to prove over");
const pieceId = piece.pieceId;

const VKEY = "0x0038c8f3827c1ba3c9396591d54c84aec5c15f8c24a39f7258734a2f8e9ad45e";
const price = parseUnits("0.5", 18); // luca_usdfc has 18 decimals, like USDFC
const head = await pub.getBlockNumber();
// Local blocks are a second apart and a proof takes about ten minutes, so this is roughly a 30-minute
// deadline. The default 40 epochs any other job uses would expire while the prover was still running, and
// the symptom — refunded, nothing delivered — looks identical to a provider that never tried.
const deadline = head + 1800n;

say(`data set #${d.dataSetId}, proving over piece #${pieceId} (${piece.name})`);
say(`verifier ${C.verifier}, vkey ${VKEY}`);

// Two approvals the page would otherwise collect from MetaMask: the ERC-20 allowance, and the Filecoin Pay
// operator approval that lets ComputeService open a rail and hold the price. The state endpoint reports
// computeApproved: false on a fresh demo, and postJob reverts without it.
await write(d.client, C.usdfc, "approve", [C.payments, price * 8n], abi("MockERC20"));
await write(d.client, C.payments, "setOperatorApproval",
  [C.usdfc, C.cs, true, parseUnits("10", 18), parseUnits("10", 18), 1n << 40n], abi("FilecoinPayV1"));
// The demo deposits only enough for storage, which leaves about 0.05 available against a 0.5 price:
// postJob then reverts with "insufficient funds to cover lockup", which reads like a contract bug and is
// really an empty account. Top it up from the wallet, which the demo funds with 5.
await write(d.client, C.payments, "deposit", [C.usdfc, d.client, parseUnits("2", 18)], abi("FilecoinPayV1"));
// "Allow job results" in the page. Without it FWSS rejects the provider's addPieces with InvalidSignature
// — after the proof has been produced, which wastes eight minutes to tell you about a missing click.
const FWSS = [{ type: "function", name: "setDataSetAuthorizer", stateMutability: "nonpayable",
  inputs: [{ type: "uint256" }, { type: "address" }], outputs: [] }];
await write(d.client, C.fwss, "setDataSetAuthorizer", [d.dataSetId, getAddress(C.cs)], FWSS);
say("authorized ComputeService to deliver results into data set #" + d.dataSetId);
const r = await write(d.client, C.cs, "postJob",
  [getAddress(d.provider), VKEY, d.dataSetId, [BigInt(pieceId)], [], price, deadline, getAddress(C.verifier)]);
const jobId = await pub.readContract({ address: C.cs, abi: CS, functionName: "nextJobId" }).then((n) => n - 1n);
say(`posted job #${jobId} in block ${r.blockNumber} — provider has until ${deadline}`);

// 0 None, 1 Posted, 2 Paid, 3 Expired — the contract's JobStatus.
const STATUS = ["none", "posted", "paid", "expired"];
let last = "";
for (;;) {
  const job = await pub.readContract({ address: C.cs, abi: CS, functionName: "jobs", args: [jobId] });
  const status = STATUS[Number(job[8])] ?? "?";
  if (status !== last) { say(`job #${jobId}: ${status}`); last = status; }
  if (status === "paid") { say("PAID — a Groth16 proof was checked on chain and the price was released."); break; }
  if (status === "expired") { say("EXPIRED — nothing was paid."); process.exit(1); }
  if ((await pub.getBlockNumber()) > deadline) { say("deadline passed without payment."); process.exit(1); }
  await sleep(5000);
}
