# PieceWork job: embeddings over the client's documents, on CPU.
# Contract: inputs in /in (read-only), results in /out, run with --network none.
#   docker build -t piecework/embed:v1 .
FROM python:3.12-slim
RUN pip install --no-cache-dir fastembed==0.8.1 \
 && python -c "from fastembed import TextEmbedding; TextEmbedding(model_name='BAAI/bge-small-en-v1.5')"
COPY embed.py /app/embed.py
LABEL org.piecework.job="embed" org.piecework.inputs="/in/*.txt" \
      org.piecework.outputs="/out/embeddings.jsonl /out/embeddings-report.txt"
ENTRYPOINT ["python", "/app/embed.py"]
