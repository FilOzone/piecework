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

    # build first: cargo update -p tempfile is needed because sp1-prover 6.9.0 wants a newer
    # tempfile than resolves by default. Takes about three minutes.
    docker run --rm -v "$PWD:/work" -w /work piecework/sp1:v6 \
      sh -c 'cargo update -p tempfile && cargo build --release'

    # then run it over any file you like — `in/` is not in the repo, so supply your own input
    mkdir -p in && cp ../../data/dataset/meeting-notes.txt in/notes.txt
    docker run --rm -v "$PWD:/work" -w /work piecework/sp1:v6 \
      sh -c './target/release/piecework --execute --term revenue in/notes.txt'

`--execute` runs the guest and reports cycles and both commitments without proving anything. It is fast, and
it is the right way to check a guest before paying for a proof.

`--prove` produces the real thing. `--mode groth16` (the default) is the only one a contract can check. Note
that `--prove` needs more than the command above: SP1 shells out to `docker` for the wrap, so running it from
inside this container also needs the host's Docker socket mounted and `HOME`/`TMPDIR` set to paths that
resolve identically inside and out — otherwise the sibling container cannot see the witness. On an amd64 host
it is simpler to run the binary directly. See below.

## What does not work here, and why

**Groth16 proving cannot run on an Apple Silicon Mac at all, at any memory size.** SP1 performs the wrap by
spawning `ghcr.io/succinctlabs/sp1-gnark:<circuit version>` as a sibling container, and that image ships
**amd64 only**. The failure is `no matching manifest for linux/arm64/v8`. Note also that running this
toolchain *inside* a container fails earlier, with `Failed to run 'docker info'` — SP1 needs a reachable
daemon to spawn gnark, so the socket has to be mounted and the paths it passes must resolve identically on
both sides.

An earlier version of this file blamed memory: the wrap being OOM-killed with the 7.7 GiB Docker Desktop
holds by default. That ceiling is real and worth raising — Docker's allocation defaults to about 7.75 GiB
regardless of host RAM, so check `docker info --format '{{.MemTotal}}'` rather than the machine's spec — but
it is not the blocker. With 23 GiB given to Docker the run cleared memory and died on the manifest instead.

Under amd64 emulation the image does run (`gnark-cli --help` returns 0) but gnark was then killed with empty
stdout and stderr, consistent with OOM: the circuit alone is 7.9 GB and the reference run peaked at 17 GB in
low-memory mode and 33 without. `gnark-cli prove` exposes no low-memory flag, and SP1 spawns it with no env
passthrough, so `GOMEMLIMIT` cannot be injected either.

So the prover belongs on the provider's hardware for a harder reason than having more memory: it is amd64,
and this is the only hardware that can run the wrapper as shipped. The laptop's role is to show the guest is
correct, which `--execute` does.

## Versions

The verifier deployed at `0x3097f8d9…` is SP1 **v4.0.0-rc.3**, chosen to match the fixture it was tested
against. This toolchain is **v6.9.0**. A v6 proof will not verify against a v4 verifier, so the matching
verifier has to be deployed before the first real proof is checked on chain. Mechanical, and cheap.

Two build notes that cost an hour each:

- `native-gnark` builds gnark from source and needs a Go dependency that can no longer be fetched
  (`gnark-ignition-verifier`'s pseudo-version resolves to a git fetch that 404s). Without the feature, SP1
  uses its own prebuilt artifacts and the build succeeds.
- `sp1-prover` 6.9.0 needs a newer `tempfile` than resolves by default: `cargo update -p tempfile`.
