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
cp "$HERE"/index.html "$HERE"/takes.mjs "$HERE"/view.html "$OUT"/
cp -R "$HERE"/preview-media "$OUT"/preview-media
[ -d "$HOME/piecework-runtime/cartoon/media" ] && cp -R "$HOME/piecework-runtime/cartoon/media" "$OUT"/cartoon-media
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
    # Everything this stand-in actually runs. It said video-gen alone, which was true when there was one
    # job; with the page gating buttons on this list, a stale entry hides jobs the provider can run.
    # The GPU rows are deliberately absent: there is no card on a laptop, and offering one would cost a
    # client a deadline to discover that.
    "offers": ["video-gen:v1", "video-gen-segments:v1", "frame-similarity:v1", "image-index:v1",
               "frame-stability:v1"],
    # This stand-in serves /play/<cid>: a browser-playable rendering of a take, beside the exact bytes at
    # /piece/<cid>. Real Curio does not, so only this entry claims it.
    "playRoute": True,
}]
(out / "config.json").write_text(json.dumps(cfg, indent=2) + "\n")
job = cfg["jobs"].get("video-gen:v1")
print(f"takes ready: {job['name']!r} at {job['price']} {cfg['token']} a take" if job
      else "WARNING: video-gen:v1 is not in the catalogue")
PY

# The real piece lists, straight from the provider's own state, so the preview can be pointed at a
# data set that exists instead of made-up names. Nothing here touches the chain or a wallet: these are
# the pieces this provider holds, and the bytes behind them are served from it on /piece and /play.
python3 - "$OUT" <<'PY2'
import json, pathlib, sys
out = pathlib.Path(sys.argv[1])
state = pathlib.Path.home() / ".foc-compute-poc/calibnet/state.json"
if not state.exists():
    print("no provider state yet: the preview keeps its made-up pieces"); raise SystemExit
d = json.loads(state.read_text())
sets = {}
for ds, s in d.get("extraSets", {}).items():
    pcs = s.get("pieces", {})
    if not pcs: continue
    sets[str(ds)] = {
        "payer": s.get("payer"),
        "pieces": [{"pieceId": str(pid),
                    "name": (p.get("name") if isinstance(p, dict) else None) or f"piece-{pid}",
                    "cid": (p.get("cid") if isinstance(p, dict) else p) or ""}
                   for pid, p in pcs.items()],
    }
# A take built on this machine, if one has been prepared: its pieces are real segments with real
# MUXL identifiers, and the media beside them is each piece wrapped into a file a browser will play,
# because a piece is a single-sample fragment and not a playable file. Not on chain, and it says so.
cartoon = pathlib.Path.home() / "piecework-runtime/cartoon/pieces.json"
if cartoon.exists():
    sets.update(json.loads(cartoon.read_text()))

(out / "real-pieces.json").write_text(json.dumps(sets, indent=1) + "\n")
big = max(sets, key=lambda k: len(sets[k]["pieces"])) if sets else None
print(f"real pieces: {len(sets)} data sets"
      + (f", biggest #{big} with {len(sets[big]['pieces'])}" if big else ""))
PY2

sed -i '' "s/const V = \"[a-z0-9-]*\"/const V = \"takes-$(date +%Y%m%d-%H%M%S)\"/" "$OUT/index.html"
echo "open http://localhost:8098   (ctrl-c to stop)"
# Served with no-store. http.server's default caching let a browser keep an older index.html or
# view.html after an edit, which looks exactly like the page being broken: the heading renders and
# nothing else does, with no error anywhere.
cd "$OUT" && exec python3 - <<'SRV' >/dev/null 2>&1
import http.server
# ThreadingHTTPServer, not TCPServer: the view sizes every piece with a HEAD request and fires them
# together. A single-threaded server queues them, the draw never finishes, and the page sits empty
# with no error -- indistinguishable from the view itself being broken.
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()
http.server.ThreadingHTTPServer.allow_reuse_address = True
http.server.ThreadingHTTPServer(("127.0.0.1", 8098), H).serve_forever()
SRV
