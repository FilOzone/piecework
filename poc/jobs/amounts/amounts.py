"""Finds the money in a pile of documents, and adds it up.

Not something a provider would offer: it is the kind of small, specific question a client has about its own
files and nobody else's. That is the point of bringing your own program.

Contract, the same as every PieceWork job: read /in (read-only), write /out, no network.
  /out/amounts.txt  every amount found, by file, with totals per currency
"""
import os
import re
from collections import defaultdict

IN, OUT = "/in", "/out"
SYMBOLS = {"€": "EUR", "£": "GBP", "$": "USD"}
# 4,800.00 EUR  /  EUR 4,800.00  /  £2,350,000  /  1.234,56 EUR
AMOUNT = re.compile(
    r"(?:(?P<sym>[€£$])\s?(?P<n1>\d[\d.,]*)"
    r"|(?P<n2>\d[\d.,]*)\s?(?P<code1>EUR|GBP|USD|CHF|JPY)"
    r"|(?P<code2>EUR|GBP|USD|CHF|JPY)\s?(?P<n3>\d[\d.,]*))",
    re.I,
)


def as_number(raw):
    """4,800.00 and 1.234,56 both mean something; guess from which separator comes last."""
    s = raw.strip().rstrip(".,")
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".") if len(s.split(",")[-1]) == 2 else s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def main():
    files = sorted(f for f in os.listdir(IN) if f.lower().endswith((".txt", ".md", ".csv")))
    per_file, totals, counted = {}, defaultdict(float), 0
    for f in files:
        with open(os.path.join(IN, f), encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        found = []
        for m in AMOUNT.finditer(text):
            cur = SYMBOLS.get(m.group("sym") or "") or (m.group("code1") or m.group("code2") or "").upper()
            value = as_number(m.group("n1") or m.group("n2") or m.group("n3") or "")
            if not cur or value is None:
                continue
            found.append((cur, value, m.group(0).strip()))
            totals[cur] += value
            counted += 1
        if found:
            per_file[f] = found

    with open(os.path.join(OUT, "amounts.txt"), "w") as out:
        out.write("Money found in your documents\n\n")
        if not per_file:
            out.write("No amounts found in any of the files.\n")
        for f, found in per_file.items():
            out.write(f"{f}\n")
            for cur, value, raw in found:
                out.write(f"  {raw:<20} -> {value:,.2f} {cur}\n")
            out.write("\n")
        out.write(f"Files read: {len(files)}, of which {len(per_file)} mention money.\n")
        out.write(f"Amounts found: {counted}\n\n")
        for cur, total in sorted(totals.items()):
            out.write(f"Total {cur}: {total:,.2f}\n")
        out.write("\nRun on the provider's machine, over files that never left it. "
                  "This program is the client's own: no provider offers it.\n")


if __name__ == "__main__":
    main()
