#!/usr/bin/env python3
"""How much of two videos is literally the same bytes?

    python3 v2/measure-dedup.py a.mp4 b.mp4

The question behind it: across iterations of a generated video, many frames are visually identical, and the
proposal is to store the shared blocks once rather than storing every version whole. That would be a real
cost advantage at scale -- if the sharing exists at the level storage can see.

It may not. Video codecs store most frames as differences from their neighbours, so "the same frame" is not
the same bytes; and a re-encode changes essentially every byte anyway, because GOP boundaries move, rate
control decides differently, and most encoders are not deterministic between runs. Deduplication needs
byte-identical runs. Whether any exist is a measurement, not an opinion, and this is the measurement.

Three strategies, because a sceptic will ask about each:
  fixed blocks            what naive block storage would find
  content-defined chunks  what IPLD/UnixFS can do -- a rolling hash picks boundaries from the content, so
                          an insertion shifts one chunk rather than every chunk after it
Both are reported, so a zero cannot be blamed on having chosen the wrong chunker.

Run it on output from a real generator before concluding anything about a real product. A first run on two
versions of this repository's own video-gen job -- which carries the previous version's frames forward
verbatim, so half the content is identical by construction -- found 0.0% shared by every strategy.
"""
import hashlib
import sys


def fixed(data, size):
    return [hashlib.sha256(data[i:i + size]).hexdigest() for i in range(0, len(data), size)]


def content_defined(data, avg=2048, smallest=512, largest=8192):
    chunks, start, h = [], 0, 0
    mask = (1 << (avg.bit_length() - 1)) - 1
    for i, byte in enumerate(data):
        h = ((h << 1) + byte) & 0xFFFFFFFF
        if (i - start + 1 >= smallest and (h & mask) == 0) or i - start + 1 >= largest:
            chunks.append(hashlib.sha256(data[start:i + 1]).hexdigest())
            start = i + 1
    if start < len(data):
        chunks.append(hashlib.sha256(data[start:]).hexdigest())
    return chunks


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    a, b = (open(p, "rb").read() for p in argv[1:3])
    print(f"{argv[1]}  {len(a):,} bytes")
    print(f"{argv[2]}  {len(b):,} bytes\n")
    rows = [("fixed 4 KB blocks", fixed(a, 4096), fixed(b, 4096)),
            ("fixed 1 KB blocks", fixed(a, 1024), fixed(b, 1024)),
            ("content-defined (~2 KB)", content_defined(a), content_defined(b))]
    worst = 0.0
    for label, ca, cb in rows:
        sa, sb = set(ca), set(cb)
        shared = sa & sb
        pct = 100 * len(shared) / max(1, len(sa))
        worst = max(worst, pct)
        print(f"{label:<26} {len(ca):>6} / {len(cb):>6} chunks   shared {len(shared):>5}   {pct:5.1f}% of the first")
    print()
    print("Shared bytes are what deduplication can save. Visual similarity is not shared bytes."
          if worst < 5 else "There is real sharing here; deduplication would save something.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
