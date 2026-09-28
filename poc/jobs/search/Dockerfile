# PieceWork service: answers a question from the vectors already stored next to the client's data.
# Contract: question in /in (read-only), vectors in /context (read-only), answer in /out, --network none.
#   docker build -t piecework/search:v1 .
FROM python:3.12-slim
RUN pip install --no-cache-dir fastembed==0.8.1 \
 && python -c "from fastembed import TextEmbedding; TextEmbedding(model_name='BAAI/bge-small-en-v1.5')"
COPY search.py /app/search.py
LABEL org.piecework.service="search" org.piecework.inputs="/in/*.txt" org.piecework.context="/context/*.jsonl" \
      org.piecework.outputs="/out/answer.txt"
ENTRYPOINT ["python", "/app/search.py"]
