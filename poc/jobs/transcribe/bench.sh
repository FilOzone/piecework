#!/usr/bin/env bash
# What does a card bought for sealing actually buy, for transcription?
#
# The question only has an answer if one thing changes at a time, so this times three runs over the SAME
# recording:
#
#   1. small on the processor      the baseline anyone can reproduce without special hardware
#   2. small on the card           same model, different device -> this difference IS the hardware
#   3. large-v3-turbo on the card  same device, bigger model    -> what the extra capacity buys
#
# Comparing 1 against 3 directly, which is the tempting thing to do, changes the model and the device
# together and the result cannot be attributed to either.
#
# The test recording is "Moonwalk One" (US National Archives, 1970): 95 minutes, public domain, real
# narration over real mission radio, so the audio is genuinely hard rather than a clean studio read. It is
# downloaded here rather than shipped, because it is 412 MB.
#
#   ./bench.sh                 run all three
#   ./bench.sh /path/file.mp4  use your own recording instead
set -euo pipefail
cd "$(dirname "$0")"
WORK="${WORK:-$HOME/piecework-bench}"
mkdir -p "$WORK/in" "$WORK/out"

MEDIA="${1:-}"
if [ -z "$MEDIA" ]; then
  MEDIA="$WORK/in/moonwalk-one.mp4"
  if [ ! -f "$MEDIA" ]; then
    echo "Fetching the test recording (412 MB, public domain)…"
    curl -# -L -o "$MEDIA" \
      "https://archive.org/download/gov.archives.arc.1257628/gov.archives.arc.1257628_512kb.mp4"
  fi
else
  cp "$MEDIA" "$WORK/in/"
fi

run() {  # name, image, extra docker args, env
  local label="$1" image="$2"; shift 2
  rm -f "$WORK/out"/* 2>/dev/null || true
  echo
  echo "=== $label ==="
  local t0 t1
  t0=$(date +%s)
  docker run --rm --network none "$@" \
    -v "$WORK/in:/in:ro" -v "$WORK/out:/out" "$image"
  t1=$(date +%s)
  echo "--- $label: $(( t1 - t0 )) seconds wall clock"
  grep -E "real time|How the job ran" "$WORK/out/transcribe-report.txt" || true
}

run "1. small, processor"        piecework/transcribe:v1
run "2. small, card"             piecework/transcribe-gpu:v1 --gpus all -e MODEL_DIR=/models/small -e COMPUTE_TYPE=float32
run "3. large-v3-turbo, card"    piecework/transcribe-gpu:v1 --gpus all

echo
echo "Run 1 against 2 for what the hardware is worth; 2 against 3 for what the bigger model costs."
