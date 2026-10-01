# PieceWork job: the client's SQL, run over the client's tables, where they are stored.
# Contract: inputs in /in (read-only), results in /out, run with --network none. No GPU.
#   docker build -t piecework/query:v1 .
FROM python:3.12-slim
RUN pip install --no-cache-dir duckdb==1.1.3 pandas==2.2.3
COPY query.py /app/query.py
LABEL org.piecework.job="query" org.piecework.inputs="/in/query*.sql /in/*.csv /in/*.parquet" \
      org.piecework.outputs="/out/results.csv /out/query-report.txt"
ENTRYPOINT ["python", "/app/query.py"]
