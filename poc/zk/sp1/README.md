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

    # Mount poc/, not sp1/. piecework-lib lives at poc/zk/lib and its commP test reaches its fixture at
    # poc/jobs/transcribe/sample/, so a narrower mount builds but cannot run the test that matters.
    cd ../../..            # to poc/
    docker run --rm -v "$PWD:/work" -w /work/zk/sp1 piecework/sp1:v6 \
      sh -c 'cargo build --release'

    # the derivation against a piece really stored on Calibration — run this after any commp.rs change
    docker run --rm -v "$PWD:/work" -w /work/zk/sp1 piecework/sp1:v6 \
      sh -c 'cargo test --release --manifest-path ../lib/Cargo.toml'

    # then run it over any file you like — `in/` is not in the repo, so supply your own input
    mkdir -p zk/sp1/in && cp jobs/transcribe/sample/call-script.txt zk/sp1/in/notes.txt
    docker run --rm -v "$PWD:/work" -w /work/zk/sp1 piecework/sp1:v6 \
      sh -c './target/release/piecework --execute --term sealing in/notes.txt'

`Cargo.lock` is committed, which pins both `tempfile` (`sp1-prover` 6.9.0 calls a method that only exists
in a version newer than resolves by default) and the patched `sha2` below. Build from the lock and neither
needs a manual `cargo update`.

`--execute` runs the guest and reports cycles, both commitments, and the syscalls it made, without proving
anything. It is fast, and it is the right way to check a guest before paying for a proof.

## What the binding costs

Measured with `--execute` over deterministic inputs from 128 B to 1 MB, counting cycles and syscalls:

| input | cycles, stock `sha2` | cycles, patched | cycles/byte |
|---|---|---|---|
| 4 KB | 2,802,994 | 970,310 | 237 |
| 64 KB | 43,898,216 | 14,893,692 | 227 |
| 256 KB | 175,396,179 | 59,441,767 | 227 |
| 1 MB | 701,384,698 | 237,630,734 | 227 |

**Linear, with no economy of scale.** 669 cycles/byte before the patch, **227 after**, flat across four
orders of magnitude. The fixed overhead is only ~60k cycles, so cost is essentially `227 × input bytes`.

Two things follow, and they are the constraint on the whole feature:

- **`[patch.crates-io]` for `sha2` is not optional, it is 2.95× of the cost.** Without it `--execute`
  reports `syscalls: none` and every compression in the merkle tree runs as interpreted RISC-V. A patch
  that fails to apply looks exactly like no patch, so check the `syscalls` line, not the build log.
- **Proving is affordable only over small inputs.** For comparison, a published SP1 run over a 5.4 MB
  slice took 59.5M guest cycles and 140 minutes to prove on a laptop CPU. 59.5M cycles is **256 KB** for
  us. So a proof-gated job belongs on a slice of a piece, not on a piece: the 1.07 GB maximum piece size
  would be ~243 **billion** cycles.

The reason we are ~20× more expensive per byte than that run is the binding itself. It commits
`sha256` of the bytes it was handed — one linear pass. We derive the Filecoin piece CID: fr32 padding and
a merkle tree, which is what makes the proof about *the piece the client stored* rather than about bytes
the prover chose. That is the property worth having, and this is its price.

The obvious way to escape the linear cost is to prove over a **sub-slice plus a merkle path** to the piece
root, so the guest pays for the slice and `log n` hashes instead of re-deriving the whole tree. Not built,
and it would need the contract to accept a slice commitment rather than a whole-piece one.

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

## "couldn't read sp1-core-executor-runner-binary"

The host build fails with:

```
couldn't read /usr/local/cargo/registry/src/index.crates.io-.../sp1-core-executor-runner-6.9.0/
  target/sp1-native-bins/release/sp1-core-executor-runner-binary: No such file or directory
```

and it fails again on every retry, including after a `git pull`. Clean this one package and it builds:

```bash
docker run --rm -v "$PWD/poc:/work" -v piecework-cargo:/usr/local/cargo/registry \
  -w /work/zk/sp1 piecework/sp1:v6 cargo clean --release -p sp1-core-executor-runner
```

Why it happens, because the error says none of it. `sp1-core-executor-runner` builds a helper binary
*inside the cargo registry's own source directory* and reads it back. If an earlier build ran without the
`piecework-cargo` volume mounted, it wrote that helper into a registry that vanished with the container —
but left its build-script result cached in `poc/zk/sp1/target`, still pointing at the path where the helper
used to be.

Cargo would normally notice and rerun the build script. It cannot here: files unpacked from the registry
carry a fixed 2006 timestamp, so the fingerprint never looks stale, and cargo reuses a cached result that
refers to a file no longer on disk. Nothing about the error suggests a stale cache, which is why it reads
as a broken dependency and survives a pull.

Any machine with a target directory from a build that did not mount the volume will hit this. Diagnosed by
the provider, on his machine, after it cost him two failed builds.
