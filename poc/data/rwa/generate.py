#!/usr/bin/env python3
"""Synthetic RWA / tradfi documents for the PII job: loan agreements, KYC forms, invoices, trade confirmations.

Every person, company, address and account is made up. IBANs and card numbers have valid check digits so that
detectors that verify checksums (as Presidio does) treat them like real ones.

Usage:
  python3 generate.py demo <dir>           # the 8 documents stored in the demo data set
  python3 generate.py bulk <dir> <MB>      # a large corpus for the benchmark (not stored on chain)
"""
import os
import random
import re
import sys

FIRST = ["Marta", "Luca", "Sofia", "James", "Amelia", "Noah", "Chiara", "Lukas", "Emma", "Oliver", "Giulia", "Hugo",
         "Ines", "Mateo", "Clara", "Jonas", "Elena", "Arthur", "Lea", "Tomas", "Alice", "Pietro", "Nora", "Felix"]
LAST = ["Rossi", "Bianchi", "Smith", "Johnson", "Muller", "Schmidt", "Dubois", "Martin", "Garcia", "Lopez", "Novak",
        "Kowalski", "Jensen", "Nielsen", "Brown", "Taylor", "Ferrari", "Esposito", "Weber", "Fischer", "Moreau", "Silva"]
STREETS = ["Via Roma", "High Street", "Hauptstrasse", "Rue de la Paix", "Calle Mayor", "Main Street", "Kingsway",
           "Corso Buenos Aires", "Bahnhofstrasse", "Avenue Victor Hugo"]
CITIES = [("Milano", "IT", "20121"), ("London", "GB", "EC2V 7HH"), ("Berlin", "DE", "10117"), ("Paris", "FR", "75002"),
          ("Madrid", "ES", "28013"), ("New York", "US", "10005"), ("Zurich", "CH", "8001"), ("Amsterdam", "NL", "1012 AB")]
COMPANIES = ["Alder Capital Partners", "Brightwater Lending Ltd", "Castello Real Estate SpA", "Delta Receivables GmbH",
             "Everest Trade Finance SA", "Fjord Asset Management AS", "Granite Property Holdings LLC"]
BANKS = [("UniCredit", "UNCRITMMXXX", "IT"), ("Barclays", "BARCGB22XXX", "GB"), ("Deutsche Bank", "DEUTDEFFXXX", "DE"),
         ("BNP Paribas", "BNPAFRPPXXX", "FR"), ("Santander", "BSCHESMMXXX", "ES"), ("ING", "INGBNL2AXXX", "NL")]
ASSETS = ["office building at {a}", "residential portfolio of 14 flats in {c}", "trade receivables from {co}",
          "warehouse and logistics site near {c}", "senior secured loan to {co}"]

R = random.Random(2026)


def person():
    return f"{R.choice(FIRST)} {R.choice(LAST)}"


def address():
    city, cc, zip_ = R.choice(CITIES)
    return f"{R.choice(STREETS)} {R.randint(1, 180)}, {zip_} {city}", cc


def email(name):
    first, last = name.lower().split()
    return f"{first}.{last}@{R.choice(['mail.com', 'example.org', 'posteo.net', 'fastmail.com'])}"


def phone(cc):
    prefix, n = {"IT": ("+39 3", 9), "GB": ("+44 7", 9), "DE": ("+49 15", 9), "FR": ("+33 6", 8), "ES": ("+34 6", 8),
                 "US": ("+1 212 ", 7), "CH": ("+41 79 ", 7), "NL": ("+31 6", 8)}.get(cc, ("+39 3", 9))
    return prefix + "".join(str(R.randint(0, 9)) for _ in range(n))


def dob():
    return f"{R.randint(1, 28):02d}/{R.randint(1, 12):02d}/{R.randint(1955, 2000)}"


BBAN = {"IT": "L5n5n12c", "GB": "4a14n", "DE": "18n", "FR": "10n11c2n", "ES": "20n", "NL": "4a10n"}  # ISO 13616 formats


def iban(cc):
    """An IBAN in the country's real format, with correct check digits (ISO 13616, mod 97)."""
    bban = ""
    for count, kind in re.findall(r"(\d*)([a-zA-Z])", BBAN[cc]):
        n = int(count or 1)
        pool = {"n": "0123456789", "a": "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "c": "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
                "L": "ABCDEFGHIJKLMNOPQRSTUVWXYZ"}[kind]
        bban += "".join(R.choice(pool) for _ in range(n))
    num = "".join(str(int(ch, 36)) for ch in bban + cc + "00")
    check = 98 - int(num) % 97
    return f"{cc}{check:02d}{bban}"


def card():
    """A 16-digit Visa-like number with a valid Luhn digit."""
    digits = [4] + [R.randint(0, 9) for _ in range(14)]
    total = 0
    for i, d in enumerate(reversed(digits)):
        d = d * 2 if i % 2 == 0 else d
        total += d - 9 if d > 9 else d
    digits.append((10 - total % 10) % 10)
    s = "".join(map(str, digits))
    return " ".join(s[i:i + 4] for i in range(0, 16, 4))


def ssn():
    return f"{R.randint(100, 665):03d}-{R.randint(10, 99):02d}-{R.randint(1000, 9999):04d}"


def money():
    return f"{R.randint(50, 9000) * 1000:,} EUR"


def loan_agreement(n):
    b, (a, cc) = person(), address()
    bank, bic, bcc = R.choice(BANKS)
    co = R.choice(COMPANIES)
    asset = R.choice(ASSETS).format(a=a, c=a.split(", ")[1].split(" ")[-1], co=co)
    return f"""LOAN AGREEMENT No. LA-2026-{n:04d}

Lender: {co}
Borrower: {b}, born {dob()}, residing at {a}
Contact: {email(b)}, {phone(cc)}
Collateral: {asset}
Principal: {money()}   Rate: {R.choice(['fixed 4.35%', 'fixed 5.10%', 'variable, EURIBOR 3M + 2.10%', 'variable, EURIBOR 6M + 1.85%'])}   Term: {R.choice([36, 60, 120, 240])} months

Disbursement to the Borrower's account:
  Bank: {bank}   BIC: {bic}
  IBAN: {iban(bcc)}

Repayments are due on the first business day of each month. Late payments accrue interest at 4% above the agreed rate.
The Borrower confirms that the information above is complete and accurate.

Signed in {a.split(", ")[1].split(" ")[-1]} by {b} and, for the Lender, by {person()} (authorised signatory).
"""


def kyc_form(n):
    c, (a, cc) = person(), address()
    bank, bic, bcc = R.choice(BANKS)
    return f"""KNOW YOUR CUSTOMER (KYC) FORM   Ref. KYC-{n:05d}

Full name: {c}
Date of birth: {dob()}
Residential address: {a}
Email: {email(c)}   Phone: {phone(cc)}
Tax identification number (US SSN, if applicable): {ssn()}
Identity document: passport no. {R.choice('ABCDEFGHJK')}{R.randint(1000000, 9999999)}, valid until {R.randint(2027, 2034)}

Source of funds: {R.choice(['salary and savings', 'sale of property', 'business income', 'inheritance'])}
Expected annual investment: {money()}
Settlement account: {bank} ({bic}), IBAN {iban(bcc)}
Card on file for fees: {card()}

Politically exposed person: {R.choice(['No', 'No', 'No', 'Yes (family member)'])}
Reviewed by compliance officer {person()} on {R.randint(1, 28):02d}/09/2026.
"""


def invoice(n):
    co, buyer = R.choice(COMPANIES), R.choice(COMPANIES)
    contact, (a, cc) = person(), address()
    bank, bic, bcc = R.choice(BANKS)
    lines = "\n".join(f"  {R.choice(['Servicing fee', 'Legal due diligence', 'Valuation report', 'Custody fee', 'Arrangement fee'])}"
                      f"{' ' * 6}{R.randint(2, 90) * 100:,} EUR" for _ in range(R.randint(2, 4)))
    return f"""INVOICE INV-2026-{n:04d}

From: {co}, {a}
To: {buyer}, attention of {contact} ({email(contact)}, {phone(cc)})

{lines}

Payment within 30 days to {bank}, BIC {bic}, IBAN {iban(bcc)}.
Questions: accounts payable, {person()}, {phone(cc)}.
"""


def trade_confirmation(n):
    c, (a, cc) = person(), address()
    bank, bic, bcc = R.choice(BANKS)
    return f"""TRADE CONFIRMATION TC-{n:06d}

Client: {c}, {a}
Trade date: {R.randint(1, 28):02d}/09/2026   Settlement: T+2
Instrument: tokenized fund units, {R.choice(['Castello Real Estate Fund I', 'Brightwater Private Credit II', 'Delta Receivables Pool'])}
Side: {R.choice(['BUY', 'SELL'])}   Quantity: {R.randint(10, 5000)}   Price: {R.randint(90, 130)}.{R.randint(0, 99):02d} EUR
On-chain settlement address: 0x{''.join(R.choice('0123456789abcdef') for _ in range(40))}
Cash leg: {bank} ({bic}), IBAN {iban(bcc)}

Please contact your relationship manager {person()} at {phone(cc)} with any questions.
"""


KINDS = [("loan-agreement", loan_agreement), ("kyc-form", kyc_form), ("invoice", invoice), ("trade-confirmation", trade_confirmation)]


def main():
    mode, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    if mode == "demo":
        for kind, fn in KINDS:
            for i in (1, 2):
                with open(os.path.join(out, f"{kind}-{i}.txt"), "w") as f:
                    f.write(fn(i))
    elif mode == "bulk":
        target = int(float(sys.argv[3]) * 1_000_000)
        n, written, fileno = 0, 0, 0
        while written < target:  # files of ~1 MB, each a mix of all four document kinds
            with open(os.path.join(out, f"batch-{fileno:04d}.txt"), "w") as f:
                size = 0
                while size < 1_000_000 and written + size < target:
                    kind, fn = KINDS[n % 4]
                    doc = fn(n) + "\n" + "=" * 60 + "\n"
                    f.write(doc)
                    size += len(doc.encode())
                    n += 1
            written += size
            fileno += 1
        print(f"{n} documents, {written / 1e6:.1f} MB in {fileno} files")


if __name__ == "__main__":
    main()
