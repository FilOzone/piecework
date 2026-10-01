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
HEIGHT="${HEIGHT:-480}"
CRF="${CRF:-28}"
PRESET="${PRESET:-veryfast}"
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
  ffmpeg -nostdin -loglevel error -y -i "$f" \
    -vf "scale=-2:${HEIGHT}" -c:v libx264 -preset "$PRESET" -crf "$CRF" \
    -c:a aac -b:a 96k "/out/${stem}-${HEIGHT}p.mp4"
  dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f" 2>/dev/null || echo 0)
  at=$(awk -v d="$dur" 'BEGIN { printf "%.2f", (d > 0 ? d / 10 : 0) }')
  ffmpeg -nostdin -loglevel error -y -ss "$at" -i "$f" -frames:v 1 -vf "scale=-2:360" "/out/${stem}-thumb.jpg" || true
  out=$(stat -c %s "/out/${stem}-${HEIGHT}p.mp4" 2>/dev/null || stat -f %z "/out/${stem}-${HEIGHT}p.mp4")
  total_in=$((total_in + src)); total_out=$((total_out + out)); n=$((n + 1))
  printf '%s\n  in  %s bytes\n  out %s bytes at %sp\n' "$base" "$src" "$out" "$HEIGHT" >> "$REPORT"
  awk -v a="$src" -v b="$out" 'BEGIN { printf "  %.1fx smaller\n\n", (b > 0 ? a / b : 0) }' >> "$REPORT"
done
[ "$n" -gt 0 ] || { echo "no video in /in" >&2; exit 1; }
printf 'Videos: %s\nRead: %s bytes\nProduced: %s bytes\n' "$n" "$total_in" "$total_out" >> "$REPORT"
awk -v a="$total_in" -v b="$total_out" 'BEGIN { printf "\nHow the job ran: ffmpeg on CPU, libx264. %.1fx less came out than went in.\nNo GPU, no network. A provider with a sealing GPU can do the same with NVENC and far faster.\n", (b > 0 ? a / b : 0) }' >> "$REPORT"
