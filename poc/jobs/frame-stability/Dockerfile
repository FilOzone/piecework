# PieceWork job: prove whether a region of the picture moved, frame by frame.
# Contract: inputs in /in (read-only), results in /out, run with --network none.
#   docker build -t piecework/frame-stability:v1 .
#
# No model and no card: normalised cross-correlation in a small window around where the region should be.
# It reads EVERY frame rather than sampling, which is the whole difference from frame-similarity -- a claim
# that something never moved is worth nothing if the frame it moved in was one of the ones skipped.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir opencv-python-headless==4.10.0.84
COPY stability.py /app/stability.py
LABEL org.piecework.job="frame-stability" org.piecework.inputs="/in/*.mp4 /in/track.json" \
      org.piecework.outputs="/out/*-stability.txt /out/*-stability.json /out/frame-stability-report.txt"
ENTRYPOINT ["python", "/app/stability.py"]
