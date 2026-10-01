"""Embeddings over the client's documents, so they can be searched by meaning.

Job contract (same for every PieceWork job): read the client's files from /in (read-only), write results to /out,
no network. Outputs:
  /out/embeddings.jsonl  one line per chunk: file, chunk number, text preview, and the vector
  /out/embeddings-report.txt  what was embedded, how fast, and how much smaller the result is than the input

Model: BAAI/bge-small-en-v1.5 through fastembed (ONNX runtime on CPU), baked into the image so the job needs no
network. A GPU would be faster; nothing here depends on one.
"""
import json
import os
import re
import sys
import time

IN, OUT = "/in", "/out"
MODEL = os.environ.get("MODEL", "BAAI/bge-small-en-v1.5")
PROVIDER = os.environ.get("PROVIDER", "CPUExecutionProvider")
CHUNK = int(os.environ.get("CHUNK_CHARS", "400"))  # characters per chunk, split on blank lines where possible
PREVIEW = int(os.environ.get("PREVIEW_CHARS", "300"))  # how much of the chunk is kept alongside the vector
SEPARATOR = re.compile(r"\n={20,}\n")


def chunks(text):
    out, current = [], ""
    for para in re.split(r"\n\s*\n", text):
        if len(current) + len(para) + 2 <= CHUNK:
            current = f"{current}\n\n{para}" if current else para
        else:
            if current:
                out.append(current)
            while len(para) > CHUNK:  # a very long paragraph
                out.append(para[:CHUNK])
                para = para[CHUNK:]
            current = para
    if current.strip():
        out.append(current)
    return [c.strip() for c in out if c.strip()]


def main():
    from fastembed import TextEmbedding
    files = sorted(f for f in os.listdir(IN) if f.endswith((".txt", ".md", ".csv")))
    items = []  # (file, chunk number, text)
    for f in files:
        with open(os.path.join(IN, f), encoding="utf-8", errors="replace") as fh:
            for doc in SEPARATOR.split(fh.read()):
                for i, c in enumerate(chunks(doc)):
                    items.append((f, i, c))
    nbytes = sum(len(c.encode()) for _, _, c in items)

    t0 = time.time()
    # The same model and the same chunks either way: only the execution provider differs, so a CPU run and a
    # GPU run are comparable and the report says which one produced it.
    model = TextEmbedding(model_name=MODEL, providers=[PROVIDER])
    t1 = time.time()
    # What a passage is about includes which document it is in: a file called payment-instruction-0442.txt is
    # about payment instructions even where the sentences do not say so. The name is embedded with the text,
    # and kept out of the preview, which stays the client's own words.
    vectors = list(model.embed([f"{re.sub(r'[._-]+', ' ', os.path.splitext(f)[0])}. {c}" for f, _, c in items]))
    t2 = time.time()

    out_path = os.path.join(OUT, "embeddings.jsonl")
    with open(out_path, "w") as out:
        for (f, i, c), v in zip(items, vectors):
            out.write(json.dumps({"file": f, "chunk": i, "preview": c[:PREVIEW].replace("\n", " "),
                                  "text": c,
                                  "vector": [round(float(x), 5) for x in v]}) + "\n")
    produced = os.path.getsize(out_path)

    scan = max(t2 - t1, 1e-6)
    with open(os.path.join(OUT, "embeddings-report.txt"), "w") as rep:
        rep.write("Embeddings: your documents turned into vectors, so they can be searched by meaning\n\n")
        rep.write(f"Files: {len(files)}\nChunks embedded: {len(items)}\nModel: {MODEL} ({len(vectors[0]) if vectors else 0} numbers per chunk)\n")
        rep.write(f"Read: {nbytes:,} bytes\nProduced: {produced:,} bytes (embeddings.jsonl)\n")
        where = "GPU" if "CUDA" in PROVIDER or "Tensorrt" in PROVIDER else "CPU only"
        rep.write(f"\nHow the job ran: {where}, model loading {t1 - t0:.1f} s, embedding {scan:.1f} s, "
                  f"{nbytes / scan / 1e6:.2f} MB/s ({len(items) / scan:.1f} chunks/s). No network.\n")
        rep.write("\nThe vectors stay with your data at the provider: only the result file moves if you want it elsewhere.\n")
    print(f"{len(items)} chunks, {nbytes / 1e6:.2f} MB in, {produced / 1e6:.2f} MB out, load {t1 - t0:.1f}s, "
          f"embed {scan:.1f}s, {nbytes / scan / 1e6:.3f} MB/s", file=sys.stderr)


if __name__ == "__main__":
    main()
