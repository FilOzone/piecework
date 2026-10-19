// Deploy the attested job's adapter to Calibration, alongside the bound one already there.
//
//   node zk/deploy-unbound.mjs            # dry run: report what it would do, send nothing
//   node zk/deploy-unbound.mjs --send     # deploy, then write the address into poc/calibnet.json
//
// Narrow on purpose. deploy-verifier.mjs deploys SP1's Groth16 verifier *and* the bound adapter, and
// re-running it would replace a verifier that is working and version-checked for no reason. The only thing
// missing is one adapter that points at the same verifier, so that is the only thing this sends.
//
// SP1UnboundVerifier is SP1ComputeVerifier with the input-commitment comparison removed: the chain checks
// the proof and the delivered output, but not which bytes the computation read. That is a weaker claim, so
// it is a separate job at a lower price rather than a change to the existing one, and the two live side by
// side with the client choosing by naming an address at postJob.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, fallback, formatEther, getAddress, encodeDeployData } from "viem";
import { filecoinCalibration } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POC = path.join(HERE, "..");
const CONTRACTS = path.join(POC, "..", "contracts");
const DEPLOY_FILE = path.join(POC, "calibnet.json");
const KEY_FILE = `${process.env.HOME}/.foc-compute-poc/calibnet/provider.key`;
const CIRCUIT_VERSION = "v6.1.0";
const SEND = process.argv.includes("--send");

const artifact = (file, contract = file) => {
  const j = JSON.parse(fs.readFileSync(path.join(CONTRACTS, "out", `${file}.sol`, `${contract}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
};
const say = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

if (!fs.existsSync(KEY_FILE)) throw new Error(`no provider key at ${KEY_FILE}`);
const account = privateKeyToAccount(fs.readFileSync(KEY_FILE, "utf8").trim()); // in memory only, never printed

const T = () => fallback([
  http("https://api.calibration.node.glif.io/rpc/v1"),
  http("https://rpc.ankr.com/filecoin_testnet"),
], { retryCount: 3 });
const pub = createPublicClient({ chain: filecoinCalibration, transport: T(), pollingInterval: 4000 });
const wallet = createWalletClient({ chain: filecoinCalibration, transport: T(), account });

const bal = await pub.getBalance({ address: account.address });
say(`deployer ${account.address}, ${formatEther(bal)} tFIL`);
if (bal === 0n) throw new Error("deployer has no tFIL");

// The verifier this adapter will point at is the one already deployed and already in use by the bound job.
const d = JSON.parse(fs.readFileSync(DEPLOY_FILE, "utf8"));
const sp1Address = d.verification?.sp1Verifier?.address;
if (!sp1Address) throw new Error("no sp1Verifier recorded in calibnet.json — run deploy-verifier.mjs first");
const sp1 = getAddress(sp1Address);

// Read the version off the chain rather than trusting what the file says about it. A proof from one circuit
// version does not verify against another's verifier, and that failure is indistinguishable from forgery.
const version = await pub.readContract({ address: sp1,
  abi: artifact("SP1VerifierGroth16", "SP1Verifier").abi, functionName: "VERSION" });
say(`existing SP1 verifier ${sp1} reports VERSION() = ${version}`);
if (version !== CIRCUIT_VERSION) {
  throw new Error(`version mismatch: deployed ${version}, prover emits ${CIRCUIT_VERSION}. Not deploying against this.`);
}
if (d.verification?.sp1UnboundVerifier?.address) {
  say(`note: an unbound adapter is already recorded at ${d.verification.sp1UnboundVerifier.address}`);
  say("it will be moved to `superseded` if this run sends a new one.");
}

const a = artifact("SP1UnboundVerifier");
const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: [sp1] });
const gas = (await pub.estimateGas({ account, data })) * 3n / 2n;
say(`SP1UnboundVerifier: ${(a.bytecode.length - 2) / 2} bytes of code, gas ${gas}, constructor arg ${sp1}`);

if (!SEND) {
  say("dry run — nothing sent. Re-run with --send to deploy.");
  process.exit(0);
}

const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args: [sp1],
  chain: filecoinCalibration, gas });
const r = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
if (r.status !== "success") throw new Error(`SP1UnboundVerifier deployment reverted (${hash})`);
const address = getAddress(r.contractAddress);
say(`SP1UnboundVerifier at ${address}  tx ${hash}`);

// It has one job and one constructor argument; checking it kept the argument is cheap and the failure it
// catches — an adapter pointing at nothing, or at the wrong verifier — refuses every proof identically.
const points = await pub.readContract({ address, abi: a.abi, functionName: "sp1" });
if (getAddress(points) !== sp1) throw new Error(`adapter points at ${points}, not ${sp1}`);
say("adapter points at the verifier it should");

// Captured before the overwrite: an address that was in the catalogue and is being replaced belongs in the
// record, because a client that ordered against it will have a job referring to it.
const previous = d.verification.sp1UnboundVerifier;

d.verification.sp1UnboundVerifier = {
  address, tx: hash, block: Number(r.blockNumber),
  note: "IComputeProofVerifier adapter for the attested job: verifies the proof and the delivered output "
    + "commitment, and does NOT check the input commitment against the piece CIDs ComputeService derived. "
    + "Weaker claim, a quarter of the proving cost, a separate catalogue entry at a lower price.",
  checked: "sp1() read back from the deployed contract; contracts/test/RealProof.t.sol runs this adapter "
    + "and the bound one over the same real proof, one accepting and one refusing (test_U1 against test_R4).",
};
if (previous && getAddress(previous.address) !== address) {
  d.verification.superseded = [
    ...(d.verification.superseded ?? []),
    { ...previous, why: "superseded: replaced by a newer unbound adapter" },
  ];
}
fs.writeFileSync(DEPLOY_FILE, JSON.stringify(d, null, 2) + "\n");
say("written to poc/calibnet.json");
say(`\nunbound verifier for the page config: ${address}`);
