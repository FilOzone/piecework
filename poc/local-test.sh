#!/usr/bin/env bash
# The same browser client, pointed at the provider on this machine instead of a real one.
#
#   ./local-test.sh        then open http://localhost:8099
#
# Why this exists: every change used to reach James before anyone had run it, and he pulled five times in two
# days. New jobs and new services get tried here first, against the stand-in provider the demo already runs,
# and only reach a real provider once they work. Nothing here is published and nothing here is shared.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HOME/piecework-runtime/local-client"   # outside ~/Documents: iCloud evicts files there and every
                                            # first read becomes a download — 92 s to import viem once.
rm -rf "$OUT"; mkdir -p "$OUT"
cp "$HERE"/web/*.html "$HERE"/web/*.mjs "$HERE"/web/*.json "$HERE"/web/*.svg "$OUT"/ 2>/dev/null || true
# Its own stamp, every time. The page passes this to the modules and to config.json, so a browser holding an
# older local build would otherwise keep serving it the provider list it had before.
sed -i '' "s/const V = \"[0-9-]*\"/const V = \"local-$(date +%Y%m%d-%H%M%S)\"/" "$OUT/index.html"

python3 - "$OUT" "$HERE" <<'PY'
import json, sys, pathlib
out, here = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
cfg = json.loads((out / "config.json").read_text())

# This machine is added as a second provider, not as a replacement: the real one stays so the same client can
# switch between them, and so anything tried here can be tried against James immediately afterwards.
cfg["providers"] = cfg.get("providers", []) + [{
    "id": "local",
    "name": "This machine (stand-in provider)",
    "address": "0xA0C38545600fe067D79Cac5215049eEb4BF387d0",
    "curioUrl": "http://localhost:8080",
    "note": "The provider running on your own laptop. Here to try new jobs before a real provider ever sees them.",
}]
# everything the local kit can run, including the two the public page does not offer
for name, job in {
    "query:v1": {"name": "Run my SQL over my tables", "price": "0.3",
                 "outputs": ["results.csv", "query-report.txt"], "deadlineEpochs": 40,
                 "inputExtensions": [".sql", ".csv", ".parquet", ".json", ".jsonl"]},
    "transcode:v1": {"name": "Re-encode my video, smaller", "price": "0.5",
                     "outputs": ["(named after your files)"], "deadlineEpochs": 80,
                     "inputExtensions": [".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]},
    # Transcription needs a long deadline on a CPU: the model runs at roughly real time there, so an hour of
    # audio is an hour of compute. The GPU build is where that stops being true.
    "transcribe:v1": {"name": "Transcribe my recordings, searchable by the moment", "price": "0.5",
                      "outputs": ["(a transcript, subtitles and segments per recording)"],
                      "deadlineEpochs": 240,
                      "inputExtensions": [".mp3", ".m4a", ".wav", ".flac", ".ogg", ".opus",
                                          ".mp4", ".mov", ".mkv", ".webm", ".m4v"]},
}.items():
    cfg["jobs"][name] = job
(out / "config.json").write_text(json.dumps(cfg, indent=2))
names = ", ".join(p["name"] for p in cfg["providers"])
print(f"local client ready: {len(cfg['jobs'])} jobs, {len(cfg.get('services', {}))} services")
print(f"providers: {names}")
print("note: SQL and video exist only on this machine — James's node would decline them.")
PY

echo
echo "open http://localhost:8099   (ctrl-c to stop)"
cd "$OUT" && exec python3 -m http.server 8099 --bind 127.0.0.1
