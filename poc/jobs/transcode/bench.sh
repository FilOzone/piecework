#!/usr/bin/env bash
# What does the card's video encoder buy, for re-encoding?
#
# Two runs over the SAME video, changing one thing:
#
#   1. libx264 on the processor      the baseline anyone can reproduce
#   2. h264_nvenc on the card        NVENC, a fixed-function block that does not touch the shaders
#
# Read the result with one caveat in mind, because the obvious comparison is misleading. These are not two
# encoders aiming at the same output: x264 at a given file size looks better than NVENC at that size. If the
# card's output is larger, that is the trade, not a fault. What the card buys is throughput — and the fact it
# can do this while the shaders run something else, which is the part no benchmark here can show.
#
# The test video is "Moonwalk One" (US National Archives, 1970), 95 minutes, public domain, 412 MB. It is
# downloaded rather than shipped.
#
#   ./bench.sh                 run both
#   ./bench.sh /path/file.mp4  use your own video instead
set -euo pipefail
cd "$(dirname "$0")"
WORK="${WORK:-$HOME/piecework-bench-transcode}"
mkdir -p "$WORK/in" "$WORK/out"

MEDIA="${1:-}"
if [ -z "$MEDIA" ]; then
  if [ ! -f "$WORK/in/moonwalk-one.mp4" ]; then
    echo "Fetching the test video (412 MB, public domain)…"
    curl -# -L -o "$WORK/in/moonwalk-one.mp4" \
      "https://archive.org/download/gov.archives.arc.1257628/gov.archives.arc.1257628_512kb.mp4"
  fi
else
  cp "$MEDIA" "$WORK/in/"
fi

run() {
  local label="$1" image="$2"; shift 2
  rm -f "$WORK/out"/* 2>/dev/null || true
  echo
  echo "=== $label ==="
  local t0 t1
  t0=$(date +%s)
  docker run --rm --network none "$@" -v "$WORK/in:/in:ro" -v "$WORK/out:/out" "$image"
  t1=$(date +%s)
  echo "--- $label: $(( t1 - t0 )) seconds wall clock"
  grep -E "How the job ran|out .* bytes|smaller" "$WORK/out/transcode-report.txt" || true
  ls -l "$WORK/out"/*-480p.mp4 2>/dev/null | awk '{print "--- output: " $5 " bytes"}'
}

run "1. libx264, processor" piecework/transcode:v1
run "2. h264_nvenc, card"   piecework/transcode-gpu:v1 --gpus all

echo
echo "Wall clock is the number being compared. The output sizes will differ, and the larger one is not"
echo "automatically worse — see the note at the top of this script."
