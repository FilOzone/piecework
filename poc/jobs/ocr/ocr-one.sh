#!/bin/sh
# Read one image. Split out so run.sh does not care which engine is installed, and so the PDF path and the
# image path go through exactly the same call.
set -eu
engine="$1"; lang="$2"; img="$3"
case "$engine" in
  tesseract) tesseract "$img" stdout -l "$lang" 2>/dev/null ;;
  easyocr)   python3 /easyocr-one.py "$img" "$lang" ;;
  *) echo "unknown OCR engine: $engine" >&2; exit 1 ;;
esac
