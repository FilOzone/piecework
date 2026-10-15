// Deploy the proof-checking half to Calibration: SP1's own Groth16 verifier at the circuit version our
// prover emits, and the adapter that binds a proof to the piece CIDs ComputeService derived.
//
//   node zk/deploy-verifier.mjs            # dry run: report what it would do, send nothing
//   node zk/deploy-verifier.mjs --send     # deploy, then write the addresses into poc/calibnet.json
//
// The version matters more than anything else here. A proof from one SP1 circuit version does not verify
// against another's verifier, and the failure is indistinguishable from a forged proof — so this reads
// VERSION() back off the deployed contract and refuses to record an address that disagrees with the
// circuit the prover actually used.
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

// The circuit version the prover emits. sp1/README.md records how to check it: the proving run logs the
// artifact it downloaded (v6.1.0-groth16).
const CIRCUIT_VERSION = "v6.1.0";
const SEND = process.argv.includes("--send");

const artifact = (file, contract = file) => {
  const j = JSON.parse(fs.readFileSync(path.join(CONTRACTS, "out", `${file}.sol`, `${contract}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
};

const say = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// Loaded into memory and never printed, the same way start.mjs treats it.
if (!fs.existsSync(KEY_FILE)) throw new Error(`no provider key at ${KEY_FILE}`);
const account = privateKeyToAccount(fs.readFileSync(KEY_FILE, "utf8").trim());

const T = () => fallback([
  http("https://api.calibration.node.glif.io/rpc/v1"),
  http("https://rpc.ankr.com/filecoin_testnet"), // the backup start.mjs uses; chainup 404s
], { retryCount: 3 });
const pub = createPublicClient({ chain: filecoinCalibration, transport: T(), pollingInterval: 4000 });
const wallet = createWalletClient({ chain: filecoinCalibration, transport: T(), account });

const bal = await pub.getBalance({ address: account.address });
say(`deployer ${account.address}, ${formatEther(bal)} tFIL`);
if (bal === 0n) throw new Error("deployer has no tFIL");

async function deploy(file, contract, args = []) {
  const a = artifact(file, contract);
  // FEVM gas units are much larger than Ethereum's and estimates run close, so pad. The Groth16 verifier
  // is a big contract: the v4 deployment took 70.9M gas.
  const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args });
  const gas = (await pub.estimateGas({ account, data })) * 3n / 2n;
  say(`${contract}: ${(a.bytecode.length - 2) / 2} bytes of code, gas ${gas}`);
  if (!SEND) return null;
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args, chain: filecoinCalibration, gas });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
  if (r.status !== "success") throw new Error(`${contract} deployment reverted (${hash})`);
  say(`${contract} at ${getAddress(r.contractAddress)}  tx ${hash}`);
  return { address: getAddress(r.contractAddress), tx: hash, block: Number(r.blockNumber) };
}

const sp1 = await deploy("SP1VerifierGroth16", "SP1Verifier");
if (!SEND) {
  await deploy("SP1ComputeVerifier", "SP1ComputeVerifier", ["0x0000000000000000000000000000000000000001"]);
  say("dry run — nothing sent. Re-run with --send to deploy.");
  process.exit(0);
}

// Read the version back off the chain rather than trusting the artifact we just compiled.
const version = await pub.readContract({ address: sp1.address, abi: artifact("SP1VerifierGroth16", "SP1Verifier").abi,
  functionName: "VERSION" });
say(`deployed verifier reports VERSION() = ${version}`);
if (version !== CIRCUIT_VERSION) {
  throw new Error(`version mismatch: deployed ${version}, prover emits ${CIRCUIT_VERSION}. Not recording this.`);
}

const adapter = await deploy("SP1ComputeVerifier", "SP1ComputeVerifier", [sp1.address]);
const points = await pub.readContract({ address: adapter.address,
  abi: artifact("SP1ComputeVerifier").abi, functionName: "sp1" });
if (getAddress(points) !== sp1.address) throw new Error(`adapter points at ${points}, not ${sp1.address}`);
say(`adapter points at the verifier it should`);

const d = JSON.parse(fs.readFileSync(DEPLOY_FILE, "utf8"));
d.verification = {
  note: d.verification?.note ?? "Verified compute. ComputeService accepts a verifier address on postJob; "
    + "sp1ComputeVerifier below is one to pass.",
  sp1Verifier: { address: sp1.address, version, tx: sp1.tx, block: sp1.block,
    source: `succinctlabs/sp1-contracts contracts/src/${CIRCUIT_VERSION}/SP1VerifierGroth16.sol, unmodified`,
    checked: "VERSION() read back from the deployed contract; contracts/test/RealProof.t.sol runs this same "
      + "bytecode against a proof from our own guest, and against that proof with one byte changed." },
  sp1ComputeVerifier: { address: adapter.address, tx: adapter.tx, block: adapter.block,
    note: "IComputeProofVerifier adapter: refuses before looking at the proof unless its journal commits to "
      + "the piece CIDs ComputeService derived for itself." },
  superseded: [
    ...(d.verification?.superseded ?? []),
    ...(d.verification?.sp1Verifier && d.verification.sp1Verifier.address !== sp1.address
      ? [{ ...d.verification.sp1Verifier, why: `superseded: ${d.verification.sp1Verifier.version} cannot verify a ${CIRCUIT_VERSION} proof` }] : []),
    ...(d.verification?.sp1ComputeVerifier && d.verification.sp1ComputeVerifier.address !== adapter.address
      ? [{ ...d.verification.sp1ComputeVerifier, why: "superseded: pointed at the old verifier" }] : []),
  ],
  precompileProbe: d.verification?.precompileProbe,
};
fs.writeFileSync(DEPLOY_FILE, JSON.stringify(d, null, 2) + "\n");
say("written to poc/calibnet.json");
say(`\nverifier for the page config: ${adapter.address}`);
