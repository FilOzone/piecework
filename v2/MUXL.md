# MUXL in Takes

Why a take's segments are identified the way they are, what MUXL changes, and what it does not.

Status: integrated and measured, 10 November 2026. Segments are stored in MUXL canonical form and
the reuse index keys on those bytes.

## The problem it solves

A take reuses a segment when the bytes it just produced are already a piece in the data set,
matched by hash (`poc/jobs/video-gen/generate.py`). That works, and it is measured rather than
assumed: see the tables in [README.md](README.md).

What it rests on is narrower than it looks. The hash is taken over whatever ffmpeg happened to
write, so two segments match only when the same ffmpeg build, on the same platform, made the same
decisions about how to lay the file out. The frames can be identical while the file is not: muxers
differ in atom ordering, timestamp bases, chunk layout and metadata, and so do versions of one
muxer. Today's reuse is therefore stable by observation, not by construction, and it is stable only
on this machine.

MUXL makes the container canonical, so the identifier is something anyone can recompute from the
same frames with a different tool.

## Why not IPLD on its own

This is the obvious question and the answer is in the measurement. Content-defined chunking *is*
the IPLD/UnixFS approach, and across two H.264 versions of one video where half the frames are
identical by construction it found **0.0%** sharing, as did fixed 4 KB and 1 KB blocks. IPLD
addresses bytes. It does not make two encodings of the same video *into* the same bytes, and no
chunker can recover sharing that is not there.

MUXL is not an alternative to IPLD, it is built on it:

- its catalog box carries a **DRISL** payload, which is deterministic dag-cbor, i.e. IPLD;
- its identifiers are **DASL CIDs**, which that spec defines as a strict subset of IPFS CIDs.

## What MUXL specifies

From <https://dasl.ing/muxl.html> ("Media Uniform eXact Layout", status *Stabilising*):

- A fragment is one `moof` followed by one `mdat`, carrying **exactly one sample**.
- `moof` holds one `mfhd` and one `traf`; `traf` holds exactly `tfhd`, `tfdt`, `trun`.
  `tfhd` sets `flags = 0x020000` (default-base-is-moof) and no default sample values.
  `tfdt.base_media_decode_time` is the sample's absolute decode time in the track timescale.
- A segment begins with a `uuid` box, identifier `e6404ea2-8f01-4305-98da-7bec3c2a9173`, whose body
  is a DRISL catalog and nothing else. A canonical segment is single-track.
- Segment boundaries fall at every video sync sample. Audio-only streams cut at 1-second spans.
- `ftyp` major brand `muxl`, compatible brands `[muxl, isom, iso2]`.
- The flat-MP4 presentation is `ftyp` + `moov` with populated sample tables, `co64` offsets, and one
  outer `mdat` always in the 64-bit `largesize` form, whose payload is the canonical segment stream
  verbatim.
- Segments are freely concatenatable by appending bytes.

Identifiers, from <https://dasl.ing/cid.html> and <https://dasl.ing/bdasl.html>: a DASL CID is 36
bytes, `0x01` version, `0x55` raw or `0x71` DRISL, `0x12` SHA-256, `0x20` length, then a 32-byte
digest; as a string it is base32 lowercase behind a `b` multibase prefix. BDASL additionally permits
BLAKE3 as hash type `0x1e`.

## What MUXL does not fix

**Encoder variance.** MUXL standardises how frames are packaged, not how they are produced. The
A4000 does not produce identical frames across runs, so a GPU take has nothing to match however
canonical the container is. Two non-deterministic encodes of one prompt share no bytes.

This is not hypothetical for Takes: segment mode currently **refuses** the model generator
outright, because a fixed-length clip has no per-picture boundary to cut at. So the storage saving
exists on the processor generator only, and adopting MUXL does not change that. Whether segmented
takes should work with the model generator is a design question, not an integration one.

## Risks carried from upstream

The reference implementation is <https://github.com/streamplace/muxl>, Rust, built from source at
`f1722eda15e016f31439639cd8d24c1abf9d4e49` (v0.3.6, 9 October 2026). It is not published to
crates.io or npm and ships no release binaries, so the pin above is the only version statement.

Three things are open in their own repo and we inherit all three:

- `spec/known-bugs.md`: `tkhd` flags emitted as `0x01` where the spec says `0x03`, which their note
  says could make a strict player skip the track. **This does not reproduce on the `--flat` path at
  v0.3.6**: a canonical segment of ours parses as `tkhd flags: 0x000003`, with `ftyp` major brand
  `muxl` and compatible brands `muxl, isom`. Playback was checked rather than assumed, in a real
  browser over HTTP: `readyState` 4, duration 2.0s, 512x512, no error, playback advanced to 0.86s.
  Their note may be stale, or may apply to the fMP4 init path we do not use.
- `spec/open-questions.md` lists *mfhd sequence number determinism* and *content hashing details*
  as unresolved. The second is the one that matters here: it is the identifier we would be keying
  reuse on.
- The spec is `Stabilising` at v0.3.x. A canonical form that changes is a reuse index that
  invalidates, so the pin is deliberate and bumping it means re-measuring.

## Integration

1. `poc/jobs/video-gen/Dockerfile` gains a build stage that compiles `muxl` from the pinned tag and
   copies the binary in. The job still runs with `--network none`.
2. `canonicalise()` in `generate.py` runs `muxl segment <seg> --flat` on each encoded segment and
   `muxl cid --segments` on the result. **The canonical file is what gets stored**, so the piece in
   the data set is the one any MUXL implementation would produce from those frames.
3. The reuse index keys on `sha256` of the canonical bytes, not on the MUXL CID. Deliberate:
   `content hashing details` is still open upstream, and keying on a rule that may change would
   invalidate the index. The CID is recorded in the manifest as `muxlCid` beside `sha256`, so it is
   available without being load-bearing. `canonical: true|false` marks each segment, and
   `storage.canonicalForm` is `muxl`, `mixed` or `none` for the take.
4. If `muxl` is missing or refuses, the raw bytes are stored and `canonical` is false. A paid job
   delivering a less portable identifier beats a paid job delivering nothing, and the manifest says
   which happened rather than hiding it.

### What the integration buys, measured

The claim is that a segment's identity stops depending on which tool packaged it. Tested by taking
a stored canonical segment and repackaging the same frames two ways with ffmpeg (`+faststart`, and
`frag_keyframe+empty_moov`):

| file | bytes | sha256 | canonicalises to |
|---|---|---|---|
| stored piece | 21,063 | `2038f878…` | `2038f878…` |
| repackaged A | 18,133 | `459ebe75…` | `2038f878…` |
| repackaged B | 18,164 | `375a873a…` | `2038f878…` |

Three different files, one canonical form, one CID
(`bafkr4ice3ddedr67m3cpagmrqw2ahwfiywu5yvnidnllwiuojimlf6xddm`). Canonicalising the stored piece is
a no-op, so the operation is idempotent. Before this, the first column is what the reuse index saw,
and the same video arriving from a different muxer would have been stored again.

Reuse itself is unchanged by the switch, which is the point. Re-run end to end on Calibration as
paid jobs, data set #52386, jobs #40 and #41: three pictures give 0% with nothing matched and 5
pieces delivered; adding a fourth gives 3 of 4 matched, **75% of the bytes free**, and 3 pieces
delivered rather than 6. Every segment is marked `canonical: true` with `canonicalForm: muxl`, and
each carries its own `muxlCid`.
