# PieceWork job: find and redact personal and account data in financial documents.
# Contract: inputs in /in (read-only), results in /out, run with --network none.
#   docker build -t piecework/pii-redact:v1 .
#   docker run --rm --network none -v <inputs>:/in:ro -v <outputs>:/out piecework/pii-redact:v1
FROM python:3.12-slim
RUN pip install --no-cache-dir presidio-analyzer==2.2.364 presidio-anonymizer==2.2.364 \
 && python -m spacy download en_core_web_lg \
 && python -c "import spacy; spacy.load('en_core_web_lg')" \
 && python -c "import tldextract; tldextract.extract('example.com')"
# the domain list above is cached at build time: the job itself runs with no network
COPY redact.py /app/redact.py
LABEL org.piecework.job="pii-redact" org.piecework.inputs="/in/*.txt" \
      org.piecework.outputs="/out/pii-report.txt /out/redacted-documents.txt"
ENTRYPOINT ["python", "/app/redact.py"]
