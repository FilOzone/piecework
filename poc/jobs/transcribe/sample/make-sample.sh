#!/usr/bin/env bash
# Turn call-script.txt into an audio file to test transcribe:v1 against.
#
# Why a scripted call exists at all, next to real recordings: it is two megabytes, it regenerates from a text
# file, and every word in it is invented, so it can live in a public repo and be used in tests. Real footage
# proves the job works on real speech; this proves it still works tomorrow.
#
# Needs macOS (it uses `say` for the voices) and Docker (it uses ffmpeg to join them). The result is checked
# in, so nobody has to run this unless the script changes.
#
#   ./make-sample.sh            -> working-group-call.m4a
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-working-group-call.m4a}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# One voice per speaker, deliberately mixed in accent and pitch. A single voice reading every part transcribes
# suspiciously well, which would make the test easier than reality rather than harder.
voice_for() {
  case "$1" in
    NADIA) echo "Karen"  ;;   # Australian
    TOM)   echo "Daniel" ;;   # British
    AOIFE) echo "Moira"  ;;   # Irish
    FRED)  echo "Fred"   ;;   # American
    *)     echo "Alex"   ;;
  esac
}

n=0
: > "$TMP/list.txt"
while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  speaker="${line%%:*}"
  text="${line#*: }"
  [[ "$speaker" == "$line" ]] && continue
  n=$((n + 1))
  f="$(printf '%s/%04d.aiff' "$TMP" "$n")"
  say -v "$(voice_for "$speaker")" -o "$f" --file-format=AIFF "$text"
  printf "file '%s'\n" "$f" >> "$TMP/list.txt"
done < call-script.txt

echo "$n turns spoken, joining…"
# ffmpeg writes inside $TMP and the result is copied out afterwards, rather than mounting the repo directory.
# Docker Desktop refuses to mount paths under ~/Documents on this machine, and that failure looks like an
# ffmpeg error rather than a permissions one, which costs an afternoon if you have not seen it before.
docker run --rm --entrypoint ffmpeg -v "$TMP:$TMP" piecework/transcode:v1 \
  -hide_banner -loglevel error -y -f concat -safe 0 -i "$TMP/list.txt" \
  -c:a aac -b:a 64k "$TMP/out.m4a"
cp "$TMP/out.m4a" "$OUT"

ls -lh "$OUT"
