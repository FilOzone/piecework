# PieceWork job: takes the background, or the people, out of the client's photographs.
# Contract: inputs in /in (read-only), results in /out, run with --network none — so the model is baked in.
#   docker build -t piecework/image-clean:v1 .
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir "rembg[cpu]==2.0.59" opencv-python-headless==4.10.0.84 pillow numpy
# Fetch the weights at build time: the job runs with no network and must not reach for them later.
RUN python -c "import rembg; rembg.new_session('u2net'); rembg.new_session('u2net_human_seg')"
COPY clean.py /app/clean.py
LABEL org.piecework.job="image-clean" org.piecework.inputs="/in/*.jpg /in/*.png /in/what.txt" \
      org.piecework.outputs="/out/*-clean.png /out/*-mask.png /out/image-clean-report.txt"
ENTRYPOINT ["python", "/app/clean.py"]
