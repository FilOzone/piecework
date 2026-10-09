"""Speech in the client's audio and video, turned into text that can be read, searched and jumped into.

Job contract (same for every PieceWork job): read the client's files from /in (read-only), write results to
/out, no network. For each media file:
  <name>-transcript.txt   the words, in paragraphs, each one beginning with the time it was said
  <name>-subtitles.srt    the same thing as subtitles, which any player will load
  <name>-segments.jsonl   one line per segment: start, end, text — for anything that wants the structure
  transcribe-report.txt   what was transcribed, how long it took, and how much faster than real time

Model: Whisper through faster-whisper (CTranslate2), baked into the image so the job needs no network.

The timestamps in the transcript are the point, not decoration. A transcript is a wall of text, and the one
question people actually ask of a recording is "where was that said". Because each paragraph opens with
[hh:mm:ss], the existing embed:v1 and search:v1 jobs need no changes at all: they chunk on blank lines, so
every chunk they embed already carries its own timestamp, and an answer comes back pointing at the moment.

That only holds if a paragraph fits inside one of embed:v1's chunks. Let a paragraph grow past CHUNK_CHARS
and embed splits it in the middle, producing a chunk that starts mid-sentence with no time on it — so
PARAGRAPH_CHARS is kept deliberately below it.
"""
import json
import os
import sys
import time

IN, OUT = "/in", "/out"
MODEL_DIR = os.environ.get("MODEL_DIR", "/models/small")
DEVICE = os.environ.get("DEVICE", "cpu")
COMPUTE = os.environ.get("COMPUTE_TYPE", "int8")
LANGUAGE = os.environ.get("LANGUAGE") or None  # None = detect it
PARAGRAPH = int(os.environ.get("PARAGRAPH_CHARS", "350"))  # deliberately under embed:v1 CHUNK_CHARS (400)
MEDIA = (".mp3", ".m4a", ".wav", ".flac", ".ogg", ".opus", ".aac", ".wma",
         ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v")
# Our own outputs, and other jobs'. A data set fills up with derived files, and transcribing a transcript
# is both expensive and pointless.
DERIVED = ("-transcript.txt", "-subtitles.srt", "-segments.jsonl", "-480p.mp4", "-thumb.jpg")


def clock(seconds, comma=False):
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    if comma:  # srt wants hh:mm:ss,mmm
        return f"{h:02d}:{m:02d}:{s:02d},{int((seconds % 1) * 1000):03d}"
    return f"{h:02d}:{m:02d}:{s:02d}"


def paragraphs(segments):
    """Group segments into paragraphs of at most PARAGRAPH characters, each stamped with its start time.

    The flush happens BEFORE appending a segment that would overflow, not after. Flushing afterwards lets a
    paragraph overshoot by a whole segment, which is enough to carry it past embed:v1's chunk size — and then
    embed splits it mid-word and that chunk has no time on it, which is the one thing this is all for.
    """
    out, current, start = [], "", None
    for seg in segments:
        text = seg["text"]
        if current and len(current) + 1 + len(text) > PARAGRAPH:
            out.append((start, current))
            current, start = "", None
        if start is None:
            start = seg["start"]
        current = f"{current} {text}".strip()
    if current:
        out.append((start or 0.0, current))
    return out


def main():
    from faster_whisper import WhisperModel

    files = sorted(f for f in os.listdir(IN)
                   if f.lower().endswith(MEDIA) and not f.endswith(DERIVED))
    report = open(os.path.join(OUT, "transcribe-report.txt"), "w")
    report.write("Transcription: the speech in your recordings, as text you can search\n\n")
    if not files:
        report.write("No audio or video files found in this data set.\n"
                     f"Looked for: {' '.join(MEDIA)}\n")
        report.close()
        print("no media files", file=sys.stderr)
        return

    t0 = time.time()
    model = WhisperModel(MODEL_DIR, device=DEVICE, compute_type=COMPUTE)
    load = time.time() - t0
    where = "GPU" if DEVICE == "cuda" else "CPU only"
    report.write(f"How the job ran: {where}, model {os.path.basename(MODEL_DIR)} ({COMPUTE}), "
                 f"loaded in {load:.1f} s. No network.\n\n")

    total_audio, total_spent, done = 0.0, 0.0, 0
    for f in files:
        stem = os.path.splitext(f)[0]
        t1 = time.time()
        try:
            # vad_filter drops the silence. On a recording with long gaps — a lecture, an interview, a
            # security camera — that is most of the file, and skipping it is most of the speed-up.
            segments, info = model.transcribe(os.path.join(IN, f), language=LANGUAGE,
                                              vad_filter=True, beam_size=5)
            segments = [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in segments]
        except Exception as e:  # a file that is not really media, or a codec we cannot read
            report.write(f"{f}: could not be read ({type(e).__name__}: {e})\n")
            continue
        spent = time.time() - t1
        length = info.duration
        total_audio, total_spent, done = total_audio + length, total_spent + spent, done + 1

        with open(os.path.join(OUT, f"{stem}-transcript.txt"), "w") as out:
            out.write(f"{f} — {clock(length)}, {info.language} "
                      f"(confidence {info.language_probability:.0%})\n\n")
            for start, text in paragraphs(segments):
                out.write(f"[{clock(start)}] {text}\n\n")

        with open(os.path.join(OUT, f"{stem}-subtitles.srt"), "w") as out:
            for i, s in enumerate(segments, 1):
                out.write(f"{i}\n{clock(s['start'], True)} --> {clock(s['end'], True)}\n{s['text']}\n\n")

        with open(os.path.join(OUT, f"{stem}-segments.jsonl"), "w") as out:
            for s in segments:
                out.write(json.dumps(s) + "\n")

        words = sum(len(s["text"].split()) for s in segments)
        report.write(f"{f}: {clock(length)} of {info.language}, {len(segments)} segments, {words:,} words, "
                     f"transcribed in {spent / 60:.1f} min ({length / max(spent, 1e-6):.0f}x real time)\n")

    if done:
        report.write(f"\nTotal: {clock(total_audio)} of audio in {total_spent / 60:.1f} min of compute — "
                     f"{total_audio / max(total_spent, 1e-6):.0f}x faster than listening to it.\n")
        report.write("\nEach paragraph of the transcript begins with the time it was said, so ordering "
                     "embed:v1 over these transcripts — or running the keep-it-searchable service — gives "
                     "you search across hours of recordings that answers with the moment, not just the file.\n")
        report.write("\nThe recordings never moved. They were already at this provider; only the text left.\n")
    report.close()
    print(f"{done} file(s), {total_audio / 60:.1f} min audio in {total_spent / 60:.1f} min "
          f"({total_audio / max(total_spent, 1e-6):.0f}x real time) on {where}", file=sys.stderr)


if __name__ == "__main__":
    main()
