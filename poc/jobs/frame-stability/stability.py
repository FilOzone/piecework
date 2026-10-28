"""Did this thing move? Every frame, one region, an answer anyone can re-derive.

Job contract (same for every PieceWork job): read the client's files from /in (read-only), write results to
/out, no network. Inputs: one or more videos, and a track.json saying what to watch.

  <name>-stability.txt    every frame, where the region was found, and how well it matched
  <name>-stability.json   the same as data: per-frame coordinates and the verdict
  frame-stability-report.txt

What this answers that the other video jobs do not. frame-similarity measures how much the whole picture
changed between sampled frames, and video-index says what objects were on screen and when. Neither can
answer "did this icon move" -- they sample, and they look at everything. This reads EVERY frame and tracks
ONE region, and the useful result is usually a negative: it did not move, in any frame, and here are the
coordinates to prove it.

Why that is worth a job rather than a script. The claim "nothing moved" is exactly the kind a client should
not have to take on trust: the video is stored, the method is fixed, and the output is a coordinate per
frame -- so anyone holding the pieces can run it again and get the same table. A provider that fakes it is
caught by anyone who checks, which is the same property the lineage manifest has.

track.json, beside the video:
  {"region": [x, y, w, h]}      the rectangle in the FIRST frame whose contents are tracked
  {"template": "icon.png"}      or an image file in /in to look for instead
  {"search": 7}                 how far from the expected position to look, in pixels (default 8)
  {"tolerance": 0}              movement up to this many pixels is still "did not move" (default 0)
  {"min_score": 0.8}            below this the match is not trusted and the frame is reported unmatched

The search window is the point, not an optimisation: matching the whole frame finds the best lookalike
anywhere and would call a different element a match. Looking only near where it should be means a real
move shows up as "not found here" rather than as a confident wrong answer.
"""
import json
import os
import sys
import time

IN, OUT = "/in", "/out"
VIDEO = (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v")
DERIVED = ("-stability.txt", "-similarity.txt", "-index.txt")


def load_spec():
    for name in ("track.json", "stability.json"):
        p = os.path.join(IN, name)
        if os.path.exists(p):
            try:
                with open(p) as f:
                    return json.load(f)
            except Exception as e:
                print(f"{name} is not readable JSON: {e}", file=sys.stderr)
                return None
    return None


def main():
    import cv2

    spec = load_spec()
    os.makedirs(OUT, exist_ok=True)
    files = sorted(f for f in os.listdir(IN)
                   if f.lower().endswith(VIDEO) and not any(f.endswith(d) for d in DERIVED))
    if spec is None or not files:
        with open(os.path.join(OUT, "frame-stability-report.txt"), "w") as r:
            r.write("Nothing to check.\n\n")
            if not files:
                r.write("No video in /in (looked for " + ", ".join(VIDEO) + ").\n")
            if spec is None:
                r.write('No track.json in /in. It says what to watch, for example:\n'
                        '  {"region": [410, 270, 32, 32], "search": 7, "tolerance": 0}\n')
        # Nothing was measured, so this is a failure rather than a quiet empty result.
        return 3

    search = int(spec.get("search", 8))
    tolerance = int(spec.get("tolerance", 0))
    min_score = float(spec.get("min_score", 0.8))
    started = time.time()
    summaries, totals = [], {"videos": 0, "frames": 0, "moved": 0, "unmatched": 0}

    for name in files:
        path = os.path.join(IN, name)
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            print(f"could not open {name}", file=sys.stderr)
            continue
        ok, first = cap.read()
        if not ok:
            # The AV1 lesson: a video that opens but yields no frame is an error, not an empty answer.
            print(f"{name}: opened but no frame could be decoded (unsupported codec, AV1 is the usual "
                  f"cause). Not measured.", file=sys.stderr)
            cap.release()
            continue

        if spec.get("template"):
            tpath = os.path.join(IN, spec["template"])
            template = cv2.imread(tpath)
            if template is None:
                print(f"template {spec['template']} not readable", file=sys.stderr)
                cap.release()
                continue
            res = cv2.matchTemplate(first, template, cv2.TM_CCOEFF_NORMED)
            _, _, _, loc = cv2.minMaxLoc(res)
            x0, y0 = loc
            th, tw = template.shape[:2]
        else:
            x0, y0, tw, th = (int(v) for v in spec.get("region", [0, 0, 32, 32]))
            template = first[y0:y0 + th, x0:x0 + tw].copy()
            if template.size == 0:
                print(f"{name}: region {spec.get('region')} is outside the frame", file=sys.stderr)
                cap.release()
                continue

        H, W = first.shape[:2]
        rows, frame_no = [], 0
        expected = (x0, y0)
        while True:
            if frame_no:
                ok, frame = cap.read()
                if not ok:
                    break
            else:
                frame = first
            # Look only around where it should be. A whole-frame search finds the best lookalike anywhere,
            # which turns a real move into a confident wrong answer instead of a visible failure.
            sx0, sy0 = max(0, expected[0] - search), max(0, expected[1] - search)
            sx1, sy1 = min(W, expected[0] + tw + search), min(H, expected[1] + th + search)
            window = frame[sy0:sy1, sx0:sx1]
            if window.shape[0] < th or window.shape[1] < tw:
                rows.append((frame_no, None, None, 0.0))
                frame_no += 1
                continue
            res = cv2.matchTemplate(window, template, cv2.TM_CCOEFF_NORMED)
            _, score, _, loc = cv2.minMaxLoc(res)
            fx, fy = sx0 + loc[0], sy0 + loc[1]
            rows.append((frame_no, fx, fy, float(score)))
            frame_no += 1
        cap.release()

        matched = [r for r in rows if r[1] is not None and r[3] >= min_score]
        unmatched = [r for r in rows if r not in matched]
        moved = [r for r in matched if abs(r[1] - x0) > tolerance or abs(r[2] - y0) > tolerance]
        verdict = ("did not move" if not moved and not unmatched
                   else "MOVED" if moved else "not found in every frame")
        body = [name,
                f"{len(rows)} frames read",
                f"Tracking a {tw}x{th} region first seen at ({x0}, {y0}); "
                f"searched {search}px around it; match must score >= {min_score}; "
                f"tolerance {tolerance}px.",
                "",
                f"VERDICT: {verdict}",
                ""]
        if moved:
            body.append(f"  moved in {len(moved)} frame(s); first at frame {moved[0][0]} "
                        f"to ({moved[0][1]}, {moved[0][2]})")
        if unmatched:
            body.append(f"  not matched in {len(unmatched)} frame(s); first at frame {unmatched[0][0]}")
        body += ["", "  frame      x      y    score"]
        for n, fx, fy, sc in rows:
            body.append(f"  {n:5}  {('-' if fx is None else fx):>5}  {('-' if fy is None else fy):>5}   {sc:5.3f}")
        body.append("")
        with open(os.path.join(OUT, os.path.splitext(name)[0] + "-stability.txt"), "w") as f:
            f.write("\n".join(body))
        with open(os.path.join(OUT, os.path.splitext(name)[0] + "-stability.json"), "w") as f:
            json.dump({"video": name, "frames": len(rows), "region": [x0, y0, tw, th],
                       "search": search, "tolerance": tolerance, "minScore": min_score,
                       "verdict": verdict,
                       "positions": [{"frame": n, "x": fx, "y": fy, "score": round(sc, 4)}
                                     for n, fx, fy, sc in rows]}, f, indent=2)
        summaries.append((name, len(rows), verdict))
        totals["videos"] += 1
        totals["frames"] += len(rows)
        totals["moved"] += len(moved)
        totals["unmatched"] += len(unmatched)

    elapsed = time.time() - started
    with open(os.path.join(OUT, "frame-stability-report.txt"), "w") as r:
        r.write("Did it move\n\n")
        for name, n, verdict in summaries:
            r.write(f"  {name}: {n} frames — {verdict}\n")
        r.write(f"\nVideos: {totals['videos']}\nFrames read: {totals['frames']} (every frame, not sampled)\n")
        r.write(f"Frames where it had moved: {totals['moved']}\n")
        r.write(f"Frames where it was not found: {totals['unmatched']}\n\n")
        r.write(f"How the job ran: CPU, {elapsed:.1f} s")
        if totals["frames"]:
            r.write(f" ({totals['frames'] / elapsed:.0f} frames a second)")
        r.write(".\nNo network. No model: normalised cross-correlation in a small window.\n\n")
        r.write("The point of the coordinate table is that you do not have to believe it. The video is\n"
                "stored, the method is fixed and written above, and the same job over the same piece\n"
                "produces the same numbers — so anyone holding the pieces can check this result\n"
                "instead of trusting whoever ran it.\n")
    if totals["videos"] == 0:
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
