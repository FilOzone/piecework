# piecework-lib

The piece commitment, in Rust, checked against a piece that really exists.

The guest program commits to the CIDs of the pieces it was handed, and ComputeService computes the same CIDs
on chain from piece ids it already holds. The two must agree byte for byte or every proof is refused — and the
symptom is indistinguishable from a broken prover, which is an expensive thing to debug from the wrong end.

So the derivation lives here rather than inside the guest, where it can only be observed through a proof:

    cargo test

`matches_a_piece_that_is_really_stored` reads `poc/jobs/transcribe/sample/working-group-call.m4a`, which is
piece 7 of data set 41739 on Calibration, and asserts the CID equals what `PDPVerifier.getPieceCid` returns
for it. `@filoz/synapse-core` computes the same value independently; `../check-commp.mjs` repeats that
comparison against the live chain.

## Building on a Mac

Build scripts are killed on at least one machine here — `cargo build` dies with SIGKILL inside `tiny-keccak`,
`typenum` and anything else with a `build.rs`, while a dependency-free crate builds fine. It is not disk and
not the directory; it looks like endpoint security refusing freshly written unsigned binaries.

A container is not subject to it:

    docker run --rm -v "$PWD:/work" -w /work rust:1.90-slim cargo test

Worth knowing before losing an afternoon to it.
