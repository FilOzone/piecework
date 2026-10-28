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
import shutil
import subprocess
import sys
import time

IN, OUT = "/in", "/out"
GENERATOR = os.environ.get("GENERATOR", "motion")
DEVICE = os.environ.get("DEVICE", "cpu")
IMAGES = (".jpg", ".jpeg", ".png", ".webp", ".bmp")
VIDEOS = (".mp4", ".mov", ".mkv", ".webm")
DEFAULTS = {"prompt": "", "seconds": 4.0, "fps": 12, "seed": 0}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


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
    """Version numbers come from what is already in the data set, so the client need not track them."""
    highest = 0
    for f in os.listdir(IN):
        if f.startswith("version-") and f.endswith(".mp4"):
            try:
                highest = max(highest, int(f[len("version-"):-len(".mp4")]))
            except ValueError:
                pass
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
    parents = [f for f in names if f.lower().endswith(VIDEOS) and f.startswith("version-")]
    parent = sorted(parents, key=lambda f: len(f))[-1] if parents else None

    if not images:
        with open(os.path.join(OUT, "video-gen-report.txt"), "w") as r:
            r.write("No images to build from.\n\nThe job looked in /in for "
                    + ", ".join(IMAGES) + " and found none. Add at least one picture and order again.\n")
        return 0

    s = read_settings()
    version = next_version()
    fps = max(1, int(s["fps"]))
    seconds = max(0.5, float(s["seconds"]))
    started = time.time()

    # The frames of the version this one is built on, so that "on top of" is visible in the result and not
    # only asserted in the manifest.
    carried = []
    if parent:
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
    for name in ([] if produced_frames is not None else images):
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
    if produced_frames is None:
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
        "produced": {"name": os.path.basename(out_path), "sha256": sha256(out_path),
                     "bytes": os.path.getsize(out_path), "width": w, "height": h, "fps": fps,
                     "frames": produced_frames if produced_frames is not None
                               else len(carried) + per_image * len(images),
                     # What the file actually is, not what was asked for. The two differ whenever the
                     # generator cannot take a duration, and a reader should not have to divide to find out.
                     "seconds": round((produced_frames if produced_frames is not None
                                       else len(carried) + per_image * len(images)) / fps, 3),
                     "carriedFromParent": len(carried)},
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
