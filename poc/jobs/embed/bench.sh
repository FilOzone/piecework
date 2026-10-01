#!/usr/bin/env bash
# CPU against GPU, same model, same chunks, same corpus — the only difference is the execution provider.
#
#   ./bench.sh /path/to/documents
#
# Build both images first:
#   docker build -t piecework/embed:v1 .
#   docker build -f Dockerfile.gpu -t piecework/embed-gpu:v1 .
#
# The GPU image needs the nvidia container toolkit. If it is missing, docker says so and this stops rather
# than quietly falling back to the CPU and reporting a speed-up of one.
set -euo pipefail
IN="${1:?give me a folder of documents}"
OUT="$(mktemp -d)"
run() { # image, label
  local out="$OUT/$2"; mkdir -p "$out"
  local extra=(); [ "$2" = gpu ] && extra=(--gpus all)
  docker run --rm --network none "${extra[@]}" -v "$(cd "$IN" && pwd):/in:ro" -v "$out:/out" "$1" >/dev/null 2>&1
  grep -E "^How the job ran" "$out/embeddings-report.txt" | sed "s/^/  $2: /"
  grep -oE "\(([0-9.]+) chunks/s\)" "$out/embeddings-report.txt" | tr -dc '0-9.'
}
echo "corpus: $(ls -1 "$IN" | wc -l | tr -d ' ') files, $(du -sh "$IN" | cut -f1)"
echo
C=$(run piecework/embed:v1 cpu)
G=$(run piecework/embed-gpu:v1 gpu)
echo
echo "cpu: $C chunks/s"
echo "gpu: $G chunks/s"
awk -v c="$C" -v g="$G" 'BEGIN { if (c > 0) printf "the GPU is %.1fx the CPU on this machine\n", g / c }'
rm -rf "$OUT"
