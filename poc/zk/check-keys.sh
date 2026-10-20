#!/usr/bin/env bash
# Do the committed guests still match every catalogue that names them?
#
#   ./poc/zk/check-keys.sh             # read the keys out of the committed ELFs and check the catalogues
#   ./poc/zk/check-keys.sh --rebuild   # also rebuild the guests and check the committed ELFs reproduce
#
# This exists because the same fault has now happened twice, and both times it was silent. A guest ELF is
# the job's identity on chain: if the committed ELF and the catalogue disagree, every proof is refused for
# a key nothing recognises, which is indistinguishable from forgery and costs ten minutes to discover.
#
# The first time, a guest was regenerated and a catalogue was not. The second, an ELF was committed that
# did not correspond to its own source -- a doc comment had been edited after the build, and Rust embeds
# file and line for panic locations, so the bytes moved while the size did not.
#
# --rebuild is the stronger check and the slow one. It is the one that would have caught the second fault.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
POC="$(cd "$HERE/.." && pwd)"
IMAGE="${IMAGE:-piecework/sp1:v6}"
REBUILD=0
[ "${1:-}" = "--rebuild" ] && REBUILD=1

run() { docker run --rm -v "$POC:/work" -v piecework-cargo:/usr/local/cargo/registry \
          -v piecework-sp1:/root/.sp1 -w /work/zk/sp1 "$IMAGE" sh -c "$1"; }

fail=0

if [ "$REBUILD" = 1 ]; then
  echo "Rebuilding both guests and comparing with what is committed…"
  # The guests must be built with the repository at /work; build.rs refuses otherwise, and that refusal is
  # the whole reason this is reproducible at all.
  out=$(run 'rm -rf target/elf-compilation; touch script/build.rs
    REBUILD_GUEST=1 cargo build --release >/dev/null 2>&1
    D=target/elf-compilation/riscv64im-succinct-zkvm-elf/release
    for g in piecework-program piecework-program-flat; do
      case $g in piecework-program) c=program/elf/$g;; *) c=program-flat/elf/$g;; esac
      a=$(sha256sum "$D/$g" | cut -d" " -f1); b=$(sha256sum "$c" | cut -d" " -f1)
      [ "$a" = "$b" ] && echo "ok   $g reproduces" || echo "FAIL $g: rebuilt $a, committed $b"
    done')
  echo "$out"
  echo "$out" | grep -q FAIL && fail=1
fi

echo "Reading the keys out of the committed guests…"
keys=$(run './target/release/piecework --vkey --guest bound 2>/dev/null
            ./target/release/piecework --vkey --guest attested 2>/dev/null')
bound=$(echo "$keys" | sed -n 1p); attested=$(echo "$keys" | sed -n 2p)
case "$bound$attested" in 0x*0x*) ;; *)
  echo "FAIL could not read both keys — the host binary is missing or will not build."
  echo "     If the build failed with \"couldn't read ...sp1-core-executor-runner-binary\", a stale"
  echo "     build-script result is pointing at a helper that no longer exists, and cargo cannot see that"
  echo "     it is stale because registry files carry a fixed 2006 timestamp. Clean that one package:"
  echo "       docker run --rm -v \"\$PWD/poc:/work\" -v piecework-cargo:/usr/local/cargo/registry \\"
  echo "         -w /work/zk/sp1 $IMAGE cargo clean --release -p sp1-core-executor-runner"
  exit 1;; esac
echo "  bound    $bound"
echo "  attested $attested"

# Every file that names a key has to name one of these two, and both have to appear somewhere.
echo "Checking the catalogues…"
cd "$POC" || exit 1
for f in start.mjs client-kit/jobs.json zk/order-proved-job.mjs provider-kit/jobs.json web/config.json; do
  for k in $(grep -oE '0x00[0-9a-f]{62}' "$f" | sort -u); do
    if [ "$k" != "$bound" ] && [ "$k" != "$attested" ]; then
      echo "FAIL $f names $k, which is neither committed guest"; fail=1
    fi
  done
done
for k in "$bound" "$attested"; do
  grep -rql "$k" start.mjs client-kit/jobs.json provider-kit/jobs.json web/config.json 2>/dev/null \
    || { echo "FAIL $k is in no catalogue"; fail=1; }
done

[ "$fail" = 0 ] && echo "All catalogues agree with the committed guests." || echo "Mismatch — see FAIL above."
exit "$fail"
