"""What is in the client's still images, as an index small enough to read and search.

Job contract (same for every PieceWork job): read the client's files from /in (read-only), write results to
/out, no network. For each image:
  <name>-index.txt        what was found, with a box and a confidence for each
  image-index.json        every image's findings together, for a program rather than a person
  image-index-report.txt  what ran, on what device, how fast, and how much smaller the answer is

Why this job exists. The archives worth indexing are images, not only video: robotics training data,
scientific and satellite imagery, and web crawls are all directories of stills. video-index answers "which
clips have a person in them" for video; this answers it for a folder of a million photographs, which is the
shape the data actually arrives in. The argument is the same and the ratio is the same: the archive is
terabytes, the answer is kilobytes, and only the answer needs to leave the provider that stores it.

DETECTION, NOT IDENTIFICATION -- and this is a deliberate limit, not an omission.

This job reports that a face is present, and where in the picture. It does not compute face embeddings, it
does not match a face against any other face, and it carries no database of people. It cannot tell you who
someone is, and it cannot tell you that two photographs show the same person, because nothing here is
retained between images.

That line is where the law changes. Under GDPR Article 9, biometric data processed "for the purpose of
uniquely identifying a natural person" is special-category data and needs its own lawful basis; detecting
that a face is present, without identification, does not meet that definition. Several US states (Illinois
BIPA among them) regulate face templates and embeddings specifically. Keeping identification out means a
client can index an archive without taking on any of that, and it costs them nothing, because "which images
contain people" is the question these archives actually ask.

If identification is ever wanted it belongs in a separate job with its own consent and retention story, not
as a flag on this one.
"""
import json
import os
import sys
import time

IN, OUT = "/in", "/out"
DEVICE = os.environ.get("DEVICE", "cpu")
SCORE = float(os.environ.get("SCORE", "0.5"))        # below this a detection is noise, not an object
FACES = os.environ.get("FACES", "1") != "0"          # face detection; set FACES=0 to skip it entirely
# How many overlapping detections a region needs before it counts as a face. At 5 the cascade called the
# Shell logo on a Ferrari's nose a face; 10 costs a little recall and removes most of that kind of thing.
FACE_NEIGHBOURS = int(os.environ.get("FACE_NEIGHBOURS", "10"))
IMAGE = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff")
DERIVED = ("-index.txt", "-restored.png", "-clean.png", "-mask.png", "-thumb.jpg")


def main():
    import cv2
    import torch
    import torchvision

    files = sorted(f for f in os.listdir(IN)
                   if f.lower().endswith(IMAGE) and not any(f.endswith(d) for d in DERIVED))
    os.makedirs(OUT, exist_ok=True)
    if not files:
        with open(os.path.join(OUT, "image-index-report.txt"), "w") as r:
            r.write("No images to index.\n\nThe job looked in /in for "
                    + ", ".join(IMAGE) + " and found none.\n")
        return 0

    torch.set_grad_enabled(False)
    if DEVICE == "cuda" and not torch.cuda.is_available():
        # Saying so beats a job that quietly runs on the processor and reports a GPU time: the whole reason
        # the GPU row exists is the comparison, and a mislabelled number poisons it.
        print("DEVICE=cuda but torch cannot see a GPU", file=sys.stderr)
        return 2
    dev = torch.device(DEVICE)
    weights = torchvision.models.detection.FasterRCNN_MobileNet_V3_Large_FPN_Weights.COCO_V1
    model = torchvision.models.detection.fasterrcnn_mobilenet_v3_large_fpn(weights=weights)
    model.eval().to(dev)
    labels = weights.meta["categories"]
    card = torch.cuda.get_device_name(0) if DEVICE == "cuda" else "CPU"

    # A Haar cascade ships inside opencv itself, so there is nothing to download at run time -- which this
    # job could not do anyway. It finds that a face is there and where it is, and that is all it can do:
    # it produces no descriptor of the face and nothing that could be compared against another image.
    face_cascade = None
    if FACES:
        xml = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
        face_cascade = cv2.CascadeClassifier(xml)
        if face_cascade.empty():
            print("face cascade missing; continuing without face detection", file=sys.stderr)
            face_cascade = None

    started = time.time()
    everything, totals = {}, {"images": 0, "objects": 0, "faces": 0, "in_bytes": 0, "out_bytes": 0}

    for name in files:
        path = os.path.join(IN, name)
        img = cv2.imread(path)
        if img is None:
            print(f"could not read {name}", file=sys.stderr)
            continue
        h, w = img.shape[:2]
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        tensor = torch.from_numpy(rgb).permute(2, 0, 1).float().div(255).to(dev)
        out = model([tensor])[0]

        found = []
        for label, score, box in zip(out["labels"].tolist(), out["scores"].tolist(),
                                     out["boxes"].tolist()):
            if score >= SCORE:
                found.append({"what": labels[label], "confidence": round(score, 3),
                              "box": [int(v) for v in box]})
        faces = []
        if face_cascade is not None:
            grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            for (fx, fy, fw, fh) in face_cascade.detectMultiScale(grey, 1.1, FACE_NEIGHBOURS,
                                                                  minSize=(40, 40)):
                faces.append({"box": [int(fx), int(fy), int(fx + fw), int(fy + fh)]})

        counts = {}
        for f in found:
            counts[f["what"]] = counts.get(f["what"], 0) + 1
        lines = [name, f"{w}x{h}", ""]
        lines.append("  " + (", ".join(f"{k}" if v == 1 else f"{k} x{v}"
                                       for k, v in sorted(counts.items())) or "nothing above the threshold"))
        if face_cascade is not None:
            lines.append(f"  faces present: {len(faces)}  (detected only, never identified; "
                         f"a coarse detector that does produce false positives)")
        lines += ["", "  what            confidence   box (x1,y1,x2,y2)"]
        for f in found:
            lines.append(f"  {f['what']:<14}  {f['confidence']:>9}   {tuple(f['box'])}")
        for f in faces:
            lines.append(f"  {'face':<14}  {'-':>9}   {tuple(f['box'])}")
        lines.append("")
        out_path = os.path.join(OUT, os.path.splitext(name)[0] + "-index.txt")
        with open(out_path, "w") as fh:
            fh.write("\n".join(lines))

        everything[name] = {"width": w, "height": h, "objects": found, "faces": faces}
        totals["images"] += 1
        totals["objects"] += len(found)
        totals["faces"] += len(faces)
        totals["in_bytes"] += os.path.getsize(path)
        totals["out_bytes"] += os.path.getsize(out_path)

    merged = os.path.join(OUT, "image-index.json")
    with open(merged, "w") as fh:
        json.dump({"detector": "Faster R-CNN MobileNetV3-Large FPN, COCO",
                   "scoreThreshold": SCORE,
                   "faces": "detected only; no embeddings, no identification, no matching",
                   "images": everything}, fh, indent=2)
    totals["out_bytes"] += os.path.getsize(merged)

    elapsed = time.time() - started
    with open(os.path.join(OUT, "image-index-report.txt"), "w") as r:
        r.write("What is in your images\n\n")
        r.write(f"Images: {totals['images']}\n")
        r.write(f"Objects found: {totals['objects']} (score >= {SCORE})\n")
        if face_cascade is not None:
            r.write(f"Faces present: {totals['faces']}\n")
        r.write(f"Detector: Faster R-CNN MobileNetV3-Large FPN, COCO\n\n")
        r.write(f"How the job ran: {card}, {elapsed:.1f} s")
        if totals["images"]:
            r.write(f" ({totals['images'] / elapsed:.2f} images a second)")
        r.write(".\nNo network.\n\n")
        if totals["out_bytes"]:
            ratio = totals["in_bytes"] / totals["out_bytes"]
            r.write(f"Read: {totals['in_bytes']:,} bytes of images\n")
            r.write(f"Produced: {totals['out_bytes']:,} bytes of index\n")
            r.write(f"The answer is {ratio:,.0f}x smaller than the question. The images never left the "
                    f"provider that stores them; only the index did.\n\n")
        r.write("Faces: a coarse cascade detector, which finds faces that are reasonably frontal and well\n"
                "lit and does produce false positives -- on a test image it called a sponsor's logo on a\n"
                "car a face. Treat a count as a hint to look, never as a fact.\n\n"
                "This job reports that a face is present and where it is. It computes no face\n"
                "embeddings, matches no face against any other, and holds no database of people, so it\n"
                "cannot tell you who anyone is or that two pictures show the same person. Under GDPR\n"
                "Article 9 biometric data is special-category only when processed to uniquely identify\n"
                "someone; detection without identification does not meet that test. Set FACES=0 to turn\n"
                "even the detection off.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
