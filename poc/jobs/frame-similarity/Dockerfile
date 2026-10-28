# PieceWork job: how alike consecutive frames are, and where the video should therefore be cut.
# Contract: inputs in /in (read-only), results in /out, run with --network none.
#   docker build -t piecework/frame-similarity:v1 .
#
# No model and no card. This is a histogram distance per sampled frame -- the same measure video-index
# already uses to find shot changes -- so it runs at many times real time on a processor and a GPU would
# buy nothing. That is deliberate: the job it serves (deciding segment boundaries so the next version can
# reuse unchanged segments) is on the critical path for the storage saving, and it should not be waiting
# behind anything on a provider's one card.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir opencv-python-headless==4.10.0.84
ENV SAMPLE_FPS=2 CUT=0.45 MIN_SEGMENT=1.0
COPY similarity.py /app/similarity.py
LABEL org.piecework.job="frame-similarity" org.piecework.inputs="/in/*.mp4 /in/*.mov /in/*.mkv" \
      org.piecework.outputs="/out/*-similarity.txt /out/*-cuts.json /out/frame-similarity-report.txt"
ENTRYPOINT ["python", "/app/similarity.py"]
