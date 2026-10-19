"""What is in the client's video, as a timeline small enough to read and search.

Job contract (same for every PieceWork job): read the client's files from /in (read-only), write results to
/out, no network. For each video:
  <name>-index.txt        a timeline: what was on screen, when, and where the shot changed
  video-index-report.txt  what ran, on what device, how fast, and how much smaller the answer is

This is the job where moving the compute to the data pays most obviously. A video archive is terabytes and
the answer to "which clips have a person in them" is kilobytes. Every other job here argues that from
principle; this one can print the ratio, and does, at the end of the report.

Why one frame a second rather than all of them. A shot lasts seconds, so thirty frames of it hold almost the
same objects as one: indexing every frame costs thirty times as much and adds nearly nothing to what the
index can answer. The sampling rate is the single number that decides this job's cost, so it is visible as
SAMPLE_FPS rather than buried.

Why this is the job to run on a card. Detection is a convolutional forward pass per frame, which is the
shape of work a GPU does tens of times faster rather than the two or three times it manages on speech. On a
processor this is a few frames a second, so an hour of video takes hours; on a card it is minutes. Both
numbers land in the report, from the same code, so the comparison is honest.
"""
import os
import sys
import time

IN, OUT = "/in", "/out"
DEVICE = os.environ.get("DEVICE", "cpu")
SAMPLE_FPS = float(os.environ.get("SAMPLE_FPS", "1"))     # frames examined per second of video
SCORE = float(os.environ.get("SCORE", "0.5"))             # below this a detection is noise, not an object
SHOT_DELTA = float(os.environ.get("SHOT_DELTA", "0.45"))  # histogram distance that counts as a cut
VIDEO = (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v")
# Our own outputs and other jobs', so a second run does not index an index.
DERIVED = ("-index.txt", "-transcript.txt", "-subtitles.srt", "-480p.mp4", "-thumb.jpg", "-clean.png", "-mask.png")


def clock(seconds):
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def main():
    import cv2
    import torch
    import torchvision

    files = sorted(
        f for f in os.listdir(IN)
        if f.lower().endswith(VIDEO) and not any(f.endswith(d) for d in DERIVED)
    )
    if not files:
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, "video-index-report.txt"), "w") as r:
            r.write("No video files to index.\n\nThe job looked in /in for "
                    + ", ".join(VIDEO) + " and found none.\n")
        return 0

    torch.set_grad_enabled(False)
    if DEVICE == "cuda" and not torch.cuda.is_available():
        # Saying so beats a job that quietly runs on the processor and reports a GPU time: the whole reason
        # this row exists is the comparison, and a mislabelled number poisons it.
        print("DEVICE=cuda but torch cannot see a GPU", file=sys.stderr)
        return 2
    dev = torch.device(DEVICE)
    weights = torchvision.models.detection.FasterRCNN_MobileNet_V3_Large_FPN_Weights.COCO_V1
    model = torchvision.models.detection.fasterrcnn_mobilenet_v3_large_fpn(weights=weights)
    model.eval().to(dev)
    labels = weights.meta["categories"]
    card = torch.cuda.get_device_name(0) if DEVICE == "cuda" else "CPU"

    os.makedirs(OUT, exist_ok=True)
    started = time.time()
    totals = {"videos": 0, "seconds": 0.0, "frames": 0, "in_bytes": 0, "out_bytes": 0}

    for name in files:
        path = os.path.join(IN, name)
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            print(f"could not open {name}", file=sys.stderr)
            continue
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        step = max(1, int(round(fps / SAMPLE_FPS)))
        lines, previous_hist, frame_no, examined = [], None, 0, 0

        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if frame_no % step:
                frame_no += 1
                continue
            at = frame_no / fps

            # Shot boundary first, because it is nearly free and it is what makes the index navigable:
            # "a person appears at 00:04:12" is only useful if you can see where that shot begins.
            hist = cv2.calcHist([cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)], [0, 1], None, [50, 60],
                                [0, 180, 0, 256])
            cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)
            if previous_hist is not None:
                distance = cv2.compareHist(previous_hist, hist, cv2.HISTCMP_BHATTACHARYYA)
                if distance > SHOT_DELTA:
                    lines.append(f"[{clock(at)}] --- shot change")
            previous_hist = hist

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            tensor = torch.from_numpy(rgb).permute(2, 0, 1).float().div(255).to(dev)
            out = model([tensor])[0]
            seen = {}
            for label, score in zip(out["labels"].tolist(), out["scores"].tolist()):
                if score >= SCORE:
                    seen[labels[label]] = seen.get(labels[label], 0) + 1
            if seen:
                parts = [k if v == 1 else f"{k} x{v}" for k, v in sorted(seen.items())]
                lines.append(f"[{clock(at)}] " + ", ".join(parts))
            examined += 1
            frame_no += 1
        cap.release()

        duration = count / fps if count else frame_no / fps
        body = (f"{name}\n"
                f"{clock(duration)} long, {examined} frames examined at {SAMPLE_FPS} a second\n\n"
                + ("\n".join(lines) if lines else "Nothing above the score threshold, and no shot changes.")
                + "\n")
        out_path = os.path.join(OUT, os.path.splitext(name)[0] + "-index.txt")
        with open(out_path, "w") as f:
            f.write(body)
        totals["videos"] += 1
        totals["seconds"] += duration
        totals["frames"] += examined
        totals["in_bytes"] += os.path.getsize(path)
        totals["out_bytes"] += os.path.getsize(out_path)

    elapsed = time.time() - started
    with open(os.path.join(OUT, "video-index-report.txt"), "w") as r:
        r.write("What is in your video\n\n")
        r.write(f"Videos: {totals['videos']}\n")
        r.write(f"Video length: {clock(totals['seconds'])}\n")
        r.write(f"Frames examined: {totals['frames']} (one every {1 / SAMPLE_FPS:.1f}s)\n")
        r.write(f"Detector: Faster R-CNN MobileNetV3-Large FPN, COCO, score >= {SCORE}\n\n")
        r.write(f"How the job ran: {card}, {elapsed:.1f} s")
        if totals["frames"]:
            r.write(f" ({totals['frames'] / elapsed:.1f} frames a second)")
        if totals["seconds"]:
            r.write(f", {totals['seconds'] / elapsed:.1f}x real time")
        r.write(".\nNo network.\n\n")
        # The argument for running this next to the data, as a number rather than a claim.
        if totals["out_bytes"]:
            ratio = totals["in_bytes"] / totals["out_bytes"]
            r.write(f"Read: {totals['in_bytes']:,} bytes of video\n")
            r.write(f"Produced: {totals['out_bytes']:,} bytes of index\n")
            r.write(f"The answer is {ratio:,.0f}x smaller than the question. The video never left the "
                    f"provider that stores it; only the index did.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
