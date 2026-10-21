#!/usr/bin/env bash
# Build the Takes page for publishing, pointed at a provider the rest of the world can reach.
#
#   ./v2/takes/build-public.sh james        -> build/takes-public, ready to publish
#
# serve.sh adds a provider at localhost:8080, because that is the point of running it on your own machine.
# A published copy with that in it is a permanent page that works on one laptop and fails everywhere else,
# which is worse than no page: the client connects a wallet, uploads, and every action fails with nothing
# saying why. So this build refuses a local address outright, and refuses a provider that does not offer
# the job, rather than leaving either to be noticed after the upload is immutable.
set -euo pipefail
WANT="${1:-}"
[ -n "$WANT" ] || { echo "usage: $0 <provider-id>   (e.g. james)"; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB="$(cd "$HERE/../../poc/web" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/build/takes-public"
rm -rf "$OUT"; mkdir -p "$OUT"
cp "$HERE"/index.html "$HERE"/takes.mjs "$OUT"/
cp "$WEB"/app.mjs "$WEB"/abi.json "$WEB"/foc-logo-icon.svg "$OUT"/

python3 - "$OUT" "$WEB" "$WANT" <<'PY'
import json, sys, pathlib
out, web, want = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
cfg = json.loads((web / "config.json").read_text())
JOB = "video-gen:v1"

local = [p for p in cfg["providers"] if "localhost" in p["curioUrl"] or "127.0.0.1" in p["curioUrl"]]
if local:
    sys.exit(f"REFUSED: {web/'config.json'} names a local provider ({local[0]['id']}). "
             "A published page cannot reach it.")

chosen = next((p for p in cfg["providers"] if p["id"] == want), None)
if not chosen:
    sys.exit(f"REFUSED: no provider called {want!r}. Have: {[p['id'] for p in cfg['providers']]}")
offers = chosen.get("offers")
if offers is not None and JOB not in offers:
    sys.exit(f"REFUSED: {want} does not offer {JOB}, so every take ordered from this page would be "
             f"declined and the client would wait out the deadline for a refund. "
             f"It offers: {', '.join(offers)}")
if JOB not in cfg["jobs"]:
    sys.exit(f"REFUSED: {JOB} is not in the catalogue.")

# Only the provider that will actually serve this page, so pickProvider cannot choose anything else.
cfg["providers"] = [chosen]
(out / "config.json").write_text(json.dumps(cfg, indent=2) + "\n")
print(f"built for {chosen['id']} at {chosen['curioUrl']}")
print(f"  computeService {cfg['computeService']}")
print(f"  {JOB} at {cfg['jobs'][JOB]['price']} {cfg['token']} a take")
PY

sed -i '' "s/const V = \"[a-z0-9-]*\"/const V = \"takes-public-$(date +%Y%m%d-%H%M%S)\"/" "$OUT/index.html"
echo "ready to publish: $OUT"
ls -1 "$OUT"
