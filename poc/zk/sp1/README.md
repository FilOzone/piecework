# The prover

A guest program that runs inside SP1's zkVM and commits the two values ComputeService checks.

## What it does, and the one thing that matters

It reads the client's pieces, derives each one's Filecoin CID **from the bytes it was handed**, counts
occurrences of a term, derives the CID of the output it produced, and commits:

    inputCommitment  = keccak256(cid(piece_1) || cid(piece_2) || ...)
    outputCommitment = keccak256(cid(output))

Deriving the CIDs inside the zkVM is most of the cost and all of the point. A journal committing a hash of
bytes the prover chose proves a computation happened; it does not prove it happened over the data the client
pays to store. SP1ComputeVerifier refuses to look at the proof until these match what the contract worked out
for itself.

**This has been checked, not assumed.** Running the guest over a 153-byte file:

    inputCommitment from inside the zkVM : 0x2f27f1797f02165e3ddaeaab8ac886d9e5d714d5351dd548866494b564eac450
    the same file through synapse-core    : 0x2f27f1797f02165e3ddaeaab8ac886d9e5d714d5351dd548866494b564eac450

149,079 cycles for those 153 bytes.

## Building and running

Everything happens in a container. Two reasons: this machine kills freshly built binaries that have a
`build.rs` (SIGKILL, every time, while a dependency-free crate builds fine), and the toolchain is large
enough that you do not want it twice.

    docker build -t piecework/sp1:v6 .
    docker run --rm -v "$PWD:/work" -w /work piecework/sp1:v6 \
      sh -c './target/release/piecework --execute --term sealing in/notes.txt'

`--execute` runs the guest and reports cycles and both commitments without proving anything. It is fast, and
it is the right way to check a guest before paying for a proof.

`--prove` produces the real thing. `--mode groth16` (the default) is the only one a contract can check.

## What does not work here, and why

**Groth16 proving will not fit on this machine.** The wrapping step was OOM-killed with 7.7 GiB, which is all
Docker Desktop is given of the Mac's 24. The published reference run peaked at 17 GB in low-memory mode and
33 without, on a 64 GB machine. Raising Docker's allocation is not enough on a 24 GB laptop.

That is not a problem to solve here. The prover belongs on the provider's hardware — it is the party that
holds the data and runs the job — and a storage provider's machine has the memory. The laptop's role was only
ever to show the guest is correct, which `--execute` does.

## Versions

The verifier deployed at `0x3097f8d9…` is SP1 **v4.0.0-rc.3**, chosen to match the fixture it was tested
against. This toolchain is **v6.9.0**. A v6 proof will not verify against a v4 verifier, so the matching
verifier has to be deployed before the first real proof is checked on chain. Mechanical, and cheap.

Two build notes that cost an hour each:

- `native-gnark` builds gnark from source and needs a Go dependency that can no longer be fetched
  (`gnark-ignition-verifier`'s pseudo-version resolves to a git fetch that 404s). Without the feature, SP1
  uses its own prebuilt artifacts and the build succeeds.
- `sp1-prover` 6.9.0 needs a newer `tempfile` than resolves by default: `cargo update -p tempfile`.
