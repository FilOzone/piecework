#!/bin/sh
# PieceWork job: re-encode the client's video where it is stored, and send back something far smaller.
#
# Contract: inputs in /in (read-only), results in /out, no network.
#   /out/<name>-<height>p.mp4   the re-encoded video
#   /out/<name>-thumb.jpg       a frame from a tenth of the way in, to see what it is without fetching it
#   /out/transcode-report.txt   what came in, what went out, and by how much it shrank
#
# This is the job where the argument needs no explaining: the input is gigabytes, the output is a fraction of
# it, and moving the original across a network to do the work costs more than the work.
set -eu
# A ceiling, not a target. Asking for 480p unconditionally upscales anything smaller, which costs time and
# produces a file larger than the one it replaced — a 95 minute 320x240 film came back 1.7x bigger than the
# source and the report cheerfully called it "0.6x smaller". Video that is already below the ceiling is
# re-encoded at its own size.
HEIGHT="${HEIGHT:-480}"
# One script, two encoders. The CPU and the card do not take the same flags — x264 wants -crf and names its
# presets in English, NVENC wants a rate-control mode with -cq and names its presets p1..p7 — so the
# difference is settled here rather than by keeping a second copy of this file in step with the first.
ENCODER="${ENCODER:-libx264}"
case "$ENCODER" in
  *nvenc*)
    PRESET="${PRESET:-p4}"
    QUALITY="-rc vbr -cq ${CQ:-28} -b:v 0"
    # Decode on the card as well, so the frames never cross back to main memory between decode and encode.
    DECODE="-hwaccel cuda"
    WHERE="GPU, $ENCODER" ;;
  *)
    PRESET="${PRESET:-veryfast}"
    QUALITY="-crf ${CRF:-28}"
    DECODE=""
    WHERE="CPU, $ENCODER" ;;
esac
REPORT=/out/transcode-report.txt
: > "$REPORT"
printf 'Transcode: your video, re-encoded where it is stored\n\n' >> "$REPORT"
total_in=0; total_out=0; n=0
for f in /in/*; do
  [ -f "$f" ] || continue
  case "$(printf '%s' "$f" | tr 'A-Z' 'a-z')" in
    *.mp4|*.mov|*.mkv|*.avi|*.webm|*.m4v) ;;
    *) continue ;;
  esac
  base=$(basename "$f"); stem=${base%.*}
  src=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f")
  # shellcheck disable=SC2086  # $QUALITY and $DECODE are several flags and must word-split
  ffmpeg -nostdin -loglevel error -y $DECODE -i "$f" \
    -vf "scale=-2:'min(${HEIGHT},ih)'" -c:v "$ENCODER" -preset "$PRESET" $QUALITY \
    -c:a aac -b:a 96k "/out/${stem}-${HEIGHT}p.mp4"
  dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f" 2>/dev/null || echo 0)
  at=$(awk -v d="$dur" 'BEGIN { printf "%.2f", (d > 0 ? d / 10 : 0) }')
  ffmpeg -nostdin -loglevel error -y -ss "$at" -i "$f" -frames:v 1 -vf "scale=-2:360" "/out/${stem}-thumb.jpg" || true
  out=$(stat -c %s "/out/${stem}-${HEIGHT}p.mp4" 2>/dev/null || stat -f %z "/out/${stem}-${HEIGHT}p.mp4")
  total_in=$((total_in + src)); total_out=$((total_out + out)); n=$((n + 1))
  srch=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=nw=1:nk=1 "$f" 2>/dev/null || echo "?")
  outh=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=nw=1:nk=1 "/out/${stem}-${HEIGHT}p.mp4" 2>/dev/null || echo "?")
  printf '%s\n  in  %s bytes at %sp\n  out %s bytes at %sp\n' "$base" "$src" "$srch" "$out" "$outh" >> "$REPORT"
  # Say which way it went. Calling a file that grew "0.6x smaller" is worse than saying nothing.
  awk -v a="$src" -v b="$out" 'BEGIN {
    if (b > a) printf "  %.1fx LARGER — the source was already small or very efficiently encoded\n\n", b / a;
    else printf "  %.1fx smaller\n\n", (b > 0 ? a / b : 0) }' >> "$REPORT"
done
[ "$n" -gt 0 ] || { echo "no video in /in" >&2; exit 1; }
printf 'Videos: %s\nRead: %s bytes\nProduced: %s bytes\n' "$n" "$total_in" "$total_out" >> "$REPORT"
awk -v a="$total_in" -v b="$total_out" -v w="$WHERE" 'BEGIN { printf "\nHow the job ran: ffmpeg, %s. %.1fx less came out than went in. No network.\n", w, (b > 0 ? a / b : 0) }' >> "$REPORT"
