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
import tempfile
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
            "secondsPerSegment": None,
            # Merge knobs. order names the clips and their sequence; target overrides the format
            # they are brought to; merged also stores the single assembled file, which costs the
            # whole thing again and is off by default because the segments already are the video.
            "order": None, "target": None, "merged": False}


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


def client_videos(names):
    """Videos the client brought, as opposed to this job's own earlier output."""
    return [f for f in names
            if f.lower().endswith(VIDEOS) and not re.match(r"version-\d+", f, re.I)]


def video_track(frag):
    """Which MUXL track number carries the video, read from the catalog rather than guessed."""
    try:
        out = subprocess.run([MUXL, "catalog", frag], check=True, capture_output=True,
                             timeout=120, text=True).stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return 1
    m = re.search(r'^video\s+"[^"]*":.*?\(track (\d+)', out, re.M)
    return int(m.group(1)) if m else 1


def frames_in(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
                              "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path],
                             check=True, capture_output=True, timeout=300, text=True).stdout
        return int(out.strip().split(",")[0])
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError, ValueError):
        return 0


def probe_video(path):
    """What format a clip actually is, read rather than assumed."""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json",
                              "-show_streams", "-show_format", path],
                             check=True, capture_output=True, timeout=300, text=True).stdout
        d = json.loads(out)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError,
            json.JSONDecodeError):
        return None
    v = next((x for x in d.get("streams", []) if x.get("codec_type") == "video"), None)
    a = next((x for x in d.get("streams", []) if x.get("codec_type") == "audio"), None)
    if not v:
        return None
    num, _, den = (v.get("r_frame_rate") or "0/1").partition("/")
    try:
        fps = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        fps = 0.0
    return {"codec": v.get("codec_name"), "width": int(v.get("width") or 0),
            "height": int(v.get("height") or 0), "fps": round(fps, 3),
            "pixFmt": v.get("pix_fmt"), "audio": bool(a),
            "audioCodec": (a or {}).get("codec_name"),
            "sampleRate": int((a or {}).get("sample_rate") or 0),
            "seconds": round(float((d.get("format") or {}).get("duration") or 0), 3)}


def shape_of(pr):
    """The part of a clip's format that has to agree before segments can share one video."""
    return (pr["codec"], pr["width"], pr["height"], pr["fps"], pr["pixFmt"],
            pr["audioCodec"], pr["sampleRate"])


DEFAULT_TARGET = {"codec": "h264", "pixFmt": "yuv420p",
                  "width": 1280, "height": 720, "fps": 30.0}


def merge_target(probes, asked=None, inherited=None):
    """One format every clip is brought to before its segments sit in the same video.

    This check is ours to make, because MUXL does not make it. Wrapping segments of a 512x512 12fps
    clip together with a 640x360 25fps one reports success and writes a file that does not decode:
    measured, h264 gives "top block unavailable for requested intra mode" and "Reference 2 >= 2".
    Silently emitting that is worse than re-encoding, so clips that disagree are re-encoded once to
    a common target -- once per source, not once per edit, which is the cost segments exist to avoid.

    The target must not be derived from the clips present. It was, briefly: the largest frame and
    highest rate in the set. That makes the format of every clip depend on every other clip, so
    swapping one for a bigger one re-encodes all of them and an edit reuses nothing. Measured: a
    three-clip take whose third clip was swapped reused 0 of 12 segments. It is the same mistake as
    deriving a segment's length from how many pictures there were, one layer up.

    So: a take's format is inherited from the version it builds on, and a first version takes a
    fixed default. Neither depends on which clips are in this particular take. The client can name
    a format instead, and then owns the consequence of changing it.
    """
    if isinstance(inherited, dict) and inherited.get("width"):
        t = dict(inherited)
    else:
        t = dict(DEFAULT_TARGET)
        t["audioCodec"] = "aac" if any(p["audio"] for p in probes) else None
        t["sampleRate"] = 48000 if any(p["audio"] for p in probes) else 0
    if isinstance(asked, dict):
        for k in ("width", "height", "fps"):
            if isinstance(asked.get(k), (int, float)) and asked[k] > 0:
                t[k] = asked[k] if k == "fps" else int(asked[k])
    # An odd dimension is not encodable by h264 at yuv420p.
    t["width"] -= t["width"] % 2
    t["height"] -= t["height"] % 2
    return t


def normalise(src, dst, target, has_audio):
    """Re-encode one clip to the shared target, keyframe every second so cuts are reachable."""
    gop = max(1, int(round(target["fps"])))
    silent = bool(target["audioCodec"]) and not has_audio
    # Every input, and its own options, before any output option. Appending "-f lavfi -i anullsrc"
    # after -vf made ffmpeg read the filter as an option on that input and refuse the whole command.
    args = ["ffmpeg", "-v", "error", "-y", "-i", src]
    if silent:
        # Some clips in the set have sound and this one does not: silence keeps the tracks aligned,
        # because a merged video cannot have audio appear and disappear between segments.
        args += ["-f", "lavfi", "-i", f"anullsrc=r={target['sampleRate']}:cl=stereo"]
    args += ["-map", "0:v:0"]
    if target["audioCodec"]:
        args += ["-map", "1:a:0" if silent else "0:a:0?"]
    args += ["-vf", f"scale={target['width']}:{target['height']}:force_original_aspect_ratio=decrease,"
                    f"pad={target['width']}:{target['height']}:-1:-1:color=black,"
                    f"fps={target['fps']}",
             "-c:v", "libx264", "-pix_fmt", target["pixFmt"],
             "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0"]
    if target["audioCodec"]:
        args += ["-c:a", target["audioCodec"], "-ar", str(target["sampleRate"]), "-b:a", "128k"]
        if silent:
            args += ["-shortest"]
    else:
        args += ["-an"]
    args.append(dst)
    try:
        subprocess.run(args, check=True, capture_output=True, timeout=1800)
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
        detail = getattr(e, "stderr", None) or b""
        if isinstance(detail, bytes):
            detail = detail.decode("utf-8", "replace")
        print(f"could not normalise {os.path.basename(src)}: {detail.strip()[:400]}", file=sys.stderr)
        return False


def split_video(src, work):
    """Cut a client's video into MUXL canonical segments at its own sync samples.

    This is the general case the picture path is not. One segment per source picture only works
    because the motion generator pans across stills, so the picture boundary is the only place
    anything changes; a video the client brought has no such structure. MUXL segments at video sync
    samples by spec, which is also the only place a segment can start, so the cut points come from
    the video rather than from a guess about it.

    Returns a list of standalone playable canonical files, in order, or None if the video could not
    be read. Audio is not carried: only the video track is segmented, which the report states.
    """
    if not MUXL:
        return None
    frag = os.path.join(work, "frag.mp4")
    # Stream-copy first, because re-encoding to segment would change the very bytes whose stability
    # is the point. Only a container ffmpeg cannot fragment as-is gets re-encoded.
    for extra in (["-c", "copy"], ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-an"]):
        try:
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, *extra,
                            "-movflags", "frag_keyframe+empty_moov+default_base_moof", frag],
                           check=True, capture_output=True, timeout=900)
            break
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
            continue
    else:
        return None

    segdir = os.path.join(work, "segs")
    os.makedirs(segdir, exist_ok=True)
    try:
        subprocess.run([MUXL, "segment", frag, "--dir", segdir],
                       check=True, capture_output=True, timeout=900)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
        detail = getattr(e, "stderr", None) or b""
        if isinstance(detail, bytes):
            detail = detail.decode("utf-8", "replace")
        print(f"muxl could not segment {os.path.basename(src)}: {detail.strip()}", file=sys.stderr)
        return None

    vt = video_track(frag)
    out = []
    for tdir in sorted(d for d in os.listdir(segdir) if d.startswith("track")):
        tnum = int(tdir[5:] or 0)
        full = os.path.join(segdir, tdir)
        if not os.path.isdir(full):
            continue
        for i, m4s in enumerate(sorted(f for f in os.listdir(full) if f.endswith(".m4s"))):
            # A bare .m4s is not playable on its own, and the page gives each segment its own
            # element, so each is wrapped into a standalone canonical file. Deterministic: wrapping
            # the same segment twice gives the same bytes.
            standalone = os.path.join(work, f"t{tnum}-seg-{i:04d}.mp4")
            try:
                subprocess.run([MUXL, "wrap", "--flat", standalone, os.path.join(full, m4s)],
                               check=True, capture_output=True, timeout=300)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
                return None
            out.append({"path": standalone, "track": tnum,
                        "kind": "video" if tnum == vt else "audio", "index": i,
                        "m4s": os.path.join(full, m4s)})
    return out or None


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

    # A video the client brought is an input in its own right, not just a possible parent. In segment
    # mode it is the better input: its cut points come from the video rather than from our generator
    # happening to pan across one still at a time.
    brought = client_videos(names) if SEGMENTS else []
    if brought:
        wanted = read_settings().get("order")
        if isinstance(wanted, list) and wanted:
            # The client's sequence, keeping only what is actually in the data set. Order has to be
            # stated: merging several clips in whatever order the filesystem returned is not a
            # result, it is a coin toss.
            lower = {f.lower(): f for f in brought}
            brought = [lower[str(w).lower()] for w in wanted if str(w).lower() in lower]
        else:
            brought = sorted(brought)
    source_video = brought[0] if brought else None

    if not images and not source_video:
        with open(os.path.join(OUT, "video-gen-report.txt"), "w") as r:
            r.write("Nothing to build from.\n\nThe job looked in /in for "
                    + ", ".join(IMAGES) + " and for a video, and found neither. Add at least one "
                    "picture, or a video to cut into segments, and order again.\n")
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

    first = cv2.imread(os.path.join(IN, images[0])) if images else None
    h, w = (first.shape[:2] if first is not None else (480, 640))
    if source_video:
        # The video's own size, not the no-pictures fallback, since nothing here is being generated.
        probe = cv2.VideoCapture(os.path.join(IN, source_video))
        vw = int(probe.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        vh = int(probe.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        probe.release()
        if vw and vh:
            h, w = vh, vw
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
    per_image = max(1, int(round(fps * seconds / len(images)))) if images else 0
    made_segments = []
    segments_ordered, per_seg, merge_note = [], None, None
    if SEGMENTS and produced_frames is None and source_video:
        # The general case: the client's own clips, cut at their own sync samples and stored once.
        # Nothing is generated. A clip whose format already matches the others is stream-copied, so
        # its bytes are untouched and reuse can recognise them; only a clip that disagrees is
        # re-encoded, once, because MUXL will wrap mismatched segments into a file that does not
        # decode and we would rather pay an encode than ship that.
        writer.release()
        os.remove(out_path)
        probes = {v: probe_video(os.path.join(IN, v)) for v in brought}
        unreadable = [v for v, pr in probes.items() if pr is None]
        clips = [v for v in brought if probes[v] is not None]
        if not clips:
            with open(os.path.join(OUT, "video-gen-report.txt"), "w") as r:
                r.write("None of the videos could be read.\n\nThe job found "
                        f"{len(brought)} video file(s) and ffprobe could not read any of them, so "
                        "there was nothing to cut. Nothing was stored and nothing is claimed.\n")
            return 0

        inherited = None
        for f in sorted((x for x in names if re.fullmatch(r"version-\d+\.json", x)),
                        key=lambda x: int(re.search(r"\d+", x).group()), reverse=True):
            try:
                with open(os.path.join(IN, f)) as fh:
                    cand = (json.load(fh).get("merge") or {}).get("target")
            except (OSError, json.JSONDecodeError):
                continue
            if cand:
                inherited = cand
                break
        target = merge_target([probes[v] for v in clips], s.get("target"), inherited)
        # Every clip is brought to the take's format, not only the ones that disagree with each
        # other, because "agrees with the others" is again a property of the set.
        mixed = any(shape_of(probes[v])[:5] != (target["codec"], target["width"], target["height"],
                                                target["fps"], target["pixFmt"]) for v in clips) \
            or any(bool(probes[v]["audio"]) != bool(target["audioCodec"]) for v in clips)
        segments_ordered, normalised, failed = [], [], []
        with tempfile.TemporaryDirectory() as work:
            for ci, clip in enumerate(clips):
                src = os.path.join(IN, clip)
                if mixed:
                    conv = os.path.join(work, f"norm-{ci:02d}.mp4")
                    if not normalise(src, conv, target, probes[clip]["audio"]):
                        failed.append(clip)
                        continue
                    normalised.append(clip)
                    src = conv
                cutwork = os.path.join(work, f"cut-{ci:02d}")
                os.makedirs(cutwork, exist_ok=True)
                cut = split_video(src, cutwork)
                if cut is None:
                    failed.append(clip)
                    continue
                for seg in cut:
                    digest = sha256(seg["path"])
                    cid = None
                    try:
                        out = subprocess.run([MUXL, "cid", seg["path"], "--segments"], check=True,
                                             capture_output=True, timeout=120, text=True).stdout
                        parts = next((ln for ln in out.splitlines() if ln.strip()), "").split()
                        cid = parts[0] if parts else None
                    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
                        pass
                    hit = known.get(digest)
                    common = {"sha256": digest, "canonical": True, "source": clip,
                              "track": seg["track"], "kind": seg["kind"]}
                    if hit:
                        # Two different things both look like a hash match, and lumping them
                        # together flatters the number. "reused" means the bytes were already a
                        # piece before this take ran, which is what an edit saves. "duplicate"
                        # means two segments of this same take are identical -- stored once, which
                        # is correct, but it is not a saving the client earned by editing. Silence
                        # generated for a clip with no sound is the usual source of those.
                        within = hit["from"] == f"version-{version}"
                        segments_ordered.append({**common, "name": hit["name"],
                                                 "muxlCid": hit.get("muxlCid") or cid,
                                                 "bytes": hit["bytes"],
                                                 "frames": hit["frames"] or frames_in(seg["path"]),
                                                 "from": hit["from"],
                                                 "reused": not within, "duplicate": within,
                                                 "m4s": seg["m4s"]})
                    else:
                        seg_name = f"version-{version}-seg-{len(segments_ordered):02d}.mp4"
                        shutil.copy2(seg["path"], os.path.join(OUT, seg_name))
                        entry = {**common, "name": seg_name, "muxlCid": cid,
                                 "bytes": os.path.getsize(os.path.join(OUT, seg_name)),
                                 "frames": frames_in(seg["path"]),
                                 "from": f"version-{version}", "reused": False,
                                 "duplicate": False, "m4s": seg["m4s"]}
                        segments_ordered.append(entry)
                        known[digest] = entry

            if failed or not segments_ordered:
                # Storing a take built from two of three clips, and saying so only in a footnote,
                # would hand the client a video that is quietly missing a third of what they asked
                # for. Refusing costs them a re-order; the other costs them their trust in the
                # number next to it.
                with open(os.path.join(OUT, "video-gen-report.txt"), "w") as r:
                    r.write("Did not build this take.\n\n")
                    if failed:
                        r.write("These clips could not be prepared:\n"
                                + "".join(f"  {f}\n" for f in failed)
                                + "\nA merge is the clips you named, in the order you named them. "
                                  "Leaving one out silently would be a different video from the one "
                                  "you ordered, so nothing was stored.\n")
                    else:
                        r.write("None of the videos could be cut into segments. Nothing was "
                                "stored.\n")
                    if unreadable:
                        r.write("\nAlso unreadable: " + ", ".join(unreadable) + "\n")
                return 0

            # One assembled file, only if asked for. The segments already are the video, in order,
            # and muxl wrap rebuilds this file from them deterministically, so storing it as well
            # costs the whole thing a second time.
            if s.get("merged"):
                m4s = [x["m4s"] for x in segments_ordered if os.path.exists(x["m4s"])]
                if len(m4s) == len(segments_ordered):
                    try:
                        subprocess.run([MUXL, "wrap", "--flat",
                                        os.path.join(OUT, f"version-{version}.mp4"), *m4s],
                                       check=True, capture_output=True, timeout=900)
                    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
                        detail = getattr(e, "stderr", None) or b""
                        if isinstance(detail, bytes):
                            detail = detail.decode("utf-8", "replace")
                        print(f"could not assemble the merged file: {detail.strip()[:300]}",
                              file=sys.stderr)

        for x in segments_ordered:
            x.pop("m4s", None)
        made_segments = [x for x in segments_ordered if not x["reused"]]
        produced_frames = sum(x["frames"] for x in segments_ordered if x["kind"] == "video")
        per_seg = None
        merge_note = {"clips": clips, "order": clips, "normalised": normalised,
                      "unreadable": unreadable, "failed": failed,
                      "mixedFormats": mixed, "target": target,
                      "assembledFile": bool(s.get("merged"))}

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
                within = hit["from"] == f"version-{version}"
                segments_ordered.append({"name": hit["name"], "sha256": digest,
                                         "muxlCid": hit.get("muxlCid") or muxl_cid,
                                         "canonical": hit.get("canonical", canon_path is not None),
                                         "bytes": hit["bytes"], "frames": hit["frames"] or per_seg,
                                         "from": hit["from"], "source": name,
                                         "reused": not within, "duplicate": within})
            else:
                seg_name = f"version-{version}-seg-{idx:02d}.mp4"
                os.rename(tmp_path, os.path.join(OUT, seg_name))
                entry = {"name": seg_name, "sha256": digest, "muxlCid": muxl_cid,
                         "canonical": canon_path is not None,
                         "bytes": os.path.getsize(os.path.join(OUT, seg_name)), "frames": per_seg,
                         "from": f"version-{version}", "source": name, "reused": False,
                         "duplicate": False}
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
        if merge_note:
            manifest["merge"] = merge_note
        reused = [x for x in segments if x["reused"]]
        dups = [x for x in segments if x.get("duplicate")]
        fresh = [x for x in segments if not x["reused"] and not x.get("duplicate")]
        reused_bytes = sum(x["bytes"] for x in reused)
        dup_bytes = sum(x["bytes"] for x in dups)
        new_bytes = sum(x["bytes"] for x in fresh)
        manifest["storage"] = {
            "segmentsInThisVersion": len(segments),
            "reusedFromEarlierVersions": len(reused),
            "duplicatesWithinThisVersion": len(dups),
            "writtenByThisVersion": len(fresh),
            "bytesWritten": new_bytes,
            "bytesReused": reused_bytes,
            "bytesDuplicatedWithin": dup_bytes,
            # What it would have cost to store this take with no reuse: every segment, every time.
            "bytesIfWholeFile": reused_bytes + dup_bytes + new_bytes,
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
    if source_video:
        # seconds is a knob for the generator. Cutting a video the client already has does not take
        # a duration, so comparing its length against the default would report a mismatch that
        # means nothing.
        pass
    elif abs(got - asked) > 0.05:
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
        if merge_note:
            cl = merge_note["clips"]
            r.write(f"Cut from {len(cl)} video(s), at their own keyframes, in this order:\n")
            for c in cl:
                r.write(f"  {c}\n")
            if merge_note["normalised"]:
                t = merge_note["target"]
                r.write(f"\nThe clips were not all the same format, so they were brought to "
                        f"{t['width']}x{t['height']} at {t['fps']} fps"
                        + (f" with {t['audioCodec']} audio" if t["audioCodec"] else "")
                        + ".\nRe-encoded for that: " + ", ".join(merge_note["normalised"])
                        + ".\nSegments of different sizes or rates cannot share one video: the "
                          "file assembles but does not decode, so the clips are matched once here "
                          "rather than per edit.\n")
            for bad, why in (("unreadable", "could not be read"), ("failed", "could not be cut")):
                if merge_note[bad]:
                    r.write(f"\nSkipped, {why}: " + ", ".join(merge_note[bad]) + "\n")
        elif source_video:
            r.write(f"Cut from {source_video}, at the video's own keyframes\n")
        else:
            r.write(f"Built from {len(images)} image(s)"
                    + (f", on top of {parent}" if parent else "") + "\n")
        if s["prompt"]:
            r.write(f"Prompt: {s['prompt']}\n")
        if merge_note and merge_note.get("target"):
            t = merge_note["target"]
            r.write(f"\n{t['width']}x{t['height']}, {t['fps']} fps, "
                    f"{manifest['produced']['frames']} frames")
        else:
            r.write(f"\n{w}x{h}, {fps} fps, {manifest['produced']['frames']} frames")
        if carried:
            r.write(f" (of which {len(carried)} carried from the previous version)")
        if SEGMENTS:
            st = manifest["storage"]
            each = (f" of {st['secondsPerSegment']}s each" if st.get("secondsPerSegment") else "")
            r.write(f"\n\nStored as {st['segmentsInThisVersion']} segments{each}, of which "
                    f"{st['writtenByThisVersion']} were written now")
            if st.get("reusedFromEarlierVersions"):
                r.write(f" and {st['reusedFromEarlierVersions']} turned out to be byte-for-byte "
                        "what an earlier version already stored, so they are only named")
            if st.get("duplicatesWithinThisVersion"):
                r.write(f". A further {st['duplicatesWithinThisVersion']} were identical to "
                        "another segment of this same take, so they are stored once. That is "
                        "deduplication, not a saving you earned by editing, and it is counted "
                        "separately below for that reason")
            r.write(".\n")
            if source_video:
                vids = len([x for x in segments if x.get("kind") == "video"])
                auds = len([x for x in segments if x.get("kind") == "audio"])
                r.write("The cut points are the videos' own: MUXL segments at sync samples, which "
                        "is the only place a segment can start, so replacing one scene costs that "
                        f"scene.\n{vids} video segment(s)"
                        + (f" and {auds} audio segment(s)" if auds else " and no audio")
                        + " are stored as pieces.\n")
                if merge_note and not merge_note["assembledFile"]:
                    r.write("The segments in order are the merged video. version-N.json lists them, "
                            "and `muxl wrap --flat out.mp4 <segments>` rebuilds one file from them, "
                            "so that file is not stored as well: it would cost the whole thing "
                            'twice. Ask for "merged": true in prompt.json if you want it stored.\n')
                elif merge_note:
                    r.write(f"version-{version}.mp4 is the assembled file, stored as you asked. It "
                            "is derivable from the segments, so it is extra bytes rather than "
                            "necessary ones.\n")
            r.write(f"This version wrote {st['bytesWritten']:,} bytes. Storing every segment again would "
                    f"have been {st['bytesIfWholeFile']:,}.\n")
            if st.get("canonicalForm") == "muxl":
                r.write("Segments are stored in MUXL canonical form (dasl.ing/muxl.html), so their "
                        "identifiers come from the frames rather than from the tool that packaged "
                        "them, and another implementation computes the same ones.\n")
            elif st.get("canonicalForm") != "none":
                r.write("Some segments could not be put in MUXL canonical form; version-N.json marks "
                        "which, and their identifiers are only stable against this encoder.\n")
            if st.get("bytesDuplicatedWithin"):
                pct = 100 * st["bytesDuplicatedWithin"] / st["bytesIfWholeFile"]
                r.write(f"Of that, {st['bytesDuplicatedWithin']:,} bytes ({pct:.0f}%) are repeats "
                        "inside this take, stored once.\n")
            if st["bytesIfWholeFile"]:
                saved = 100 * st["bytesReused"] / st["bytesIfWholeFile"]
                if saved:
                    r.write(f"So {saved:.0f}% of it cost nothing to store, because the same bytes were "
                            f"already here. Matched by sha256, segment by segment.\n")
                else:
                    r.write("So none of it was already stored: every segment is new bytes. Matched by "
                            "sha256, segment by segment, and nothing matched.\n")
        if not source_video and abs(manifest["produced"]["seconds"] - round(seconds, 3)) > 0.05:
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
