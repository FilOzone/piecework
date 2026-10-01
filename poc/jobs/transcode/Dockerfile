# PieceWork job: re-encode the client's video next to the data, and return something much smaller.
# Contract: inputs in /in (read-only), results in /out, run with --network none.
#   docker build -t piecework/transcode:v1 .
FROM alpine:3.20
RUN apk add --no-cache ffmpeg
COPY run.sh /run.sh
LABEL org.piecework.job="transcode" org.piecework.inputs="/in/*.mp4 /in/*.mov /in/*.mkv" \
      org.piecework.outputs="/out/*-480p.mp4 /out/*-thumb.jpg /out/transcode-report.txt"
ENTRYPOINT ["/run.sh"]
