// Does our piece CID derivation match what the chain actually stores?
//
// This is the check that gates everything else in this directory. The guest program commits to the CIDs of
// the pieces it was given, and ComputeService computes the same CIDs from piece ids it already holds. If the
// two disagree by one byte, no proof ever verifies, and the symptom is indistinguishable from a broken
// prover — which is a very expensive thing to debug from the wrong end.
//
//   node check-commp.mjs
//
// Needs @filoz/synapse-core, which the provider kit already has:
//   cd ../provider-kit && node ../zk/check-commp.mjs

import { piece } from "@filoz/synapse-core";
import { createPublicClient, http } from "viem";
import fs from "node:fs";

const RPC = "https://api.calibration.node.glif.io/rpc/v1";
const PDP = "0x85e366Cf9DD2c0aE37E963d9556F5f4718d6417C";
const DATA_SET = 41739n;
const PIECE_ID = 7n;  // the four-voice sample call, uploaded 2026-10-09
const FILE = new URL("../jobs/transcribe/sample/working-group-call.m4a", import.meta.url);

const abi = [{
  type: "function", name: "getPieceCid", stateMutability: "view",
  inputs: [{ type: "uint256" }, { type: "uint256" }],
  outputs: [{ type: "tuple", components: [{ name: "data", type: "bytes" }] }],
}];

const bytes = new Uint8Array(fs.readFileSync(FILE));
const cid = await piece.calculate(bytes);
const computed = "0x" + Buffer.from(cid.bytes).toString("hex");

const client = createPublicClient({ transport: http(RPC) });
const onChain = (await client.readContract({
  address: PDP, abi, functionName: "getPieceCid", args: [DATA_SET, PIECE_ID],
})).data;

console.log("file      ", bytes.length, "bytes");
console.log("computed  ", computed);
console.log("on chain  ", onChain);
console.log(computed === onChain ? "MATCH" : "DIFFERENT — fix this before writing any prover");

// The layout, for anyone porting it: CIDv1 | raw | varint(0x1011) | len | varint(padding) | height | root,
// where padding is the unpadded capacity at that height minus the payload length.
const b = Buffer.from(cid.bytes);
const height = piece.heightFor(bytes.length);
console.log("\nheight    ", height);
// paddedSizeAtHeight returns a BigInt, and at large heights it exceeds Number.MAX_SAFE_INTEGER, so the
// arithmetic stays in BigInt — the padded size is always a multiple of 128, so the division is exact.
console.log("padding   ", (piece.paddedSizeAtHeight(height) / 128n * 127n - BigInt(bytes.length)).toString());
console.log("root      ", "0x" + b.subarray(b.length - 32).toString("hex"));
if (computed !== onChain) process.exit(1);
