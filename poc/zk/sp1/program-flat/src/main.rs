//! The attested guest: the same job, with the cheap binding.
//!
//! It reads the client's pieces, does the job, and commits:
//!
//!   inputCommitment  = keccak256(sha256(piece_1) || sha256(piece_2) || ...)
//!   outputCommitment = keccak256(cid(output))
//!
//! The input side is a flat sha256 instead of a Filecoin piece CID: one linear pass, no fr32 padding
//! beneath it and no merkle tree above. That is the whole difference between this guest and `program`.
//!
//! Measured on the same inputs: this guest costs 24 cycles a byte against 99 for the bound one, so four
//! times less rather than the eight first estimated. The binding alone is 12.5 against 87, but counting
//! the term costs about 11.6 a byte and is paid by both — invisible at 99, half the bill at 24. Worth
//! knowing before optimising this further: the next win here is the job, not the hash.
//!
//! What it gives up: `ComputeService` derives its `inputCommitment` from the CIDs PDP holds, and there is
//! no on-chain path from a piece CID to a sha256 of the raw bytes, so the chain cannot check this value
//! against anything. `SP1UnboundVerifier` therefore does not try — it checks the proof and the output, and
//! takes the input digests as the provider's claim, recorded in the delivering transaction. A client who
//! wants the chain to enforce which bytes were read orders the bound job instead and pays more for it.
//!
//! The output commitment is unchanged, still a real piece CID: the output is a few hundred bytes, so
//! binding the delivered result costs nothing worth saving.
#![no_main]
sp1_zkvm::entrypoint!(main);

use piecework_lib::{commit_cids, count_occurrences, keccak, piece_cid, report_attested, sha256_digest};

pub fn main() {
    let n: u32 = sp1_zkvm::io::read();
    let term: Vec<u8> = sp1_zkvm::io::read_vec();

    let mut digests: Vec<Vec<u8>> = Vec::with_capacity(n as usize);
    let mut total: u64 = 0;
    for _ in 0..n {
        let bytes = sp1_zkvm::io::read_vec();
        total += count_occurrences(&bytes, &term);
        digests.push(sha256_digest(&bytes));
    }
    // Same shape as the bound guest's commitment, so the journal is still two bytes32 and the adapter is a
    // near-copy. Order still matters: a job over (a, b) is not a job over (b, a).
    let input_commitment = commit_cids(&digests);

    // The digests go in the delivered file as well as the journal. On chain they are only in the
    // transaction's calldata, and a client holding the result should not have to decode a transaction to
    // learn what was claimed about its data.
    let out = report_attested(core::str::from_utf8(&term).unwrap_or("?"), total, n as usize, &digests);
    let output_commitment = keccak(&piece_cid(out.as_bytes()));

    let mut journal = Vec::with_capacity(64);
    journal.extend_from_slice(&input_commitment);
    journal.extend_from_slice(&output_commitment);
    sp1_zkvm::io::commit_slice(&journal);
}
