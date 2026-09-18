// The real FOC contracts, as used by the POC.
//
// Local mode: deploys the contracts at the versions running on calibnet and mainnet
//   (FilOzone/filecoin-services @ 4cbbea4 = FWSS v1.4.0, its PDPVerifier, ServiceProviderRegistry,
//   SessionKeyRegistry, Filecoin Pay v1.0.0) on the local chain, from integration/out.
//   anvil has no Filecoin precompiles, so the two FVM "call actor" precompiles used to burn and pay FIL
//   are replaced by a stub that reports success (FIL fees stay in the contract instead of being burned).
// Calibnet mode (stage B): the same functions, with FilOz's published addresses.
//
// Signatures use FilOz's own EIP-712 definitions (@filoz/synapse-core), and piece CIDs are computed
// from the file bytes with FilOz's piece library (CommPv2), exactly as filecoin-pin / synapse do.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, toHex, getAddress, parseEther } from "viem";
import * as Piece from "@filoz/synapse-core/piece";
import { EIP712Types } from "@filoz/synapse-core/typed-data";
import { encodePDPCapabilities } from "@filoz/synapse-core/utils";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.join(HERE, "..", "integration", "out");

export function artifact(name) {
  const j = JSON.parse(fs.readFileSync(path.join(OUT, `${name}.sol`, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, links: j.bytecode.linkReferences ?? {} };
}

// Insert library addresses into bytecode placeholders (what forge does for tests).
function link(bytecode, links, libs) {
  let hex = bytecode.slice(2);
  for (const file of Object.values(links)) {
    for (const [lib, refs] of Object.entries(file)) {
      const addr = libs[lib].slice(2).toLowerCase();
      for (const { start, length } of refs) hex = hex.slice(0, start * 2) + addr + hex.slice((start + length) * 2);
    }
  }
  return `0x${hex}`;
}

// FVM precompiles FVMPay uses (fvm-solidity FVMPrecompiles.sol): CALL_ACTOR_BY_ADDRESS, CALL_ACTOR_BY_ID.
// Stub: return 256 zero bytes = exit code 0 (EXIT_SUCCESS).
const FVM_STUB = "0x6101006000f3";
const FVM_PRECOMPILES = ["0xfe00000000000000000000000000000000000003", "0xfe00000000000000000000000000000000000005"];

export const NAMES = ["FilecoinPayV1", "PDPVerifier", "ServiceProviderRegistry", "SessionKeyRegistry",
  "FilecoinWarmStorageService", "FilecoinWarmStorageServiceStateView", "ComputeService", "ERC1967Proxy",
  "SignatureVerificationLib", "Rails"];

/// Deploy the FOC stack on the local chain. Returns addresses and ABIs.
export async function deployLocal({ pub, wallet, chain, deployer, usdfc, log = () => {} }) {
  for (const a of FVM_PRECOMPILES) await pub.request({ method: "anvil_setCode", params: [a, FVM_STUB] });
  const ABI = Object.fromEntries(NAMES.map((n) => [n, artifact(n).abi]));
  const deploy = async (name, args = [], libs = {}) => {
    const a = artifact(name);
    const bytecode = Object.keys(a.links).length ? link(a.bytecode, a.links, libs) : a.bytecode;
    const hash = await wallet.deployContract({ account: deployer, abi: a.abi, bytecode, args, chain });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`deploy ${name} failed`);
    return getAddress(r.contractAddress);
  };
  const proxy = async (impl, abi, init, args = []) => {
    const { encodeFunctionData } = await import("viem");
    return deploy("ERC1967Proxy", [impl, encodeFunctionData({ abi, functionName: init, args })]);
  };
  const C = { usdfc };
  C.payments = await deploy("FilecoinPayV1");
  C.sessionKeys = await deploy("SessionKeyRegistry");
  C.pdp = await proxy(await deploy("PDPVerifier", [1n, 2n]), ABI.PDPVerifier, "initialize");
  C.registry = await proxy(await deploy("ServiceProviderRegistry", [1n]), ABI.ServiceProviderRegistry, "initialize");
  const libs = { SignatureVerificationLib: await deploy("SignatureVerificationLib"), Rails: await deploy("Rails") };
  const fwssImpl = await deploy("FilecoinWarmStorageService",
    [C.pdp, C.payments, usdfc, deployer, C.registry, C.sessionKeys, 1n], libs);
  // maxProvingPeriod 2880 epochs, challenge window 60 (FilOz's mainnet values), FilBeam controller unused
  C.fwss = await proxy(fwssImpl, ABI.FilecoinWarmStorageService, "initialize", [2880n, 60n, deployer]);
  C.view = await deploy("FilecoinWarmStorageServiceStateView", [C.fwss]);
  await write({ pub, wallet, chain }, deployer, C.fwss, ABI.FilecoinWarmStorageService, "setViewContract", [C.view]);
  C.cs = await deploy("ComputeService", [C.payments, usdfc, C.pdp, C.sessionKeys]);
  log("FOC contracts installed", C);
  return { C, ABI };
}

export async function write({ pub, wallet, chain }, account, address, abi, functionName, args = [], value) {
  const { request } = await pub.simulateContract({ account, address, abi, functionName, args, value });
  // local: a fixed budget (anvil estimates can be too low); Filecoin: estimate × 1.5 (FEVM gas units are much larger)
  const gas = chain.id === 31337 ? 15_000_000n
    : (await pub.estimateContractGas({ account, address, abi, functionName, args, value })) * 3n / 2n;
  const hash = await wallet.writeContract({ ...request, chain, gas });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}

// ---------------------------------------------------------------- provider registration

export async function registerProvider(ctx, provider, C, ABI, serviceURL) {
  const addr = typeof provider === "string" ? provider : provider.address; // provider: address or local account
  const id = await ctx.pub.readContract({ address: C.registry, abi: ABI.ServiceProviderRegistry,
    functionName: "getProviderIdByAddress", args: [addr] });
  if (id !== 0n) return { providerId: id };
  const [keys, values] = encodePDPCapabilities({
    serviceURL, minPieceSizeInBytes: 127n, maxPieceSizeInBytes: 1n << 30n, storagePricePerTibPerDay: parseEther("2.5"),
    minProvingPeriodInEpochs: 2880n, location: "local", paymentTokenAddress: "0x0000000000000000000000000000000000000000",
    ipniPiece: false, ipniIpfs: false,
  });
  const r = await write(ctx, provider, C.registry, ABI.ServiceProviderRegistry, "registerProvider",
    [addr, "PieceWork_demo", "Compute over PDP data (proof of concept, not a storage service)", 0, keys, values], parseEther("5"));
  const providerId = await ctx.pub.readContract({ address: C.registry, abi: ABI.ServiceProviderRegistry,
    functionName: "getProviderIdByAddress", args: [addr] });
  return { providerId, receipt: r };
}

// ---------------------------------------------------------------- client signatures (EIP-712, FWSS)

const domain = (chainId, fwss) => ({ name: "FilecoinWarmStorageService", version: "1", chainId, verifyingContract: fwss });

export async function signCreateDataSet(signer, { chainId, fwss, clientDataSetId, payee }) {
  const signature = await signer.signTypedData({
    domain: domain(chainId, fwss), types: EIP712Types, primaryType: "CreateDataSet",
    message: { clientDataSetId, payee, metadata: [] },
  });
  return signature;
}

export async function signAddPieces(signer, { chainId, fwss, clientDataSetId, nonce, cids }) {
  return signer.signTypedData({
    domain: domain(chainId, fwss), types: EIP712Types, primaryType: "AddPieces",
    message: { clientDataSetId, nonce, pieceData: cids.map((c) => ({ data: c })), pieceMetadata: [] },
  });
}

export const createDataSetExtraData = (payer, clientDataSetId, signature) =>
  encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "string[]" }, { type: "string[]" }, { type: "bytes" }],
    [payer, clientDataSetId, [], [], signature]);

export const addPiecesExtraData = (nonce, signature) =>
  encodeAbiParameters([{ type: "uint256" }, { type: "string[][]" }, { type: "string[][]" }, { type: "bytes" }],
    [nonce, [], [], signature]);

export const randomNonce = () => BigInt(toHex(crypto.randomBytes(31)));

// ---------------------------------------------------------------- pieces

/// Piece CID (CommPv2) of a file, as bytes (hex) for PDPVerifier, and as the usual string.
export async function pieceCid(bytes) {
  const cid = await Piece.calculate(new Uint8Array(bytes));
  return { hex: toHex(cid.bytes), text: cid.toString() };
}
