"""PII detection and redaction for financial documents (RWA / tradfi).

Job contract (same for every PieceWork job): read the client's files from /in (read-only), write results to /out,
no network. Outputs:
  /out/pii-report.txt          what was found, per document and in total, plus how fast the job ran
  /out/redacted-documents.txt  every input document with personal and account data replaced by <TYPE>

Detection: Microsoft Presidio (spaCy en_core_web_lg for names and places, pattern recognizers with checksums for
IBANs, card numbers, emails, phone numbers, US SSNs) plus a few finance-specific recognizers below.
"""
import os
import re
import sys
import time
from collections import Counter
from multiprocessing import Pool

IN, OUT = "/in", "/out"
SEPARATOR = re.compile(r"\n={20,}\n")  # the bulk corpus puts several documents in one file
DOB_CONTEXT = re.compile(r"(born|birth)\W*$", re.I)
ENTITIES = ["PERSON", "LOCATION", "EMAIL_ADDRESS", "PHONE_NUMBER", "IBAN_CODE", "CREDIT_CARD", "US_SSN", "DATE_TIME",
            "SWIFT_BIC", "PASSPORT_NUMBER", "WALLET_ADDRESS", "STREET_ADDRESS"]

_analyzer = _anonymizer = None


def engines():
    """Built once per worker process: loading the language model takes a few seconds."""
    global _analyzer, _anonymizer
    if _analyzer is None:
        from presidio_analyzer import AnalyzerEngine, Pattern, PatternRecognizer
        from presidio_analyzer.nlp_engine import NlpEngineProvider
        from presidio_anonymizer import AnonymizerEngine
        nlp = NlpEngineProvider(nlp_configuration={
            "nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": "en_core_web_lg"}]}).create_engine()
        _analyzer = AnalyzerEngine(nlp_engine=nlp, supported_languages=["en"])
        case = re.DOTALL | re.MULTILINE  # Presidio ignores case by default; codes below are upper case only
        _analyzer.registry.add_recognizer(PatternRecognizer(
            supported_entity="SWIFT_BIC", context=["bic", "swift", "bank", "account", "settlement"], global_regex_flags=case,
            patterns=[Pattern("bic", r"\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b", 0.3)]))
        _analyzer.registry.add_recognizer(PatternRecognizer(
            supported_entity="PASSPORT_NUMBER", context=["passport"], global_regex_flags=case,
            patterns=[Pattern("passport", r"\b[A-Z]\d{7,8}\b", 0.3)]))
        _analyzer.registry.add_recognizer(PatternRecognizer(  # "Via Roma 39, 20121 Milano": street, number, postcode
            supported_entity="STREET_ADDRESS", context=["address", "residing", "from"], global_regex_flags=case,
            patterns=[Pattern("street", r"\b(?:[A-Z][\w.'-]*\s){1,4}\d{1,4},\s*[A-Z0-9]{3,5}(?:\s[A-Z0-9]{2,3})?\b", 0.5)]))
        _analyzer.registry.add_recognizer(PatternRecognizer(
            supported_entity="WALLET_ADDRESS", patterns=[Pattern("evm", r"\b0x[a-fA-F0-9]{40}\b", 0.9)]))
        _anonymizer = AnonymizerEngine()
    return _analyzer, _anonymizer


def keep(text, r):
    """Dates are personal data only when they are dates of birth; trade and settlement dates are not.
    Names never span lines (the language model sometimes runs a name into the next line's label)."""
    nl = text.find("\n", r.start, r.end)
    if nl != -1:
        r.end = nl
    if r.entity_type == "LOCATION" and r.end - r.start <= 2:  # "US" in "US SSN" is not an address
        return False
    if r.entity_type == "DATE_TIME":
        return bool(DOB_CONTEXT.search(text[max(0, r.start - 20):r.start]))
    if r.entity_type in ("SWIFT_BIC", "PASSPORT_NUMBER"):
        return r.score >= 0.4  # pattern alone is ambiguous; require the context word nearby
    return r.score >= 0.4


FAST = os.environ.get("MODE") == "fast"  # patterns only: skips the language model (no names or places)
PATTERN_ENTITIES = ["EMAIL_ADDRESS", "PHONE_NUMBER", "IBAN_CODE", "CREDIT_CARD", "US_SSN", "SWIFT_BIC", "PASSPORT_NUMBER",
                    "WALLET_ADDRESS", "STREET_ADDRESS"]


def analyze_fast(analyzer, doc):
    from presidio_analyzer import EntityRecognizer
    out = []
    for rec in analyzer.registry.get_recognizers(language="en", entities=PATTERN_ENTITIES):
        if rec.name == "PhoneRecognizer" or hasattr(rec, "patterns"):
            out += rec.analyze(text=doc, entities=PATTERN_ENTITIES, nlp_artifacts=None)
    return EntityRecognizer.remove_duplicates(out)


def process(doc):
    """Returns (entity counts, redacted text, bytes) for one document."""
    from presidio_anonymizer.entities import OperatorConfig
    analyzer, anonymizer = engines()
    found = analyze_fast(analyzer, doc) if FAST else analyzer.analyze(text=doc, language="en", entities=ENTITIES)
    results = [r for r in found if keep(doc, r)]
    redacted = anonymizer.anonymize(text=doc, analyzer_results=results,
                                    operators={"DEFAULT": OperatorConfig("replace", {})}).text
    return Counter(r.entity_type for r in results), redacted, len(doc.encode())


def main():
    files = sorted(f for f in os.listdir(IN) if f.endswith(".txt"))
    docs = []  # (file, index, text)
    for f in files:
        with open(os.path.join(IN, f), encoding="utf-8", errors="replace") as fh:
            for i, d in enumerate(SEPARATOR.split(fh.read())):
                if d.strip():
                    docs.append((f, i, d))
    workers = int(os.environ.get("WORKERS", os.cpu_count() or 1))
    t0 = time.time()
    with Pool(workers, initializer=engines) as pool:
        pool.map(time.sleep, [0.05] * workers)  # wait until every worker has loaded the language model
        t1 = time.time()
        results = pool.map(process, [d for _, _, d in docs], chunksize=max(1, len(docs) // (workers * 8)))
    t2 = time.time()

    total, per_file, nbytes = Counter(), {}, 0
    with open(os.path.join(OUT, "redacted-documents.txt"), "w") as out:
        for (f, i, _), (counts, redacted, b) in zip(docs, results):
            total += counts
            per_file.setdefault(f, Counter()).update(counts)
            nbytes += b
            out.write(f"===== {f}{f' (document {i + 1})' if i else ''} =====\n{redacted.strip()}\n\n")

    scan = max(t2 - t1, 1e-6)
    with open(os.path.join(OUT, "pii-report.txt"), "w") as rep:
        rep.write("PII report: personal and account data found in your documents\n\n")
        rep.write(f"Documents scanned: {len(docs)} in {len(files)} files, {nbytes:,} bytes\n")
        rep.write(f"Found in total: {sum(total.values())} items\n")
        for k, v in total.most_common():
            rep.write(f"  {k.replace('_', ' ').lower()}: {v}\n")
        rep.write("\nPer file:\n")
        for f in files:
            c = per_file.get(f, Counter())
            rep.write(f"  {f}: " + (", ".join(f"{v} {k.replace('_', ' ').lower()}" for k, v in c.most_common()) or "nothing found") + "\n")
        rep.write("\nA redacted copy of every document is in redacted-documents.txt (each item replaced by its type).\n")
        rep.write(f"\nHow the job ran: {'patterns only (no names or places), ' if FAST else ''}{workers} CPU workers, model loading {t1 - t0:.1f} s, scanning {scan:.1f} s, "
                  f"{nbytes / scan / 1e6:.2f} MB/s ({len(docs) / scan:.1f} documents/s). No GPU, no network.\n")
    print(f"{len(docs)} docs, {nbytes / 1e6:.2f} MB, {workers} workers, load {t1 - t0:.1f}s, scan {scan:.1f}s, "
          f"{nbytes / scan / 1e6:.3f} MB/s", file=sys.stderr)


if __name__ == "__main__":
    main()
