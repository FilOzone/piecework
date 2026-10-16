# Proving over a slice

How to prove a computation over part of a large piece without paying to re-derive the whole piece, and
why the result is a stronger claim than proving over a blob the prover chose.

Not built. This is the design and the reasoning; the measurements it rests on are real.

## The problem

Deriving a piece CID inside the zkVM costs **227 cycles per byte** and does not amortise — measured flat
from 128 B to 1 MB. Proving is bounded by memory long before time: on a 23.4 GiB machine the ceiling is
between 16 KB and 32 KB of input, and on a 500 GB provider box 64 KB completes at 55.5 GiB while 256 KB
exceeds 84.

So today a proved job reads **kilobytes**. A real piece is megabytes, and the cap is 1.07 GB.

For comparison, a published SP1 run over Uniswap data proved a **5.4 MB** slice in 59.5M cycles — about 11
cycles per byte, because its guest hashes the input with `sha256` and nothing more. Ours costs twenty times
that per byte, and the difference is entirely the binding: fr32 padding and a sha256 merkle tree, rather
than one linear pass.

That binding is the point and should not be given up. It is what makes the proof say *this computation ran
over the data the client pays to store* rather than *over some bytes the prover had to hand*. The fix is to
stop paying for it on every byte.

## The mechanism

A Filecoin piece CID is a merkle root with a header:

    CIDv1 | raw(0x55) | varint(0x1011) | len | varint(padding) | height | root

The root is the top of a sha256 binary tree over the fr32-padded leaves. Which means a slice of the piece
can be proved to belong to it with an ordinary merkle inclusion path: `log2(leaves)` sibling hashes, each
32 bytes.

So the guest is given:

- the **slice** it is to compute over, and its offset
- the piece's **root, height and padding** — everything else in the CID header
- the **inclusion path** from the slice's leaves up to that root

It verifies the path, rebuilds the piece CID from the root it just confirmed, and commits
`keccak(cid)` exactly as now.

Cost goes from `O(piece)` to `O(slice) + O(log piece)`. A 1 GB piece is 33 million leaves, so the path is
25 hashes — about 25 compressions against the 33 million the full derivation needs.

## Why the prover cannot cheat by supplying a false root

This is the part worth checking carefully, because the guest is *given* the root rather than deriving it,
and a prover supplies its own inputs.

It does not matter. `ComputeService` does not take the guest's word for anything: it computes
`inputCommitment` itself, from the piece ids the job named, by reading each piece's CID from
`PDPVerifier.getPieceCid`. The proof is only accepted if the journal's commitment equals the contract's.

So a prover who invents a root produces a CID that is not the stored piece's, which hashes to a commitment
that is not the one the contract derived, and the verifier refuses before it even looks at the proof — the
same path `test_Z2` already exercises, where a perfectly valid proof is rejected for committing to the
wrong inputs.

The root is therefore pinned by the chain, not by the guest. The guest only has to prove that the slice it
read really hangs beneath it.

**No contract change.** `inputCommitment` stays keccak over whole-piece CIDs, and `SP1ComputeVerifier` is
untouched. What changes is only what the guest is handed and what it checks.

## What the client is claiming, and how that differs

With a slice, the claim becomes: *this result was computed over bytes at offset N of the piece whose CID is
C, which the client pays to store and which PDP shows is still held.*

Compare the alternative that costs 11 cycles a byte: *this result was computed over bytes whose sha256 is
H.* Nothing connects H to anything stored. A provider could compute honestly over last week's data, or over
a file it made up, and the proof would verify. Payment there rests on the provider reporting its own work
honestly, with a spending cap as the client's protection.

The difference is not a refinement. One is an audit trail; the other is a condition on payment that the
chain enforces. Slicing is what lets us have the second at the first's input sizes.

The offset and length must be in the journal too, or the claim weakens to "somewhere in that piece", which
is not what a client asking about a particular day's rows means.

## What it would take

- **Guest**: verify an inclusion path, rebuild the CID header around the confirmed root. The hash is
  already there — `commp.rs` builds the same tree. Perhaps fifty lines.
- **Host**: build the path. It has the whole piece, so this is a tree walk.
- **Journal**: extend to carry offset and length. `SP1ComputeVerifier` decodes two `bytes32` from
  `publicValues`, so adding fields means touching the adapter after all — the one place this is not free.
  Worth doing deliberately rather than smuggling the offset into an existing field.
- **Catalogue**: a sliced job is a different program, so a different verification key.

## What this does not fix

Proving still costs about ten minutes whatever the input, because the Groth16 wrap dominates below 16 KB
and is largely fixed. Slicing raises the ceiling on *how much data a proof can be about*; it does not make
proofs quick. A client wanting an answer in seconds wants an unproved job.

And the memory wall moves rather than disappears: a 64 KB slice still costs what 64 KB costs today.
Slicing means the piece can be a gigabyte while the slice stays within reach — it does not widen the slice.
