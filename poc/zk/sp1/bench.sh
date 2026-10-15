#!/usr/bin/env bash
# How big an input can this machine prove, and what does it cost?
#
#   ./poc/zk/sp1/bench.sh
#
# Proving is memory-bound long before it is time-bound. On a 32 GB laptop with 23 GiB given to Docker it
# completes at 4 KB and is OOM-killed at 64 KB, in both cases within a couple of minutes — so the question
# is not how fast a machine proves but how much it can prove at all. That number decides whether proving
# has to work over slices of a file rather than whole files, which is a contract change, so it is worth
# measuring rather than guessing.
#
# Each size runs to completion or death and the script carries on, so one failure does not end the run.
# Expect several minutes per size: most of it is the Groth16 wrap, which costs about the same regardless.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
POC="$(cd "$HERE/../.." && pwd)"
IMAGE="${IMAGE:-piecework/sp1:v6}"
CACHE="${CACHE:-piecework-sp1}"        # named volume for the 1.6 GB Groth16 circuit, fetched once
SIZES="${SIZES:-4096 16384 65536 262144 1048576}"

command -v docker >/dev/null || { echo "docker is not on PATH"; exit 1; }

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Building $IMAGE (large: it carries the SP1 toolchain)…"
  docker build -t "$IMAGE" "$HERE" || exit 1
fi

if [ ! -x "$HERE/target/release/piecework" ]; then
  echo "Building the prover (a few minutes)…"
  docker run --rm -v "$POC:/work" -w /work/zk/sp1 "$IMAGE" cargo build --release || exit 1
fi

mkdir -p "$HERE/in"
echo
echo "Docker has $(docker info --format '{{.MemTotal}}' | awk '{printf "%.1f GiB", $1/1073741824}') of memory."
echo "That is the number that matters: the host's RAM is not what bounds this."
echo
printf '%10s  %12s  %10s  %s\n' BYTES SECONDS PEAK-GiB RESULT

for n in $SIZES; do
  f="in/bench-$n.bin"
  # Deterministic filler containing the term, so the guest does real work rather than scanning a uniform blob.
  [ -f "$HERE/$f" ] || python3 -c "
import sys
line = b'The payment terms fall due thirty days from the invoice date. '
n = int(sys.argv[1])
open(sys.argv[2],'wb').write((line * (n // len(line) + 1))[:n])
" "$n" "$HERE/$f"

  name="piecework-bench-$n-$$"
  start=$(date +%s)
  docker run --rm --name "$name" --network none \
    -v "$POC:/work:ro" -v "$CACHE:/root/.sp1" -v "$HERE/in:/in:ro" \
    -w /work/zk/sp1 "$IMAGE" \
    ./target/release/piecework --prove --mode groth16 --term payment --proof /tmp/p.json "/in/bench-$n.bin" \
    > "/tmp/$name.log" 2>&1
  code=$?
  secs=$(( $(date +%s) - start ))

  # 137 is SIGKILL, which here means the out-of-memory killer rather than anything the prover decided.
  if [ "$code" -eq 0 ]; then
    result="ok"
  elif [ "$code" -eq 137 ] || grep -qi "killed" "/tmp/$name.log"; then
    result="OUT OF MEMORY"
  else
    result="failed (exit $code) — see /tmp/$name.log"
  fi
  cycles=$(grep -o 'cycles *: *[0-9]*' "/tmp/$name.log" | tail -1 | tr -dc 0-9)
  printf '%10s  %12s  %10s  %s%s\n' "$n" "$secs" "-" "$result" \
    "${cycles:+  (${cycles} cycles)}"
done

echo
echo "What I need back: the largest size that says ok, and roughly the peak memory it reached"
echo "(docker stats in another terminal, or /usr/bin/time -v on Linux)."
