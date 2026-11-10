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
# MUXL canonicalises the container so a segment's identifier does not depend on which muxer, or
# which version of one muxer, packaged it. Pinned to a tag: the canonical form is Stabilising at
# v0.3.x, and a canonical form that moves is a reuse index that silently invalidates. Built from
# source because MUXL publishes no binaries and is on neither crates.io nor npm (checked 9 Nov 2026).
FROM rust:1-slim AS muxl
RUN apt-get update && apt-get install -y --no-install-recommends git pkg-config \
 && rm -rf /var/lib/apt/lists/*
RUN cargo install --locked --git https://github.com/streamplace/muxl --tag v0.3.6 --bin muxl --root /muxl

FROM python:3.12-slim
# ffmpeg is here for one reason: libx264. opencv-python-headless ships ffmpeg without an H.264 encoder,
# so its only working MP4 codec is mp4v -- a valid file that no browser will play.
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 ffmpeg \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir opencv-python-headless==4.10.0.84 numpy==2.1.3
ENV GENERATOR=motion DEVICE=cpu
COPY --from=muxl /muxl/bin/muxl /usr/local/bin/muxl
COPY generate.py /app/generate.py
LABEL org.piecework.job="video-gen" org.piecework.inputs="/in/*.jpg /in/*.png /in/prompt.json" \
      org.piecework.outputs="/out/version-N.mp4 /out/version-N.json /out/video-gen-report.txt"
ENTRYPOINT ["python", "/app/generate.py"]
