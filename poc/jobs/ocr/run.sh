#!/bin/sh
# PieceWork job: turn the client's scanned pages into text, where the scans are stored.
#
# Contract: inputs in /in (read-only), results in /out, no network.
#   /out/<name>-text.txt   what the page says
#   /out/ocr-report.txt    what was read, how long it took, and on what
#
# The shape that makes this ours: a scanned archive is large and its text is tiny, so moving the images to
# the compute costs far more than moving the compute to the images. It is also the case where the client
# cannot check the output by eye at scale — nobody proofreads a million pages — which is where a proof of
# what ran starts to be worth paying for.
set -eu

# One script, two engines, for the same reason transcode has one: a second copy drifts. tesseract runs on the
# processor; easyocr runs on the card and is a different program entirely, so the difference is settled here.
ENGINE="${ENGINE:-tesseract}"
LANG_CODE="${LANG_CODE:-eng}"
REPORT=/out/ocr-report.txt
: > "$REPORT"
printf 'OCR: your scans, read where they are stored\n\n' >> "$REPORT"

n=0; chars=0; bytes_in=0
start=$(date +%s)

for f in /in/*; do
  [ -f "$f" ] || continue
  case "$(printf '%s' "$f" | tr 'A-Z' 'a-z')" in
    *.png|*.jpg|*.jpeg|*.tif|*.tiff|*.bmp|*.pdf) ;;
    *) continue ;;
  esac
  base=$(basename "$f"); stem=${base%.*}
  src=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f")
  out="/out/${stem}-text.txt"

  case "$(printf '%s' "$f" | tr 'A-Z' 'a-z')" in
    *.pdf)
      # A PDF is a container, not an image. Rasterise each page first; pdftotext would return nothing at all
      # for a scan, which is the case this job exists for.
      work=$(mktemp -d)
      pdftoppm -r "${DPI:-200}" -png "$f" "$work/page"
      : > "$out"
      for page in "$work"/page-*.png; do
        [ -f "$page" ] || continue
        /ocr-one.sh "$ENGINE" "$LANG_CODE" "$page" >> "$out"
        printf '\n' >> "$out"
      done
      rm -rf "$work" ;;
    *)
      /ocr-one.sh "$ENGINE" "$LANG_CODE" "$f" > "$out" ;;
  esac

  got=$(wc -c < "$out" | tr -d ' ')
  n=$((n + 1)); chars=$((chars + got)); bytes_in=$((bytes_in + src))
  printf '%s\n  in  %s bytes\n  out %s characters of text\n' "$base" "$src" "$got" >> "$REPORT"
  # A scan that yields almost nothing is the common failure and it is silent: the job "succeeded" and the
  # client gets an empty file. Say so here rather than let them find out by reading it.
  [ "$got" -lt 20 ] && printf '  almost no text found — the scan may be blank, upside down, or too low a resolution\n' >> "$REPORT"
  printf '\n' >> "$REPORT"
done

[ "$n" -gt 0 ] || { echo "no images or PDFs in /in" >&2; exit 1; }
secs=$(( $(date +%s) - start ))
printf 'Files: %s\nRead: %s bytes\nProduced: %s characters\nSeconds: %s\n' "$n" "$bytes_in" "$chars" "$secs" >> "$REPORT"
printf '\nHow the job ran: %s, %s. No network.\n' "$ENGINE" "${WHERE:-CPU}" >> "$REPORT"
