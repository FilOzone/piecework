# PieceWork job: enlarge and clean up the client's photographs, next to where they are stored.
# Contract: inputs in /in (read-only), results in /out, run with --network none.
#   docker build -t piecework/photo-restore:v1 .
#
# The CPU baseline. Every output pixel passes through 23 residual-in-residual blocks, so one four-times
# upscale is hundreds of gigaflops of convolution: 17.6 s for a 320x320 image here, which scales to about
# 35 minutes for a 12-megapixel photograph. A card does the same work about fifteen times faster.
#
# An earlier version of this comment said 342 s and called the card's advantage two-hundred-fold. That CPU
# run was taken while a zkVM prover had the machine, so it measured contention rather than convolution.
# Measure on a quiet machine or do not measure.
#
# Real-ESRGAN's published weights, baked in so the job needs no network. The architecture is written out in
# restore.py rather than imported: the usual package pulls basicsr, which imports a torchvision module
# removed in 0.16, so it installs cleanly and fails on the first photograph.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 \
 && pip install --no-cache-dir pillow==11.0.0 numpy==2.1.3
ARG WEIGHTS_URL=https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth
RUN mkdir -p /models && curl -fsSL "$WEIGHTS_URL" -o /models/RealESRGAN_x4plus.pth
ENV DEVICE=cpu WEIGHTS=/models/RealESRGAN_x4plus.pth TILE=256 OVERLAP=16
COPY restore.py /app/restore.py
LABEL org.piecework.job="photo-restore" org.piecework.inputs="/in/*.jpg /in/*.png" \
      org.piecework.outputs="/out/*-restored.png /out/photo-restore-report.txt"
ENTRYPOINT ["python", "/app/restore.py"]
