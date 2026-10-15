# PieceWork job: read the client's scanned pages into text, next to where the scans are stored.
# Contract: inputs in /in (read-only), results in /out, run with --network none.
#   docker build -t piecework/ocr:v1 .
#
# Tesseract on the processor. It is not the most accurate engine available, but it is small, it needs no
# model downloaded at run time — which matters because the job has no network — and it is the honest CPU
# baseline the GPU variant has to beat for the GPU variant to be worth anything.
FROM alpine:3.20
RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-eng poppler-utils
COPY run.sh /run.sh
COPY ocr-one.sh /ocr-one.sh
RUN chmod +x /run.sh /ocr-one.sh
LABEL org.piecework.job="ocr" org.piecework.inputs="/in/*.png /in/*.jpg /in/*.tif /in/*.pdf" \
      org.piecework.outputs="/out/*-text.txt /out/ocr-report.txt"
ENTRYPOINT ["/run.sh"]
