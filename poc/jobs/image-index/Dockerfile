# PieceWork job: index what is in the client's still images, next to where they are stored.
# Contract: inputs in /in (read-only), results in /out, run with --network none.
#   docker build -t piecework/image-index:v1 .
#
# The CPU baseline, and the number the GPU variant has to beat. video-index does this for video; the
# archives that most want it are directories of stills -- robotics training data, satellite and scientific
# imagery, web crawls -- and a folder of a million photographs is the shape the data actually arrives in.
#
# Faces are detected and never identified. The detector here produces a box and nothing else: no embedding,
# no comparison between images, no database of people. That is what keeps a client indexing an archive out
# of GDPR Article 9 and BIPA territory, and it costs them nothing, because the question these archives ask
# is "which images have people in them", not "who is this".
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
ENV DEVICE=cpu SCORE=0.5 FACES=1
COPY index.py /app/index.py
LABEL org.piecework.job="image-index" org.piecework.inputs="/in/*.jpg /in/*.png /in/*.webp" \
      org.piecework.outputs="/out/*-index.txt /out/image-index.json /out/image-index-report.txt"
ENTRYPOINT ["python", "/app/index.py"]
