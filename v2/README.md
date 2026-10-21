# FOC Compute V2

V1 is the general thing: a storage provider sells compute over data it already holds, paid through
Filecoin Pay, with 21 jobs and two levels of proof. It is in `poc/` and it is not changed by anything here.

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

This was measured on this job's own mp4v output, not on a real generator's. Run it on real output before
concluding anything about a real product — but the mechanism is the codec, not the tool, so expect the
same answer.
