#!/usr/bin/env bash
# Takes: the V2 page, pointed at the provider on this machine.
#
#   ./v2/takes/serve.sh      then open http://localhost:8098
#
# It is not a second client. app.mjs, abi.json and config.json are copied from V1 unchanged, so the
# contracts, Filecoin Pay, Curio and the chain are all V1's code and cannot drift from it. Only index.html
# and takes.mjs are new, and all they do is drive one job and draw the chain of versions.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB="$(cd "$HERE/../../poc/web" && pwd)"
OUT="$HOME/piecework-runtime/takes"   # outside ~/Documents, same reason as the V1 build: iCloud eviction
rm -rf "$OUT"; mkdir -p "$OUT"
cp "$HERE"/index.html "$HERE"/takes.mjs "$OUT"/
cp "$WEB"/app.mjs "$WEB"/abi.json "$WEB"/foc-logo-icon.svg "$OUT"/

# The provider on this machine, added the same way the V1 build adds it, and for the same reason: a job
# nobody has built an image for cannot be tried anywhere else first.
python3 - "$OUT" "$WEB" <<'PY'
import json, sys, pathlib
out, web = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
cfg = json.loads((web / "config.json").read_text())
cfg["providers"] = cfg.get("providers", []) + [{
    "id": "local", "name": "This machine (stand-in provider)",
    "address": "0xA0C38545600fe067D79Cac5215049eEb4BF387d0",
    "curioUrl": "http://localhost:8080",
    "note": "The provider running on your own laptop.",
    "proving": True,
    "offers": ["video-gen:v1"],
    # This stand-in serves /play/<cid>: a browser-playable rendering of a take, beside the exact bytes at
    # /piece/<cid>. Real Curio does not, so only this entry claims it.
    "playRoute": True,
}]
(out / "config.json").write_text(json.dumps(cfg, indent=2) + "\n")
job = cfg["jobs"].get("video-gen:v1")
print(f"takes ready: {job['name']!r} at {job['price']} {cfg['token']} a take" if job
      else "WARNING: video-gen:v1 is not in the catalogue")
PY

sed -i '' "s/const V = \"[a-z0-9-]*\"/const V = \"takes-$(date +%Y%m%d-%H%M%S)\"/" "$OUT/index.html"
echo "open http://localhost:8098   (ctrl-c to stop)"
cd "$OUT" && exec python3 -m http.server 8098 --bind 127.0.0.1 >/dev/null 2>&1
