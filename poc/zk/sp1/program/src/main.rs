//! The guest: what runs inside the zkVM, and what it swears to.
//!
//! It reads the client's pieces, derives each one's Filecoin CID from the bytes it was handed, does the job,
//! derives the CID of the output it produced, and commits two values:
//!
//!   inputCommitment  = keccak256(cid(piece_1) || cid(piece_2) || ...)
//!   outputCommitment = keccak256(cid(output))
//!
//! Those are exactly what ComputeService computes on chain from piece ids it already holds, and
//! SP1ComputeVerifier refuses to look at the proof until they match. Deriving the CIDs is most of the cost
//! and all of the point: a journal committing a hash of bytes the prover chose would prove a computation
//! happened, not that it happened over the data the client pays to store.
#![no_main]
sp1_zkvm::entrypoint!(main);

use piecework_lib::{commit_cids, count_occurrences, keccak, piece_cid, report};

pub fn main() {
    let n: u32 = sp1_zkvm::io::read();
    let term: Vec<u8> = sp1_zkvm::io::read_vec();

    let mut cids: Vec<Vec<u8>> = Vec::with_capacity(n as usize);
    let mut total: u64 = 0;
    for _ in 0..n {
        let bytes = sp1_zkvm::io::read_vec();
        total += count_occurrences(&bytes, &term);
        cids.push(piece_cid(&bytes));
    }
    let input_commitment = commit_cids(&cids);

    // The output bytes must be byte-identical to what the provider stores as a piece, or its CID differs and
    // the contract refuses the proof.
    let out = report(core::str::from_utf8(&term).unwrap_or("?"), total, n as usize);
    let output_commitment = keccak(&piece_cid(out.as_bytes()));

    let mut journal = Vec::with_capacity(64);
    journal.extend_from_slice(&input_commitment);
    journal.extend_from_slice(&output_commitment);
    sp1_zkvm::io::commit_slice(&journal);
}
