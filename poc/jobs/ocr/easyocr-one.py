"""Read one image with EasyOCR on the card. Printed to stdout so run.sh treats it exactly like tesseract."""
import sys, easyocr

img, lang = sys.argv[1], sys.argv[2]
# The models are baked into the image at build time: a job runs with no network, so a reader that tries to
# download weights on first use fails with a connection error that says nothing about the real cause.
reader = easyocr.Reader([{"eng": "en"}.get(lang, lang)], gpu=True, download_enabled=False,
                        model_storage_directory="/models", user_network_directory="/models")
# detail=0 gives the text only; paragraph=True joins fragments that belong to the same block, which is what
# makes the output comparable with tesseract's rather than a list of words.
for line in reader.readtext(img, detail=0, paragraph=True):
    print(line)
