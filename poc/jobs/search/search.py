"""Answers a question about the client's documents, using the vectors already sitting next to them.

Service contract: the question arrives as a new file in /in (read-only), the vectors written by an earlier
embedding run are mounted at /context (read-only), the answer goes to /out. No network.

Nothing about the client's documents leaves the provider: the question is matched against vectors that were
computed here, and what comes back is a pointer to the client's own files.
"""
import glob
import json
import os
import re
import time

IN, CONTEXT, OUT = "/in", "/context", "/out"
MODEL = os.environ.get("MODEL", "BAAI/bge-small-en-v1.5")
TOP = int(os.environ.get("TOP", "5"))
# bge models are trained asymmetrically: a question has to be marked as a question, or it is compared as if it
# were another passage. Without this line the right file routinely loses to a longer one that merely discusses
# the same subject.
QUERY_PREFIX = os.environ.get("QUERY_PREFIX", "Represent this sentence for searching relevant passages: ")
KEYWORD_WEIGHT = float(os.environ.get("KEYWORD_WEIGHT", "0.35"))
STOP = set("""a an and are as at be by do does for from how i if in is it its me my of on or our so than that the
their them then there these this to us was we what when where which who why will with you your""".split())


# A question and an answer are not documents. Once they live in the data set the embedding service picks them
# up like anything else, and then a question's closest match is itself, or the answer that quoted it. Whatever
# produced them, they are excluded from what can be returned.
DERIVED = re.compile(r"^(ask|answer|pii-report|redacted-documents|embeddings|embeddings-report|search-index)"
                     r"([ ._-][\w-]*)?\.[a-z0-9]+$", re.I)


def load_vectors():
    rows = []
    for path in sorted(glob.glob(os.path.join(CONTEXT, "*.jsonl"))):
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(r.get("vector"), list) and not DERIVED.match(str(r.get("file", ""))):
                    rows.append(r)
    return rows


def words(text):
    return {w for w in re.findall(r"[a-z0-9]{3,}", text.lower()) if w not in STOP}


def keyword_score(question_words, row):
    """How much of the question appears literally in the passage or in the name of the file holding it.

    Meaning-matching alone answers "what is this about"; it is weak at "which file says X", where the exact
    word matters and the file's name is often the answer. The two are blended rather than chosen between.
    """
    if not question_words:
        return 0.0
    have = words(str(row.get("text") or row.get("preview") or "")) | words(re.sub(r"[._-]+", " ", str(row.get("file", ""))))
    return len(question_words & have) / len(question_words)


def cosine(a, b):
    dot = na = nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    return dot / ((na ** 0.5) * (nb ** 0.5)) if na and nb else 0.0


def main():
    rows = load_vectors()
    questions = []
    for f in sorted(os.listdir(IN)):
        with open(os.path.join(IN, f), encoding="utf-8", errors="replace") as fh:
            text = fh.read().strip()
        if text:
            questions.append((f, text))

    lines = []
    if not rows:
        lines.append("No vectors were found next to your data.")
        lines.append("")
        lines.append("This service answers from the embeddings written by \"Keep my data set searchable\".")
        lines.append("Start that service (or order an embedding job) and the vectors will be here.")
    else:
        from fastembed import TextEmbedding
        model = TextEmbedding(model_name=MODEL, providers=["CPUExecutionProvider"])
        t0 = time.time()
        vectors = list(model.embed([QUERY_PREFIX + q for _, q in questions]))
        for (name, question), qv in zip(questions, vectors):
            qw = words(question)
            ranked = []
            for r in rows:
                meaning = cosine(qv, r["vector"])
                literal = keyword_score(qw, r)
                ranked.append((meaning * (1 - KEYWORD_WEIGHT) + literal * KEYWORD_WEIGHT, meaning, literal, r))
            scored = sorted(ranked, key=lambda x: -x[0])[:TOP]
            lines.append(f"Question ({name}):")
            for para in question.splitlines():
                lines.append(f"  {para}")
            lines.append("")
            lines.append(f"Closest passages in your own files, out of {len(rows)} embedded chunks:")
            for rank, (score, meaning, literal, r) in enumerate(scored, 1):
                preview = re.sub(r"\s+", " ", str(r.get("preview", ""))).strip()
                lines.append(f"  {rank}. {r.get('file', '?')} (chunk {r.get('chunk', '?')}) — "
                             f"score {score:.3f} (meaning {meaning:.3f}, words {literal:.3f})")
                lines.append(f"     {preview}")
            lines.append("")
        lines.append(f"Answered in {time.time() - t0:.1f} s, entirely on the provider's machine.")

    with open(os.path.join(OUT, "answer.txt"), "w") as out:
        out.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
