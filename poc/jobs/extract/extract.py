"""PieceWork job: pull the facts out of the client's documents, where the documents are stored.

Contract: inputs in /in (read-only), results in /out, no network.
  /out/<name>-fields.json   the fields found in that document
  /out/extract-report.txt   what was read, what was found, and on what hardware

Why a small model rather than a large one. The documents that most need this — contracts, settlement notes,
onboarding forms — are the ones that legally cannot be sent to someone else's API, which is the whole
argument for computing next to the data. A 1.5B model quantised to four bits fits in about a gigabyte, runs
on any sealing card with room to spare, and is good enough for "find the date, the amount and the parties".
Asking it to reason would be a different claim and this job does not make it.

The model is baked into the image at build time. A job runs with no network; a program that downloads weights
on first use fails with a connection error that says nothing about the real cause.
"""
import json, os, pathlib, re, sys, time
from llama_cpp import Llama

IN, OUT = pathlib.Path("/in"), pathlib.Path("/out")
MODEL = os.environ.get("MODEL", "/model/model.gguf")
# 0 on the processor, -1 to put every layer on the card. One image, two devices, decided here rather than by
# keeping a second copy of this file in step with the first.
GPU_LAYERS = int(os.environ.get("GPU_LAYERS", "0"))
WHERE = os.environ.get("WHERE", "CPU")
# What to pull out. Deliberately a fixed list: a field the client can name is a field the client can check,
# and "extract anything interesting" is not something a 1.5B model does reliably enough to sell.
FIELDS = os.environ.get("FIELDS", "counterparty,date,amount,currency,payment_terms,payment_method").split(",")

PROMPT = """Read the document and return ONLY a JSON object with exactly these keys: {keys}.
Use null for anything the document does not state. Do not explain. Do not add keys.

DOCUMENT:
{body}

JSON:"""


def clean(fields: dict, keys) -> dict:
    """A 1.5B model fails in two tidy, detectable ways, and both look like answers if left alone.

    It writes the string "null" where it means nothing, which survives JSON parsing and reads downstream as
    a value. And when it cannot find a field it sometimes echoes the field's own name back — "counterparty":
    "counterparty" — which is the worst kind of wrong, because it is confidently shaped like data.
    """
    out = {}
    for k in keys:
        v = fields.get(k)
        if isinstance(v, str):
            t = v.strip()
            if t.lower() in {"", "null", "none", "n/a", "na", "unknown", "not stated", "not specified"}:
                v = None
            elif t.lower() == k.lower() or t.lower() == k.replace("_", " ").lower():
                v = None  # echoed the field name
            else:
                v = t
        out[k] = v
    return out

def first_json(s: str):
    """The model is small and sometimes says a word before the JSON. Take the first balanced object."""
    start = s.find("{")
    if start < 0:
        return None
    depth = 0
    for i, ch in enumerate(s[start:], start):
        depth += (ch == "{") - (ch == "}")
        if depth == 0:
            try:
                return json.loads(s[start:i + 1])
            except json.JSONDecodeError:
                return None
    return None


def main() -> int:
    docs = sorted(p for p in IN.iterdir()
                  if p.is_file() and p.suffix.lower() in {".txt", ".md", ".json"})
    if not docs:
        print("no .txt documents in /in", file=sys.stderr)
        return 1

    llm = Llama(model_path=MODEL, n_ctx=4096, n_gpu_layers=GPU_LAYERS, verbose=False, seed=0)
    report, found_total, start = [], 0, time.time()
    report.append("Extract: the facts in your documents, read where they are stored\n")

    for p in docs:
        body = p.read_text(errors="replace")[:6000]
        t0 = time.time()
        raw = llm(PROMPT.format(keys=", ".join(FIELDS), body=body),
                  max_tokens=256, temperature=0.0, stop=["\n\n\n"])["choices"][0]["text"]
        fields = first_json(raw)
        took = time.time() - t0
        fields = clean(fields, FIELDS) if fields else None
        if fields is None:
            # Say so rather than write an empty object: a document the model could not answer for is a
            # different thing from a document with nothing in it, and the client should be able to tell.
            fields = {k: None for k in FIELDS}
            note = "  the model did not return usable JSON for this document\n"
        else:
            fields = {k: fields.get(k) for k in FIELDS}
            note = ""
        (OUT / f"{p.stem}-fields.json").write_text(json.dumps(fields, indent=2) + "\n")
        got = sum(v not in (None, "", "null") for v in fields.values())
        found_total += got
        report.append(f"{p.name}\n  {len(body)} characters read\n"
                      f"  {got} of {len(FIELDS)} fields found in {took:.1f} s\n{note}")

    secs = time.time() - start
    report.append(f"Documents: {len(docs)}\nFields found: {found_total} of {len(docs) * len(FIELDS)}\n"
                  f"Seconds: {secs:.1f}\n")
    report.append(f"\nHow the job ran: {pathlib.Path(MODEL).name} via llama.cpp, {WHERE}, "
                  f"{GPU_LAYERS} layers on the card. No network.\n")
    (OUT / "extract-report.txt").write_text("".join(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
