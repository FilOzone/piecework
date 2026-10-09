# PieceWork job: transcribe the client's audio and video where it is already stored.
# Contract: inputs in /in (read-only), results in /out, run with --network none.
#   docker build -t piecework/transcribe:v1 .
# This is the CPU build, so it runs anywhere — but transcription is the workload where a GPU stops being a
# nicety: see Dockerfile.gpu, which is the same code with a bigger model and roughly twenty times the speed.
FROM python:3.11-slim
RUN pip install --no-cache-dir "faster-whisper==1.1.1" requests
# Baked in at build time, so the job itself needs no network. 'small' is the honest ceiling for a CPU run:
# accurate enough to search, and about as large as a machine without a card can chew through.
RUN python -c "from faster_whisper.utils import download_model; download_model('small', output_dir='/models/small')"
ENV HF_HUB_OFFLINE=1 MODEL_DIR=/models/small DEVICE=cpu COMPUTE_TYPE=int8 OMP_NUM_THREADS=4
COPY transcribe.py /app/transcribe.py
LABEL org.piecework.job="transcribe" \
      org.piecework.inputs="/in/*.mp3 /in/*.m4a /in/*.wav /in/*.mp4 /in/*.mov /in/*.mkv /in/*.webm" \
      org.piecework.outputs="/out/*-transcript.txt /out/*-subtitles.srt /out/*-segments.jsonl /out/transcribe-report.txt"
ENTRYPOINT ["python", "/app/transcribe.py"]
