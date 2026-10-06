# A client's own program: finds money amounts across its documents and totals them.
# Contract: inputs in /in (read-only), results in /out, no network.
FROM python:3.12-slim
COPY amounts.py /app/amounts.py
ENTRYPOINT ["python", "/app/amounts.py"]
