"""Takes things out of photographs: the background, or the people in them.

Job contract (the same for every PieceWork job): read /in (read-only), write /out, no network. The models are
baked into the image, because the container cannot reach the internet — which is also the point: the client's
photographs are processed on the provider's machine and never travel.

What it does is written in a file. Put a line in /in/what.txt:
    background        cut the subject out, transparent background
    people            remove the people and fill in behind them
Default is "people", which is the one that matters for a photo archive: faces and bodies taken out where the
photographs are stored, rather than uploaded somewhere to be anonymised.

Outputs, per input image:
    <name>-clean.png        the result
    <name>-mask.png         what was taken out, so the client can see what the model decided
    image-clean-report.txt  what ran, on what, how long, and on which device
"""
import os
import sys
import time

IN, OUT = "/in", "/out"
PHOTOS = (".jpg", ".jpeg", ".png", ".webp", ".bmp")
MODE_FILE = ("what.txt", "what.md")


def wanted():
    for f in MODE_FILE:
        p = os.path.join(IN, f)
        if os.path.exists(p):
            text = open(p, encoding="utf-8", errors="replace").read().strip().lower()
            if "background" in text:
                return "background"
            if "people" in text or "person" in text or "face" in text:
                return "people"
    return os.environ.get("MODE", "people")


def main():
    import numpy as np
    from PIL import Image
    import rembg

    mode = wanted()
    # u2net for a general subject cut-out, the human model when the point is to take people out.
    session = rembg.new_session("u2net" if mode == "background" else "u2net_human_seg")
    device = "GPU" if any("CUDA" in p for p in __import__("onnxruntime").get_available_providers()) else "CPU"

    photos = sorted(f for f in os.listdir(IN) if f.lower().endswith(PHOTOS))
    if not photos:
        raise SystemExit("no images in /in")

    t0, done, read, produced = time.time(), [], 0, 0
    for f in photos:
        src = Image.open(os.path.join(IN, f)).convert("RGBA")
        read += os.path.getsize(os.path.join(IN, f))
        cut = rembg.remove(src, session=session)                 # subject kept, background transparent
        alpha = np.array(cut)[:, :, 3]
        subject = alpha > 10

        stem = os.path.splitext(f)[0]
        Image.fromarray((subject * 255).astype("uint8")).save(os.path.join(OUT, f"{stem}-mask.png"))

        if mode == "background":
            out = cut
        else:
            # Take the subject out and fill the hole from its surroundings. OpenCV's inpainting is modest but
            # it is small, deterministic and needs no second model; a diffusion filler would look better and
            # would make the image several gigabytes larger.
            import cv2
            bgr = cv2.cvtColor(np.array(src.convert("RGB")), cv2.COLOR_RGB2BGR)
            hole = cv2.dilate((subject * 255).astype("uint8"), np.ones((9, 9), "uint8"), iterations=2)
            filled = cv2.inpaint(bgr, hole, 7, cv2.INPAINT_TELEA)
            out = Image.fromarray(cv2.cvtColor(filled, cv2.COLOR_BGR2RGB))

        at = os.path.join(OUT, f"{stem}-clean.png")
        out.save(at)
        produced += os.path.getsize(at)
        done.append((f, float(subject.mean())))

    took = time.time() - t0
    with open(os.path.join(OUT, "image-clean-report.txt"), "w") as rep:
        rep.write(f"Images: {'subject cut out, background removed' if mode == 'background' else 'people removed and filled in behind'}\n\n")
        for f, share in done:
            rep.write(f"{f}\n  {share * 100:.1f}% of the picture was taken out\n")
        rep.write(f"\nImages: {len(done)}\nRead: {read:,} bytes\nProduced: {produced:,} bytes\n")
        rep.write(f"\nHow the job ran: {device}, {took:.1f} s for {len(done)} image(s) "
                  f"({took / max(len(done), 1):.1f} s each). No network.\n")
        rep.write("\nThe photographs never left the provider that stores them: only the result did.\n")
    print(f"{len(done)} image(s) in {took:.1f}s on {device}", file=sys.stderr)


if __name__ == "__main__":
    main()
