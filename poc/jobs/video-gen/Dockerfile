# PieceWork job: build a video from the client's images, and record what it was built from.
# Contract: inputs in /in (read-only), results in /out, run with --network none.
#   docker build -t piecework/video-gen:v1 .
#
# The generator here is deliberately not a model. The product is the loop -- generate, store, look, build
# on it again, with every version naming its parent on chain -- and that loop can be built, run and paid
# for before any GPU is free. This one renders real video from the client's own images in seconds on a
# processor. The model version is Dockerfile.gpu and goes behind the same interface.
#
# Small by design: opencv and numpy, no model weights, no network at run time.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir opencv-python-headless==4.10.0.84 numpy==2.1.3
ENV GENERATOR=motion DEVICE=cpu
COPY generate.py /app/generate.py
LABEL org.piecework.job="video-gen" org.piecework.inputs="/in/*.jpg /in/*.png /in/prompt.json" \
      org.piecework.outputs="/out/version-N.mp4 /out/version-N.json /out/video-gen-report.txt"
ENTRYPOINT ["python", "/app/generate.py"]
