# Proving the job ran — the off-chain half

**The guest compiles and runs; no proof has ever been produced.** `sp1/` is the real implementation and has
been executed: over a 343-byte file it committed an `inputCommitment` matching what `synapse-core` computes
for the same file, in 244,144 cycles. The commP implementation is no longer a sketch — it is checked against
two real pieces and against the contract's own commitment. What has never happened is the Groth16 wrap, for
the reason in `sp1/README.md`: SP1 runs it in an amd64-only container, so no Apple Silicon machine can.

## What it is for

`ComputeService` can now be told to release the price only once a verifier contract is satisfied as well as
the delivery condition. `SP1ComputeVerifier` is that verifier for SP1 proofs, and it is deliberately hard to
please: it refuses to ask SP1 anything until the proof's journal commits to exactly the values the chain
worked out for itself — keccak over the CIDs of the pieces the job named as input, and keccak over the CIDs
of the pieces being delivered.

That constraint is the whole design, and it falls on the guest program. A journal that commits `sha256` of
some bytes proves a computation happened over bytes the prover chose. It does not prove the computation
happened over *the data the client is paying to store*. A provider could compute yesterday's slice honestly
and be paid for today's job. So the guest has to derive each piece's Filecoin CID from the bytes it was
given, and that is expensive: fr32 padding and a sha256 merkle tree over the whole input, before any useful
work starts.

## The piece that was most likely wrong, and is now checked

`commp.rs` computes the piece CID. Getting that byte-exact matters absolutely — a
commitment that is one byte different is a commitment to nothing — and there are two encodings in play:

- **PieceCID v1** (`baga…`): codec fil-commitment-unsealed `0xf101`, multihash sha2-256-trunc254-padded `0x1012`.
- **PieceCID v2** (`bafkzcib…`): codec raw `0x55`, multihash fr32-sha256-trunc254-padbintree `0x1011`, which
  also carries the tree height and the amount of real data.

The pieces in this POC's data sets are v2 — `bafkzcib…` is what the provider stores and what
`PDPVerifier.getPieceCid` returns. Whatever the guest computes has to equal those bytes exactly.

**This has been checked.** `check-commp.mjs` runs the derivation over piece 7 of data set 41739 — a real
3.9 MB piece — and compares it to what `PDPVerifier.getPieceCid` returns:

    computed  0x0155912024d9a70f11dfd6807767d544c2ef37c933a091b03f27ca72ef424464aa5dc5a542f45cdc04
    on chain  0x0155912024d9a70f11dfd6807767d544c2ef37c933a091b03f27ca72ef424464aa5dc5a542f45cdc04

Separately, the guest's own derivation inside the zkVM matches `keccak256(pieceCID)` from `synapse-core`
exactly. Had these differed, no proof would ever have verified and the symptom would have been
indistinguishable from a broken prover. Run `check-commp.mjs` again after any change to `commp.rs`.

## Shape

    sp1/        the real implementation, built and run. See sp1/README.md.
    sp1/script/ the host: reads the input files, runs the prover, abi-encodes
                (publicValues, proofBytes) into the single `bytes` argument commitOutputs takes.
    sp1/program/ runs inside the zkVM: derives the input CIDs, does the work, derives the
                output CID, and commits (inputCommitment, outputCommitment) to the journal.
    sp1/lib/    piecework-lib: commP and the commitments, shared by both, with tests.

    host/       the earlier v4 sketch, superseded by sp1/script. NEVER BUILT.
    guest/      the earlier v4 sketch, superseded by sp1/program. NEVER BUILT.

The job itself is deliberately tiny — counting occurrences of a term across the input pieces. Not because it
is useful, but because the interesting part is the binding, and a cheap job keeps the proving time low enough
that the binding can be tested at all. Jennifer Wang's demo proved an aggregation over a 5.4 MB slice in
140 minutes of CPU proving; anything larger here would make the first end-to-end run impractical.

## What is still missing after this

- The provider kit does not spawn a prover. Nothing calls the host binary.
- No Groth16 proof has been produced. SP1 performs the wrap by spawning `sp1-gnark`, which ships amd64 only,
  so it needs an amd64 machine with the memory for it — not a Mac. See `sp1/README.md`.
- The page cannot order a verified job: `poc/web/abi.json` carries only the 7-arg `postJob`, so the UI has no
  way to name a verifier. The contract half is done and deployed.
- The SP1 verifier deployed at `0x3097f8d9…` is v4.0.0-rc.3, matching the fixture it was tested against. A
  prover emitting a different version needs either a matching verifier or the gateway in front of it.
