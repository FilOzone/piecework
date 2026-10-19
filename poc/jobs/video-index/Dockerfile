# PieceWork job: index what is in the client's video, next to where it is stored.
# Contract: inputs in /in (read-only), results in /out, run with --network none.
#   docker build -t piecework/video-index:v1 .
#
# The CPU baseline, and the number the GPU variant has to beat. Detection is a convolutional forward pass
# per frame, which is the shape of work where a card is tens of times faster rather than the two or three
# it manages on speech — so unlike transcription, this is a row where the processor is genuinely the wrong
# tool for an archive, not merely the slower one.
#
# This is also the clearest case for running compute where the data already is: the input is a video and
# the output is a few kilobytes of timeline. The report prints that ratio rather than asserting it.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*
# CPU-only torch: the CUDA wheels are several gigabytes and nothing here can use them.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
      torch==2.5.1 torchvision==0.20.1 \
 && pip install --no-cache-dir opencv-python-headless==4.10.0.84
# Weights at build time: the job runs with no network and must not reach for them later. A model that
# downloads on first use works perfectly in testing and fails on every real job.
ENV TORCH_HOME=/models
RUN python -c "import torchvision as tv; \
    tv.models.detection.fasterrcnn_mobilenet_v3_large_fpn(\
      weights=tv.models.detection.FasterRCNN_MobileNet_V3_Large_FPN_Weights.COCO_V1)"
ENV DEVICE=cpu SAMPLE_FPS=1 SCORE=0.5
COPY index.py /app/index.py
LABEL org.piecework.job="video-index" org.piecework.inputs="/in/*.mp4 /in/*.mov /in/*.mkv" \
      org.piecework.outputs="/out/*-index.txt /out/video-index-report.txt"
ENTRYPOINT ["python", "/app/index.py"]
