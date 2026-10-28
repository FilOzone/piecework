"""Find the moment, by describing it, in an archive nobody has labelled.

Job contract (same for every PieceWork job): read the client's files from /in (read-only), write results to
/out, no network. For each video:
  <name>-vectors.npy      one embedding per sampled frame, so the archive stays searchable later
  <name>-search.txt       if queries.json is present: the best moments for each phrase, with timestamps
  video-search.json       the same, for a program
  video-search-report.txt

What this answers that video-index cannot. That job runs a COCO detector, whose vocabulary is eighty fixed
categories: it can find "person" and "car" and nothing else, ever. This embeds each frame into the same
space as text, so the question can be any phrase -- "a red single-seater on a wet track", "two people
shaking hands", "an empty grandstand" -- and the answer is the moments that match it. No retraining, no
fixed label set, and the query does not have to be known when the video is indexed.

Why the embeddings are kept. Describing the archive once is the expensive part; asking it questions is
cheap. The vectors are written beside the video so a later question is a dot product rather than another
pass over the footage -- which is the whole economic argument for doing this next to the stored data.

queries.json, beside the video, is optional:
  {"queries": ["a red racing car", "a person in the pit lane"], "top": 5}

This one needs the card. A forward pass per sampled frame is the shape of work a GPU does tens of times
faster, and an archive is the case where that difference decides whether the job is orderable at all. It
refuses to run on a processor rather than quietly reporting a time nobody can compare with anything.
"""
import json
import os
import sys
import time

IN, OUT = "/in", "/out"
DEVICE = os.environ.get("DEVICE", "cuda")
MODEL = os.environ.get("MODEL", "/models/clip")
SAMPLE_FPS = float(os.environ.get("SAMPLE_FPS", "1"))
BATCH = int(os.environ.get("BATCH", "32"))
ALLOW_CPU = os.environ.get("ALLOW_CPU", "0") == "1"
VIDEO = (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v")
DERIVED = ("-index.txt", "-similarity.txt", "-stability.txt", "-search.txt")


def clock(seconds):
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def main():
    import cv2
    import numpy as np
    import torch

    files = sorted(f for f in os.listdir(IN)
                   if f.lower().endswith(VIDEO) and not any(f.endswith(d) for d in DERIVED))
    os.makedirs(OUT, exist_ok=True)
    if not files:
        with open(os.path.join(OUT, "video-search-report.txt"), "w") as r:
            r.write("No video to index.\n\nLooked in /in for " + ", ".join(VIDEO) + ".\n")
        return 0

    if DEVICE == "cuda" and not torch.cuda.is_available():
        print("DEVICE=cuda but torch cannot see a GPU. Embedding every sampled frame of an archive on a "
              "processor is not a service. Set ALLOW_CPU=1 only to test the plumbing.", file=sys.stderr)
        if not ALLOW_CPU:
            return 2
    dev = torch.device("cuda" if (DEVICE == "cuda" and torch.cuda.is_available()) else "cpu")

    from transformers import CLIPModel, CLIPProcessor
    model = CLIPModel.from_pretrained(MODEL, local_files_only=True).to(dev).eval()
    proc = CLIPProcessor.from_pretrained(MODEL, local_files_only=True)
    card = torch.cuda.get_device_name(0) if dev.type == "cuda" else "CPU"

    spec = {}
    qpath = os.path.join(IN, "queries.json")
    if os.path.exists(qpath):
        try:
            with open(qpath) as f:
                spec = json.load(f)
        except Exception as e:
            print(f"queries.json is not readable JSON: {e}", file=sys.stderr)
    queries = [q for q in (spec.get("queries") or []) if isinstance(q, str) and q.strip()]
    top = int(spec.get("top", 5))

    qvecs = None
    if queries:
        with torch.no_grad():
            ti = proc(text=queries, return_tensors="pt", padding=True, truncation=True).to(dev)
            qv = model.get_text_features(**ti)
            qvecs = (qv / qv.norm(dim=-1, keepdim=True)).cpu().numpy()

    started, everything, totals = time.time(), {}, {"videos": 0, "frames": 0, "in_bytes": 0, "out_bytes": 0}

    for name in files:
        path = os.path.join(IN, name)
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            print(f"could not open {name}", file=sys.stderr)
            continue
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        step = max(1, int(round(fps / SAMPLE_FPS)))
        times, batch, vecs, frame_no = [], [], [], 0
        from PIL import Image

        def flush():
            if not batch:
                return
            with torch.no_grad():
                ii = proc(images=batch, return_tensors="pt").to(dev)
                v = model.get_image_features(**ii)
                v = v / v.norm(dim=-1, keepdim=True)
            vecs.append(v.cpu().numpy().astype("float16"))
            batch.clear()

        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if frame_no % step == 0:
                batch.append(Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)))
                times.append(frame_no / fps)
                if len(batch) >= BATCH:
                    flush()
            frame_no += 1
        flush()
        cap.release()

        if not times:
            # The AV1 lesson again: a video that decodes nothing is an error, not an empty index.
            print(f"{name}: opened but no frame could be decoded (unsupported codec). Not indexed.",
                  file=sys.stderr)
            continue

        V = np.concatenate(vecs, axis=0)
        npy = os.path.join(OUT, os.path.splitext(name)[0] + "-vectors.npy")
        np.save(npy, V)
        found = {}
        if qvecs is not None:
            scores = V.astype("float32") @ qvecs.T          # cosine: both sides are unit length
            for qi, q in enumerate(queries):
                order = np.argsort(-scores[:, qi])[:top]
                found[q] = [{"at": round(float(times[i]), 2), "clock": clock(times[i]),
                             "score": round(float(scores[i, qi]), 4)} for i in order]
            lines = [name, f"{len(times)} frames embedded at {SAMPLE_FPS} a second", ""]
            for q, hits in found.items():
                lines.append(f'"{q}"')
                for h in hits:
                    lines.append(f"    {h['clock']}   score {h['score']:.3f}")
                lines.append("")
            with open(os.path.join(OUT, os.path.splitext(name)[0] + "-search.txt"), "w") as f:
                f.write("\n".join(lines))
        everything[name] = {"frames": len(times), "dim": int(V.shape[1]),
                            "sampleFps": SAMPLE_FPS, "matches": found}
        totals["videos"] += 1
        totals["frames"] += len(times)
        totals["in_bytes"] += os.path.getsize(path)

    with open(os.path.join(OUT, "video-search.json"), "w") as f:
        json.dump({"model": os.path.basename(MODEL), "device": card,
                   "queries": queries, "videos": everything}, f, indent=2)
    totals["out_bytes"] = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))

    elapsed = time.time() - started
    with open(os.path.join(OUT, "video-search-report.txt"), "w") as r:
        r.write("Your video, searchable by description\n\n")
        r.write(f"Videos: {totals['videos']}\nFrames embedded: {totals['frames']} "
                f"(one every {1 / SAMPLE_FPS:.1f}s)\n")
        r.write(f"Model: {os.path.basename(MODEL)}\n")
        r.write(f"Queries asked: {len(queries)}\n\n")
        r.write(f"How the job ran: {card}, {elapsed:.1f} s")
        if totals["frames"]:
            r.write(f" ({totals['frames'] / elapsed:.1f} frames a second)")
        r.write(".\nNo network.\n\n")
        if totals["out_bytes"]:
            r.write(f"Read: {totals['in_bytes']:,} bytes of video\n")
            r.write(f"Produced: {totals['out_bytes']:,} bytes of index and vectors\n")
            r.write(f"The answer is {totals['in_bytes'] / totals['out_bytes']:,.0f}x smaller than the "
                    f"question.\n\n")
        r.write("The vectors are kept beside the video on purpose: describing the archive is the expensive\n"
                "pass, and every question after that is a dot product. Ask a new one by ordering this job\n"
                "again with a different queries.json, or against the vectors alone.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
