"""A video built from the client's images, and a record of what it was built from.

Job contract (same for every PieceWork job): read the client's files from /in (read-only), write results to
/out, no network. Inputs:
  <images>        the pictures to build from
  prompt.json     {"prompt": "...", "seconds": 4, "fps": 12, "seed": 0}  -- all optional
  <a video>       optional: the previous version, to build on top of

Outputs:
  version-<n>.mp4     the video
  version-<n>.json    what it was made from: every input by sha256, the prompt, the parent, the generator
  video-gen-report.txt

Why the manifest is the point of this job. Generating video is something a hundred services do. What none
of them can do is tell you, afterwards and provably, which images and which prompt produced version 7 and
that version 7 was built on version 6 -- because the inputs, the outputs and the money are all in one data
set on one chain. The manifest names every input by its sha256, so anyone holding the pieces can check the
claim without trusting the provider or us.

Why the first generator is not a model. The loop is the product, not the picture: a week spent on model
quality would leave nothing to show. GENERATOR=motion renders real video from the client's own images in
seconds on a processor, which means the whole cycle -- order, generate, store, build on it again -- can be
run end to end before any GPU is free. A real model goes in behind the same interface later; if that proves
awkward, the interface was wrong and it is cheaper to learn that now.

A deliberate property of the motion generator: version n contains version n-1's frames followed by the new
ones. That makes "built on top of" visible in the output rather than only in the manifest, and it produces
exactly the kind of data the storage-deduplication question needs measured -- successive videos that really
do share most of their content.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

IN, OUT = "/in", "/out"
GENERATOR = os.environ.get("GENERATOR", "motion")
# Segments: the version is written as one file per shot rather than one file for the whole thing, and a
# version built on another one does not re-emit the segments it did not change -- it names them. Those
# pieces are already in the data set, so the storage cost of the unchanged part is zero rather than small.
#
# This is the answer to the 0.0% measurement. Two takes sharing half their frames share none of their bytes
# once encoded, so the sharing cannot be found by chunking afterwards; it has to be built in at the only
# place it can be, which is the boundary between what changed and what did not.
SEGMENTS = os.environ.get("SEGMENTS", "0") == "1"
DEVICE = os.environ.get("DEVICE", "cpu")
IMAGES = (".jpg", ".jpeg", ".png", ".webp", ".bmp")
VIDEOS = (".mp4", ".mov", ".mkv", ".webm")
DEFAULTS = {"prompt": "", "seconds": 4.0, "fps": 12, "seed": 0,
            # Segment mode only. Fixed per segment rather than derived from the take length,
            # because a segment whose length depends on how many pictures there are can never
            # be reused when a picture is added. None means take SEGMENT_SECONDS, default 2.0.
            "secondsPerSegment": None}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


MUXL = shutil.which("muxl")


def canonicalise(path):
    """Rewrite one segment into MUXL canonical form and return (path, BDASL CID).

    The bytes ffmpeg writes are not a stable name for a video. Two files carrying identical frames
    differ in atom ordering, timestamp bases and chunk layout, between muxers and between versions
    of one muxer: measured here, three containers of the same frames gave three different sha256s
    and one canonical form. MUXL (dasl.ing/muxl.html) defines that form, so the identifier belongs
    to the content rather than to the tool that packaged it.

    Returns (None, None) when muxl is absent or refuses. The caller then stores the raw bytes and
    records canonical=false, because a paid job delivering a less portable identifier is better
    than a paid job delivering nothing.
    """
    if not MUXL:
        return None, None
    canon = path + ".canon.mp4"
    try:
        subprocess.run([MUXL, "segment", path, "--flat", canon],
                       check=True, capture_output=True, timeout=120)
        out = subprocess.run([MUXL, "cid", canon, "--segments"],
                             check=True, capture_output=True, timeout=120, text=True)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
        if os.path.exists(canon):
            os.remove(canon)
        detail = getattr(e, "stderr", None) or b""
        if isinstance(detail, bytes):
            detail = detail.decode("utf-8", "replace")
        print(f"muxl could not canonicalise {os.path.basename(path)}: {detail.strip()}",
              file=sys.stderr)
        return None, None
    # "bafkr4i...<tab>track1 seg0<tab>15268 bytes" -- one line per canonical segment. Ours is
    # single-track and single-segment by construction, so the first field of line one is the id.
    first = next((ln for ln in out.stdout.splitlines() if ln.strip()), "")
    parts = first.split()
    return canon, (parts[0] if parts else None)


def read_settings():
    """The prompt and the knobs, from prompt.json if the client supplied one."""
    settings = dict(DEFAULTS)
    for name in ("prompt.json", "prompt.txt"):
        path = os.path.join(IN, name)
        if not os.path.exists(path):
            continue
        raw = open(path, encoding="utf-8", errors="replace").read()
        if name.endswith(".json"):
            try:
                settings.update({k: v for k, v in json.loads(raw).items() if k in DEFAULTS})
            except json.JSONDecodeError:
                # A malformed prompt file is the client's typo, not a reason to fail a paid job: the prompt
                # is recorded verbatim either way, so the manifest still says what was asked for.
                settings["prompt"] = raw.strip()
        else:
            settings["prompt"] = raw.strip()
        break
    return settings


def next_version():
    """Version numbers come from what is already in the data set, so the client need not track them.

    Every shape a version can take has to count here, not just the whole-file one. When segments were
    added this looked only for version-N.mp4, which segment mode never writes -- so every take believed it
    was the first, numbered itself 1, and wrote segment names that collided with its own parent's. In a
    data set that is not a saving, it is two different videos claiming the same pieces.
    """
    highest = 0
    for f in os.listdir(IN):
        m = re.fullmatch(r"version-(\d+)(?:-seg-\d+)?\.(?:mp4|json)", f)
        if m:
            highest = max(highest, int(m.group(1)))
    return highest + 1


class Encoder:
    """H.264 in MP4, because that is the only thing a browser will actually play.

    OpenCV's bundled ffmpeg carries no H.264 encoder -- avc1 and H264 both fail to open, leaving mp4v,
    which is MPEG-4 Part 2. That produces a valid .mp4 that QuickTime opens and no browser can decode, so
    the take arrived in the page as a player that never started and a download that would not open. ffmpeg
    with libx264 is in the image for exactly this; if it is ever missing, fall back rather than fail, and
    the video is still correct even where it is less playable.
    """

    def __init__(self, path, w, h, fps):
        self.proc = None
        self.writer = None
        if shutil.which("ffmpeg"):
            self.proc = subprocess.Popen(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                 "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
                 # yuv420p and faststart are what make it play in a browser rather than merely exist;
                 # one thread keeps the bytes the same from one run to the next.
                 "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                 "-threads", "1", "-movflags", "+faststart", path],
                stdin=subprocess.PIPE)
        else:
            print("no ffmpeg in this image: falling back to mp4v, which browsers cannot play", file=sys.stderr)
            import cv2
            self.writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))

    def write(self, frame):
        if self.proc is not None:
            self.proc.stdin.write(frame.tobytes())
        else:
            self.writer.write(frame)

    def release(self):
        if self.proc is not None:
            self.proc.stdin.close()
            if self.proc.wait() != 0:
                raise RuntimeError("ffmpeg failed to encode the video")
        else:
            self.writer.release()


def main():
    import cv2
    import numpy as np

    os.makedirs(OUT, exist_ok=True)
    if not os.path.isdir(IN):
        print(f"no input directory at {IN}", file=sys.stderr)
        return 2

    names = sorted(os.listdir(IN))
    images = [f for f in names if f.lower().endswith(IMAGES)]
    # The parent is the whole provenance claim, so it is chosen by version number rather than by the
    # length of its filename, which was the old heuristic and tied between version-1 and version-2.
    # A whole-version video only: version-1-seg-00.mp4 is a piece OF version 1, not a version, and it
    # matched both the old filename-length heuristic and a naive version-number match, so a segmented
    # take ended up naming its own first segment as its parent and carrying 24 frames out of it.
    pat = re.compile(r"version-(\d+)\.(?:mp4|mov|mkv|webm)$", re.I)
    parents = [f for f in names if pat.match(f)]
    parent = max(parents, key=lambda f: int(pat.match(f).group(1))) if parents else None

    if not images:
        with open(os.path.join(OUT, "video-gen-report.txt"), "w") as r:
            r.write("No images to build from.\n\nThe job looked in /in for "
                    + ", ".join(IMAGES) + " and found none. Add at least one picture and order again.\n")
        return 0

    if SEGMENTS and GENERATOR == "svd":
        # The two shapes are incompatible: svd produces one fixed clip, segment mode produces one piece
        # per picture. Refusing is better than a manifest that describes neither.
        print("SEGMENTS=1 and GENERATOR=svd cannot be combined: svd makes one fixed clip, segment mode "
              "makes one piece per picture. Pick one.", file=sys.stderr)
        return 2

    s = read_settings()
    version = next_version()
    fps = max(1, int(s["fps"]))
    seconds = max(0.5, float(s["seconds"]))
    started = time.time()

    # The frames of the version this one is built on, so that "on top of" is visible in the result and not
    # only asserted in the manifest.
    carried = []
    if parent and not SEGMENTS:
        cap = cv2.VideoCapture(os.path.join(IN, parent))
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            carried.append(frame)
        cap.release()

    first = cv2.imread(os.path.join(IN, images[0]))
    h, w = (first.shape[:2] if first is not None else (480, 640))
    if carried:
        h, w = carried[0].shape[:2]
    h, w = h - h % 2, w - w % 2

    # One segment per source picture, which is where the picture actually changes -- the same boundary
    # frame-similarity finds by histogram distance, and the one an encoder puts a keyframe at anyway.
    #
    # Reuse is a measurement, not an assumption. The old code took the parent manifest's whole segment
    # list and called it reused, so the saving could never come out low: it reported the share of a
    # longer take that happened to be older, whatever the pictures were. Here every segment any earlier
    # version wrote is indexed by its sha256, and a segment counts as reused only when the bytes this
    # run produced are already in that index. Nothing matches means 0%, which is the point.
    known = {}
    if SEGMENTS:
        for f in sorted(x for x in names if re.fullmatch(r"version-\d+\.json", x)):
            try:
                with open(os.path.join(IN, f)) as fh:
                    doc = json.load(fh)
            except (OSError, json.JSONDecodeError):
                continue
            for seg in (doc.get("segments") or []):
                if seg.get("sha256") and seg.get("name"):
                    known.setdefault(seg["sha256"], {"name": seg["name"],
                                                     "bytes": seg.get("bytes", 0),
                                                     "frames": seg.get("frames", 0),
                                                     "from": seg.get("from", f[:-5]),
                                                     "source": seg.get("source"),
                                                     "muxlCid": seg.get("muxlCid"),
                                                     "canonical": seg.get("canonical", False)})

    out_path = os.path.join(OUT, f"version-{version}.mp4")
    writer = Encoder(out_path, w, h, fps)
    for frame in carried:
        writer.write(frame)

    if GENERATOR == "svd":
        # Stable Video Diffusion, image to video: the client's last picture becomes the seed frame and the
        # model invents the motion rather than panning across a still. Needs a card -- on a processor this
        # is hours per clip, which is not a slower service, it is no service -- so it refuses rather than
        # quietly falling back and reporting a time nobody can compare with the motion row.
        import torch
        if not torch.cuda.is_available():
            print("GENERATOR=svd needs a GPU. On a processor a diffusion video model is hours per clip. "
                  "Use GENERATOR=motion for the CPU row.", file=sys.stderr)
            return 2
        from diffusers import StableVideoDiffusionPipeline
        from PIL import Image
        pipe = StableVideoDiffusionPipeline.from_pretrained(
            os.environ.get("MODEL", "/models/svd"), torch_dtype=torch.float16,
            variant="fp16", local_files_only=True)
        pipe.to("cuda")
        pipe.enable_model_cpu_offload()
        seed_img = Image.open(os.path.join(IN, images[-1])).convert("RGB").resize((1024, 576))
        # Seeded from the prompt and the client's seed, so re-ordering the same job returns the same video.
        gen = torch.manual_seed(int(s["seed"]) ^ int.from_bytes(
            hashlib.sha256(str(s["prompt"]).encode()).digest()[:4], "big"))
        made = pipe(seed_img, decode_chunk_size=int(os.environ.get("CHUNK", "4")),
                    num_frames=int(os.environ.get("NUM_FRAMES", "25")),
                    motion_bucket_id=int(os.environ.get("MOTION", "127")),
                    generator=gen).frames[0]
        for f in made:
            writer.write(cv2.resize(cv2.cvtColor(np.array(f), cv2.COLOR_RGB2BGR), (w, h)))
        writer.release()
        produced_frames = len(carried) + len(made)
        fixed_frames = len(made)
    else:
        produced_frames = None
        fixed_frames = None
    # The new material: a slow move across each image in turn, seeded so the same inputs and the same
    # prompt give the same video. A client re-ordering the same job should not get a different answer.
    prompt_seed = int.from_bytes(hashlib.sha256(str(s["prompt"]).encode()).digest()[:2], "big")
    rng = np.random.default_rng(int(s["seed"]) ^ prompt_seed)
    per_image = max(1, int(round(fps * seconds / len(images))))
    made_segments = []
    segments_ordered, per_seg = [], None
    if SEGMENTS and produced_frames is None:
        writer.release()
        os.remove(out_path)
        # A segment is a pure function of the picture it was made from, the prompt and the client's seed.
        # It used to depend on two more things: its position in the list, because the crop came from one
        # sequential random stream, and how many pictures there were, because the per-picture frame count
        # was the take's duration divided by that number. Either of those changing rewrote every segment,
        # so adding one picture could never reuse anything. That is why the duration of a segment is fixed
        # here and the take's length is the number of pictures times it; `seconds` cannot also be honoured
        # and the manifest says so rather than silently producing a different length than was asked for.
        seg_seconds = max(0.5, float(s.get("secondsPerSegment") or
                                     os.environ.get("SEGMENT_SECONDS", 2.0)))
        per_seg = max(2, int(round(fps * seg_seconds)))
        for idx, name in enumerate(images):
            img = cv2.imread(os.path.join(IN, name))
            if img is None:
                continue
            pic_sha = sha256(os.path.join(IN, name))
            # Seeded from this picture and this prompt only, so the same picture yields the same bytes
            # wherever it sits in the take. This is what makes the reuse below possible at all.
            seed_src = hashlib.sha256(
                str(s["prompt"]).encode() + bytes.fromhex(pic_sha) + str(int(s["seed"])).encode()
            ).digest()
            rng_seg = np.random.default_rng(int.from_bytes(seed_src[:8], "big"))
            big = cv2.resize(img, (int(w * 1.25), int(h * 1.25)))
            dx = rng_seg.integers(0, max(1, big.shape[1] - w))
            dy = rng_seg.integers(0, max(1, big.shape[0] - h))

            tmp_path = os.path.join(OUT, f".seg-{idx:02d}.tmp.mp4")
            seg = Encoder(tmp_path, w, h, fps)
            for i in range(per_seg):
                t = i / (per_seg - 1)
                x = int(dx * (1 - t) + (big.shape[1] - w) * 0.5 * t)
                y = int(dy * (1 - t) + (big.shape[0] - h) * 0.5 * t)
                seg.write(big[y:y + h, x:x + w])
            seg.release()

            # What gets stored is the canonical form, not what ffmpeg happened to write, so the
            # piece in the data set is the one any MUXL implementation would produce from these
            # frames. The hash is taken over those canonical bytes, which is what makes the reuse
            # index survive an ffmpeg upgrade underneath us.
            canon_path, muxl_cid = canonicalise(tmp_path)
            if canon_path:
                os.remove(tmp_path)
                tmp_path = canon_path
            digest = sha256(tmp_path)

            hit = known.get(digest)
            if hit:
                # Already a piece in this data set. Throwing the bytes away is the saving: this version
                # names the existing piece by the same sha256, so a reader can check that what it plays
                # is exactly what the earlier version produced.
                os.remove(tmp_path)
                segments_ordered.append({"name": hit["name"], "sha256": digest,
                                         "muxlCid": hit.get("muxlCid") or muxl_cid,
                                         "canonical": hit.get("canonical", canon_path is not None),
                                         "bytes": hit["bytes"], "frames": hit["frames"] or per_seg,
                                         "from": hit["from"], "source": name, "reused": True})
            else:
                seg_name = f"version-{version}-seg-{idx:02d}.mp4"
                os.rename(tmp_path, os.path.join(OUT, seg_name))
                entry = {"name": seg_name, "sha256": digest, "muxlCid": muxl_cid,
                         "canonical": canon_path is not None,
                         "bytes": os.path.getsize(os.path.join(OUT, seg_name)), "frames": per_seg,
                         "from": f"version-{version}", "source": name, "reused": False}
                segments_ordered.append(entry)
                known[digest] = entry
        made_segments = [x for x in segments_ordered if not x["reused"]]
        produced_frames = sum(x["frames"] for x in segments_ordered)
        if not segments_ordered:
            with open(os.path.join(OUT, "video-gen-report.txt"), "w") as r:
                r.write("None of the pictures could be read.\n\nThe job found "
                        f"{len(images)} image file(s) in /in and none of them decoded, so there was "
                        "nothing to build a segment from.\n")
            return 0

    for name in ([] if (produced_frames is not None or SEGMENTS) else images):
        img = cv2.imread(os.path.join(IN, name))
        if img is None:
            continue
        img = cv2.resize(img, (int(w * 1.25), int(h * 1.25)))
        dx, dy = rng.integers(0, max(1, img.shape[1] - w)), rng.integers(0, max(1, img.shape[0] - h))
        for i in range(per_image):
            t = i / max(1, per_image - 1)
            x = int(dx * (1 - t) + (img.shape[1] - w) * 0.5 * t)
            y = int(dy * (1 - t) + (img.shape[0] - h) * 0.5 * t)
            writer.write(img[y:y + h, x:x + w])
    if produced_frames is None and not SEGMENTS:
        writer.release()

    # Everything this version was made from, by content rather than by name: a client holding the pieces can
    # check the claim without trusting the provider, and a renamed file does not break the record.
    manifest = {
        "version": version,
        "prompt": s["prompt"],
        "generator": {"name": GENERATOR, "device": DEVICE},
        "settings": {"seconds": seconds, "fps": fps, "seed": int(s["seed"])},
        "from": {
            "images": [{"name": n, "sha256": sha256(os.path.join(IN, n))} for n in images],
            "parent": ({"name": parent, "sha256": sha256(os.path.join(IN, parent))} if parent else None),
        },
        "produced": None if SEGMENTS else {
                     "name": os.path.basename(out_path), "sha256": sha256(out_path),
                     "bytes": os.path.getsize(out_path), "width": w, "height": h, "fps": fps,
                     "frames": produced_frames if produced_frames is not None
                               else len(carried) + per_image * len(images),
                     # What the file actually is, not what was asked for. The two differ whenever the
                     # generator cannot take a duration, and a reader should not have to divide to find out.
                     "seconds": round((produced_frames if produced_frames is not None
                                       else len(carried) + per_image * len(images)) / fps, 3),
                     "carriedFromParent": len(carried)},
    }
    if SEGMENTS and segments_ordered:
        segments = segments_ordered
        manifest["segments"] = segments
        reused = [x for x in segments if x["reused"]]
        fresh = [x for x in segments if not x["reused"]]
        reused_bytes = sum(x["bytes"] for x in reused)
        new_bytes = sum(x["bytes"] for x in fresh)
        manifest["storage"] = {
            "segmentsInThisVersion": len(segments),
            "reusedFromEarlierVersions": len(reused),
            "writtenByThisVersion": len(fresh),
            "bytesWritten": new_bytes,
            "bytesReused": reused_bytes,
            # What it would have cost to store this take with no reuse: every segment, every time.
            "bytesIfWholeFile": reused_bytes + new_bytes,
            "reuseTest": "sha256 of the MUXL-canonical segment against every segment earlier "
                         "versions wrote",
            "canonicalForm": ("muxl" if all(x.get("canonical") for x in segments) else
                              "mixed" if any(x.get("canonical") for x in segments) else "none"),
            "secondsPerSegment": round(per_seg / fps, 3) if per_seg else None,
            "note": ("a segment counts as reused only when the bytes this run produced are already a "
                     "piece in this data set, matched by sha256; those bytes are not written again and "
                     "this version names the existing piece, so a reader can check that what it plays is "
                     "exactly what the earlier version produced. No match means 0%, which is why this "
                     "number is a measurement rather than a property of how the take was assembled"),
        }
        # The whole-file output does not exist in segment mode, so the produced block describes the set.
        manifest["produced"] = {
            "name": f"version-{version}", "segments": [x["name"] for x in segments],
            "sha256OfSegments": [x["sha256"] for x in segments],
            "width": w, "height": h, "fps": fps,
            "frames": sum(x["frames"] for x in segments),
            "seconds": round(sum(x["frames"] for x in segments) / fps, 3),
            "bytes": reused_bytes + new_bytes,
            "carriedFromParent": sum(x["frames"] for x in segments if x["reused"]),
        }
    asked = round(seconds, 3)
    got = manifest["produced"]["seconds"]
    if abs(got - asked) > 0.05:
        manifest["produced"]["durationNote"] = (
            f"asked for {asked}s, produced {got}s: this generator makes a fixed {fixed_frames} frames "
            f"and does not take a duration, so seconds is not controllable here"
            if fixed_frames else
            f"asked for {asked}s, produced {got}s")
    with open(os.path.join(OUT, f"version-{version}.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    elapsed = time.time() - started
    with open(os.path.join(OUT, "video-gen-report.txt"), "w") as r:
        r.write(f"Version {version} of your video\n\n")
        r.write(f"Built from {len(images)} image(s)" + (f", on top of {parent}" if parent else "") + "\n")
        if s["prompt"]:
            r.write(f"Prompt: {s['prompt']}\n")
        r.write(f"\n{w}x{h}, {fps} fps, {manifest['produced']['frames']} frames")
        if carried:
            r.write(f" (of which {len(carried)} carried from the previous version)")
        if SEGMENTS:
            st = manifest["storage"]
            r.write(f"\n\nStored as {st['segmentsInThisVersion']} segments of "
                    f"{st['secondsPerSegment']}s each, of which {st['writtenByThisVersion']} were written "
                    f"now and {st['reusedFromEarlierVersions']} turned out to be byte-for-byte what an "
                    f"earlier version already stored, so they are only named.\n")
            r.write(f"This version wrote {st['bytesWritten']:,} bytes. Storing every segment again would "
                    f"have been {st['bytesIfWholeFile']:,}.\n")
            if st.get("canonicalForm") == "muxl":
                r.write("Segments are stored in MUXL canonical form (dasl.ing/muxl.html), so their "
                        "identifiers come from the frames rather than from the tool that packaged "
                        "them, and another implementation computes the same ones.\n")
            elif st.get("canonicalForm") != "none":
                r.write("Some segments could not be put in MUXL canonical form; version-N.json marks "
                        "which, and their identifiers are only stable against this encoder.\n")
            if st["bytesIfWholeFile"]:
                saved = 100 * st["bytesReused"] / st["bytesIfWholeFile"]
                if saved:
                    r.write(f"So {saved:.0f}% of it cost nothing to store, because the same bytes were "
                            f"already here. Matched by sha256, segment by segment.\n")
                else:
                    r.write("So none of it was already stored: every segment is new bytes. Matched by "
                            "sha256, segment by segment, and nothing matched.\n")
        if abs(manifest["produced"]["seconds"] - round(seconds, 3)) > 0.05:
            r.write(f"\n\nNote: you asked for {round(seconds, 3)} seconds and this is "
                    f"{manifest['produced']['seconds']}. ")
            if fixed_frames:
                r.write(f"The model generator produces a fixed {fixed_frames} frames and does not take a "
                        f"duration, so seconds has no effect on it. version-{version}.json records the "
                        f"length this file actually is.")
        r.write(f"\nProduced: {manifest['produced']['bytes']:,} bytes\n")
        r.write(f"\nHow the job ran: {GENERATOR} on {DEVICE}, {elapsed:.1f} s. No network.\n\n")
        r.write("version-%d.json records every input by its sha256, the prompt, and the version this was\n"
                "built on. Hash the pieces yourself to check it: nothing here asks you to take our word.\n"
                % version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
