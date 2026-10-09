# Proving the job ran — the off-chain half

**Nothing here has been compiled or run.** It was written on a machine with no Rust toolchain, as something
to read and argue with rather than something to trust. Every claim below is a claim about what the code is
*meant* to do. Treat the commP implementation in particular as a sketch against the spec that has never been
checked against a real piece, which is the one thing that would actually validate it.

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

## The piece of this that is most likely wrong

`commp.rs` computes what it believes is the piece CID. Getting that byte-exact matters absolutely — a
commitment that is one byte different is a commitment to nothing — and there are two encodings in play:

- **PieceCID v1** (`baga…`): codec fil-commitment-unsealed `0xf101`, multihash sha2-256-trunc254-padded `0x1012`.
- **PieceCID v2** (`bafkzcib…`): codec raw `0x55`, multihash fr32-sha256-trunc254-padbintree `0x1011`, which
  also carries the tree height and the amount of real data.

The pieces in this POC's data sets are v2 — `bafkzcib…` is what the provider stores and what
`PDPVerifier.getPieceCid` returns. Whatever the guest computes has to equal those bytes exactly.

**How to check it, before trusting any of this:** take a piece already in data set 41739, run `commp.rs`
over the original file off-chain, and compare the result to what `getPieceCid` returns. If they differ, the
proof will never verify and no amount of SP1 debugging will explain why. That test costs ten minutes and is
worth more than everything else in this directory.

## Shape

    host/    reads the input files, runs the prover, abi-encodes (publicValues, proofBytes)
             into the single `bytes` argument commitOutputs takes.
    guest/   runs inside the zkVM: derives the input CIDs, does the work, derives the output
             CID, and commits (inputCommitment, outputCommitment) to the journal.

The job itself is deliberately tiny — counting occurrences of a term across the input pieces. Not because it
is useful, but because the interesting part is the binding, and a cheap job keeps the proving time low enough
that the binding can be tested at all. Jennifer Wang's demo proved an aggregation over a 5.4 MB slice in
140 minutes of CPU proving; anything larger here would make the first end-to-end run impractical.

## What is still missing after this

- The provider kit does not spawn a prover. Nothing calls the host binary.
- `ComputeService` as deployed on Calibration predates the verifier parameter, so a verified job cannot be
  ordered yet. It needs redeploying, which moves its address.
- The SP1 verifier deployed at `0x3097f8d9…` is v4.0.0-rc.3, matching the fixture it was tested against. A
  prover emitting a different version needs either a matching verifier or the gateway in front of it.
