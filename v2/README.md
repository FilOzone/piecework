# FOC Compute V2

V1 is the general thing: a storage provider sells compute over data it already holds, paid through
Filecoin Pay, with 18 jobs (28 images counting the GPU variants) and two levels of proof. It is in
`poc/` and it is not changed by anything here.

V2 is one application on top of it: **iterative video generation**. Upload images, generate a video, look
at it, generate the next version on top of the last, and keep every version — in one data set, on one
chain, with each version naming its parent.

## Why it is here and not in its own repository

It needs ComputeService, Filecoin Pay, the provider kit, the data set model and the browser client
unchanged. What is actually new is one job and one manifest. A separate repository would mean duplicating
every contract fix, key change and client fix by hand; the week of 13 October alone produced about fifteen.

    poc/                   V1, untouched
    poc/jobs/video-gen/    the job
    v2/                    this: the measurements and the notes that are not V1's business

## What is distinctive, and what is not

Generating video is something a hundred services do, and this one does it worse than all of them. What
none of them can do is tell you afterwards, and provably, that version 7 came from these images and this
prompt and was built on version 6 — because the inputs, the outputs and the payment are in one data set on
one chain, and `version-N.json` names every input by its sha256. Anyone holding the pieces can check it
without trusting the provider or us.

So the loop is the product, not the picture. The generator is pluggable and the first one is deliberately
not a model: `GENERATOR=motion` renders real video from the client's own images in seconds on a processor,
which let the whole cycle be built before any GPU was free.

## measure-dedup.py

    python3 v2/measure-dedup.py a.mp4 b.mp4

Answers whether successive versions of a video share bytes, which is what storage deduplication can
actually save. First result, on two versions from this repo's own job where **half the frames are identical
by construction**:

| chunking | shared |
|---|---|
| fixed 4 KB blocks | **0.0%** |
| fixed 1 KB blocks | **0.0%** |
| content-defined, ~2 KB | **0.0%** |

Visual similarity is not shared bytes. Re-encoding changes essentially every byte, and most frames are
stored as differences from their neighbours rather than as themselves.

Re-measured on H.264 (`avc1`) output on 6 November 2026, because the first run was on mp4v and the codec
was the suspected cause rather than the tool. Same pair, half the frames identical by construction
(`version-1.mp4` 47,932 bytes and `version-2.mp4` 96,236 bytes from jobs 23 and 24 on Calibration):

| chunking | shared |
|---|---|
| fixed 4 KB blocks | **0.0%** |
| fixed 1 KB blocks | **0.0%** |
| content-defined, ~2 KB | **0.0%** |

So the answer does not depend on the codec, and chunking after the fact cannot find the sharing.

## What did work: segments, reused by content

The sharing has to be built in at the boundary between what changed and what did not, which is what
`SEGMENTS=1` does: one piece per source picture, each one a pure function of that picture, the prompt and
the client's seed. A segment is then reused only when the bytes this run produced are already a piece in
the data set, matched by sha256, so the saving is a measurement and not a property of how the take was
assembled.

Measured end to end on Calibration against the provider on this machine, data set #50990, jobs #37, #38
and #39, each ordered and paid:

| take | pictures | segments | written | reused | of the bytes | output pieces delivered |
|---|---|---|---|---|---|---|
| 1 | 3 | 3 | 3 | 0 | **0%** | 5 |
| 2 | 4 (one added) | 4 | 1 | 3 | **74%** | 3 |
| 3 | 4 (unchanged) | 4 | 0 | 4 | **100%** | 2 |

The delivered-piece count is the check that matters: take 3 wrote no video at all, only its manifest and
report, because every segment it produced was already stored. The control, run locally rather than on chain: the same four
pictures with a different prompt returns to 0% and writes all four segments again, which is what makes
the number worth quoting at all. It can go to zero.

Segments are stored in **MUXL canonical form** since 10 November 2026, so the identifier comes from the
frames and not from the tool that packaged them: three containers of the same frames, with three different
sha256s, canonicalise to one set of bytes and one CID. Details and the measurement are in
[MUXL.md](MUXL.md).

One limit remains and MUXL does not touch it. The *encoder* still has to be deterministic, which it is on
a processor and is not on the A4000, and segment mode refuses the model generator outright, so the saving
is a processor-generator property today. MUXL standardises packaging, not encoding; two non-deterministic
encodes of one prompt share nothing to match however canonical the container is.
