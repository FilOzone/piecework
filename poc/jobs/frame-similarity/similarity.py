"""How alike are two frames, as a number — and where a video should be cut because of it.

Job contract (same for every PieceWork job): read the client's files from /in (read-only), write results
to /out, no network. For each video:
  <name>-similarity.txt   every sampled frame, its distance from the one before, and the cuts
  <name>-cuts.json        the cut points alone, for a program rather than a person
  frame-similarity-report.txt

Why this job exists. Two versions of a video that share half their frames share none of their bytes: a
re-encode changes nearly every byte even where the picture is identical, so storage cannot discover the
sharing by looking (measured at 0.0% under fixed and content-defined chunking both, v2/measure-dedup.py).
The sharing has to be built in instead -- store a version as segments and let the next version point at the
segments it did not change. That only works if the cuts fall where the content changes, which is what this
job decides.

Why the cuts go at shot changes. A shot is the unit that stays the same between takes, so a segment that
is one shot is a segment the next version can reuse whole. Encoders also put a keyframe at a scene cut, and
MUXL requires a video segment to start at a sync sample, so content and container want the boundary in the
same place. Cutting at fixed intervals satisfies neither.

The measure is a Bhattacharyya distance between HSV histograms, which is what video-index already uses for
shot detection: 0 means identical colour distribution, 1 means nothing in common. It is cheap, it needs no
model, and it survives re-encoding -- which matters, because a measure that changed when the bytes changed
would be useless for exactly the case this job is for.

What it is not: this does not compare two different videos, and the score is not perceptual similarity in
the sense a model would give. It answers one question -- did the picture change enough here that the next
version will probably not reuse this part -- and that is the question the segment plan needs.
"""
import json
import os
import sys
import time

IN, OUT = "/in", "/out"
SAMPLE_FPS = float(os.environ.get("SAMPLE_FPS", "2"))      # frames compared per second of video
CUT = float(os.environ.get("CUT", "0.45"))                 # distance above which this is a new shot
MIN_SEGMENT = float(os.environ.get("MIN_SEGMENT", "1.0"))  # seconds; stops a flicker becoming ten segments
VIDEO = (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v")
DERIVED = ("-similarity.txt", "-index.txt", "-transcript.txt", "-480p.mp4")


def clock(seconds):
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}.{int((seconds % 1) * 100):02d}"


def main():
    import cv2

    files = sorted(f for f in os.listdir(IN)
                   if f.lower().endswith(VIDEO) and not any(f.endswith(d) for d in DERIVED))
    os.makedirs(OUT, exist_ok=True)
    if not files:
        with open(os.path.join(OUT, "frame-similarity-report.txt"), "w") as r:
            r.write("No video files to measure.\n\nThe job looked in /in for "
                    + ", ".join(VIDEO) + " and found none.\n")
        return 0

    started = time.time()
    unreadable = []
    totals = {"videos": 0, "seconds": 0.0, "frames": 0, "cuts": 0}

    for name in files:
        path = os.path.join(IN, name)
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            print(f"could not open {name}", file=sys.stderr)
            continue
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        step = max(1, int(round(fps / SAMPLE_FPS)))
        rows, cuts = [], [0.0]
        previous, frame_no, examined, last_cut = None, 0, 0, 0.0

        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if frame_no % step:
                frame_no += 1
                continue
            at = frame_no / fps
            hist = cv2.calcHist([cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)], [0, 1], None, [50, 60],
                                [0, 180, 0, 256])
            cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)
            if previous is not None:
                d = float(cv2.compareHist(previous, hist, cv2.HISTCMP_BHATTACHARYYA))
                # A cut needs both a real change and enough distance from the last one: a flicker or a
                # camera flash otherwise ends a segment every other frame, and a segment that short cannot
                # be reused by anything.
                is_cut = d > CUT and (at - last_cut) >= MIN_SEGMENT
                if is_cut:
                    cuts.append(round(at, 3))
                    last_cut = at
                rows.append((at, d, is_cut))
            previous = hist
            examined += 1
            frame_no += 1
        cap.release()

        if examined == 0 or not rows:
            unreadable.append(name)
            print(f"{name}: opened but no frames could be decoded -- the codec is not supported in this "
                  f"image (AV1 is the usual cause). No result written for it.", file=sys.stderr)
            continue

        duration = count / fps if count else frame_no / fps
        body = [f"{name}",
                f"{clock(duration)} long, {examined} frames compared at {SAMPLE_FPS} a second",
                f"A cut is a distance above {CUT}, at least {MIN_SEGMENT}s after the last one.",
                "",
                "    time      distance   ",
                ""]
        for at, d, is_cut in rows:
            body.append(f"  {clock(at)}   {d:6.3f}   {'CUT' if is_cut else ''}")
        body += ["", f"{len(cuts)} segment(s): " + ", ".join(clock(c) for c in cuts), ""]
        with open(os.path.join(OUT, os.path.splitext(name)[0] + "-similarity.txt"), "w") as f:
            f.write("\n".join(body))
        # The same answer for a program: this is what a segmenting encoder would be handed.
        with open(os.path.join(OUT, os.path.splitext(name)[0] + "-cuts.json"), "w") as f:
            json.dump({"video": name, "duration": round(duration, 3), "sampleFps": SAMPLE_FPS,
                       "cutThreshold": CUT, "minSegmentSeconds": MIN_SEGMENT,
                       "cutsAtSeconds": cuts}, f, indent=2)
        totals["videos"] += 1
        totals["seconds"] += duration
        totals["frames"] += examined
        totals["cuts"] += len(cuts)

    elapsed = time.time() - started
    with open(os.path.join(OUT, "frame-similarity-report.txt"), "w") as r:
        r.write("Where your video changes\n\n")
        r.write(f"Videos: {totals['videos']}\n")
        r.write(f"Video length: {clock(totals['seconds'])}\n")
        r.write(f"Frames compared: {totals['frames']} (one every {1 / SAMPLE_FPS:.2f}s)\n")
        r.write(f"Segments proposed: {totals['cuts']}\n")
        r.write(f"Measure: Bhattacharyya distance between HSV histograms, cut above {CUT}\n")
        if unreadable:
            r.write(f"\nNot readable, and so not measured: {', '.join(unreadable)}\n"
                    f"These opened but no frame could be decoded. The usual cause is AV1, which this image\n"
                    f"has no decoder for. Re-encode to H.264 and order again.\n")
        r.write("\n")
        r.write(f"How the job ran: CPU, {elapsed:.1f} s")
        if totals["seconds"]:
            r.write(f" ({totals['seconds'] / elapsed:.1f}x real time)")
        r.write(".\nNo network. No model: this is histogram arithmetic, which is why it costs what it does.\n\n")
        r.write("What this is for: cut a version into segments here, and the next version built on it can\n"
                "point at the segments it did not change instead of storing them again. The saving is only\n"
                "real if the cuts fall where the content changes, which is what these numbers decide.\n")
    if unreadable and totals["videos"] == 0:
        print("no video could be decoded; nothing was measured", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
