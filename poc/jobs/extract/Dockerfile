# PieceWork job: pull the facts out of the client's documents, next to where they are stored.
# Contract: inputs in /in (read-only), results in /out, run with --network none.
#   docker build -t piecework/extract:v1 .
#
# The CPU baseline. A 1.5B model at four bits is about a gigabyte and runs on any processor; this is the
# number the GPU variant has to beat, and for this workload it may not beat it by much. Generation is
# memory-bandwidth bound, so a card wins on bandwidth rather than arithmetic — a real advantage, but a
# smaller one than the 20x people expect when they hear "GPU".
#
# Two stages because llama-cpp-python compiles from source: the toolchain is a few hundred megabytes and
# there is no reason to ship it to a provider.
FROM python:3.12-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --target=/site llama-cpp-python==0.3.2 huggingface-hub==0.26.2
ARG REPO=Qwen/Qwen2.5-1.5B-Instruct-GGUF
ARG FILE=qwen2.5-1.5b-instruct-q4_k_m.gguf
# Fetched now, while there is still a network. At run time there is not, and a program that discovers that
# by trying to download weights fails with a connection error that says nothing about the real cause.
RUN PYTHONPATH=/site python -c "\
from huggingface_hub import hf_hub_download; import shutil;\
shutil.copy(hf_hub_download(repo_id='$REPO', filename='$FILE'), '/model.gguf')"

FROM python:3.12-slim
# llama.cpp links OpenMP. Without libgomp the import fails at run time with a missing-shared-library error
# that names libllama.so rather than the library actually absent, which sends you looking in the wrong place.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /site /usr/local/lib/python3.12/site-packages
RUN mkdir -p /model
COPY --from=build /model.gguf /model/model.gguf
ENV MODEL=/model/model.gguf GPU_LAYERS=0 WHERE=CPU
COPY extract.py /extract.py
LABEL org.piecework.job="extract" org.piecework.inputs="/in/*.txt" \
      org.piecework.outputs="/out/*-fields.json /out/extract-report.txt"
ENTRYPOINT ["python", "/extract.py"]
