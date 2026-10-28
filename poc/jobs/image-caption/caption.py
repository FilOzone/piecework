"""Say what is in the picture, in words, instead of picking from a list of eighty.

Job contract (same for every PieceWork job): read the client's files from /in (read-only), write results to
/out, no network. For each image:
  <name>-caption.txt      a sentence, and the tags pulled out of it
  image-caption.json      every image's caption together, for a program
  image-caption-report.txt

Why this exists, concretely. image-index uses a COCO detector, whose entire vocabulary is eighty
categories: person, car, truck, airplane, chair, cup and so on. On photographs of Formula 1 cars it
returned "truck x3, airplane, suitcase" -- not a bug, the vocabulary has no racing car in it and the model
reaches for the nearest thing it does know. A vision-language model has no fixed list: it describes what it
sees. That is the difference between an archive you can search for "person" and one you can search for
"a red single-seater on a wet track".

This one genuinely needs the card. The model is ~0.23B parameters and a forward pass per image is seconds
on a processor against well under one on a T4 -- for an archive of a million stills that is the difference
between a job and a non-job. It refuses to run on a processor rather than quietly taking a hundred times
longer and reporting a time nobody can compare with anything.
"""
import json
import os
import re
import sys
import time

IN, OUT = "/in", "/out"
DEVICE = os.environ.get("DEVICE", "cuda")
MODEL = os.environ.get("MODEL", "/models/florence")
MAX_TOKENS = int(os.environ.get("MAX_TOKENS", "128"))
ALLOW_CPU = os.environ.get("ALLOW_CPU", "0") == "1"   # for plumbing tests only; see the Dockerfile
IMAGE = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff")
DERIVED = ("-caption.txt", "-index.txt", "-restored.png", "-clean.png")


def main():
    import torch
    from PIL import Image

    files = sorted(f for f in os.listdir(IN)
                   if f.lower().endswith(IMAGE) and not any(f.endswith(d) for d in DERIVED))
    os.makedirs(OUT, exist_ok=True)
    if not files:
        with open(os.path.join(OUT, "image-caption-report.txt"), "w") as r:
            r.write("No images to caption.\n\nLooked in /in for " + ", ".join(IMAGE) + ".\n")
        return 0

    if DEVICE == "cuda" and not torch.cuda.is_available():
        # The whole point of this row is that it is the card's job. A run that quietly falls back to the
        # processor produces a number nobody can compare with the CPU row, which is worse than failing.
        print("DEVICE=cuda but torch cannot see a GPU. This job needs one: a 0.23B vision-language model "
              "on a processor is seconds per image, which is not a service. Set ALLOW_CPU=1 only to test "
              "the plumbing.", file=sys.stderr)
        if not ALLOW_CPU:
            return 2
    dev = torch.device("cuda" if (DEVICE == "cuda" and torch.cuda.is_available()) else "cpu")

    from transformers import AutoProcessor, AutoModelForCausalLM
    from unittest.mock import patch
    from transformers.dynamic_module_utils import get_imports
    patch("transformers.dynamic_module_utils.get_imports", lambda f: [i for i in get_imports(f) if i != "flash_attn"]).start()
    dtype = torch.float16 if dev.type == "cuda" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=dtype, trust_remote_code=True,
                                                 local_files_only=True).to(dev).eval()
    proc = AutoProcessor.from_pretrained(MODEL, trust_remote_code=True, local_files_only=True)
    card = torch.cuda.get_device_name(0) if dev.type == "cuda" else "CPU"

    started, everything = time.time(), {}
    for name in files:
        path = os.path.join(IN, name)
        img = Image.open(path).convert("RGB")
        task = "<MORE_DETAILED_CAPTION>"
        inputs = proc(text=task, images=img, return_tensors="pt").to(dev, dtype)
        with torch.no_grad():
            ids = model.generate(input_ids=inputs["input_ids"], pixel_values=inputs["pixel_values"],
                                 max_new_tokens=MAX_TOKENS, do_sample=False, num_beams=3)
        text = proc.batch_decode(ids, skip_special_tokens=True)[0].strip()
        parsed = proc.post_process_generation(text, task=task, image_size=img.size)
        caption = (parsed.get(task) or text).strip()
        # Words worth searching on, so an index can be built without re-reading every sentence.
        tags = sorted({w.lower() for w in re.findall(r"[A-Za-z][A-Za-z-]{3,}", caption)}
                      - {"with", "that", "this", "there", "they", "from", "into", "over", "which",
                         "image", "picture", "photo", "shows", "showing", "background", "foreground"})
        with open(os.path.join(OUT, os.path.splitext(name)[0] + "-caption.txt"), "w") as f:
            f.write(f"{name}\n{img.size[0]}x{img.size[1]}\n\n{caption}\n\ntags: {', '.join(tags)}\n")
        everything[name] = {"caption": caption, "tags": tags,
                            "width": img.size[0], "height": img.size[1]}

    merged = os.path.join(OUT, "image-caption.json")
    with open(merged, "w") as f:
        json.dump({"model": os.path.basename(MODEL), "device": card, "images": everything}, f, indent=2)

    elapsed = time.time() - started
    out_bytes = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    in_bytes = sum(os.path.getsize(os.path.join(IN, f)) for f in files)
    with open(os.path.join(OUT, "image-caption-report.txt"), "w") as r:
        r.write("What is in your images, in words\n\n")
        r.write(f"Images: {len(everything)}\n")
        r.write(f"Model: {os.path.basename(MODEL)}, a vision-language model with no fixed vocabulary\n\n")
        r.write(f"How the job ran: {card}, {elapsed:.1f} s")
        if everything:
            r.write(f" ({elapsed / len(everything):.2f} s an image)")
        r.write(".\nNo network.\n\n")
        if out_bytes:
            r.write(f"Read: {in_bytes:,} bytes of images\nProduced: {out_bytes:,} bytes of description\n")
            r.write(f"The answer is {in_bytes / out_bytes:,.0f}x smaller than the question.\n\n")
        r.write("Why not the detector: image-index picks from COCO's eighty categories and has no racing\n"
                "car, no helmet and no wheel in them, so a Formula 1 photograph comes back as a truck and\n"
                "an airplane. This describes instead of classifying, so there is nothing it cannot name --\n"
                "at the cost of needing a card to be worth ordering.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
