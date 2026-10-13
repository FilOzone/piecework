//! The guest: what runs inside the zkVM and what it swears to.
//!
//! NEVER COMPILED. See ../../README.md.
//!
//! It reads the input pieces, derives each one's Filecoin CID, does the job, derives the CID of the output
//! it produced, and commits two values to the journal:
//!
//!   inputCommitment  = keccak256(cid(piece_1) || cid(piece_2) || ...)
//!   outputCommitment = keccak256(cid(output))
//!
//! Those are exactly what ComputeService computes on chain from the pieces it knows about, and
//! SP1ComputeVerifier refuses to look at the proof until they match. The expensive CID derivation is
//! therefore not optional and not a nicety: it is the only thing standing between "a computation happened"
//! and "the computation happened over the client's data".
//!
//! The order of the inputs is part of the commitment. The host must feed them in the same order the client
//! listed them when posting the job, and the chain iterates inputPieceIds in that order.

#![no_main]
sp1_zkvm::entrypoint!(main);

// commp now lives in ../lib, where it can be tested outside the zkVM. See that crate's README.

use piecework_lib::{commit_pieces, count_occurrences, keccak, piece_cid, report};
use alloy_sol_types::SolType;
use tiny_keccak::{Hasher, Keccak};

/// The journal, abi-encoded so a Solidity contract can read it with one abi.decode.
type Journal = alloy_sol_types::sol_data::FixedArray<alloy_sol_types::sol_data::FixedBytes<32>, 2>;

fn keccak(data: &[u8]) -> [u8; 32] {
    let mut k = Keccak::v256();
    let mut out = [0u8; 32];
    k.update(data);
    k.finalize(&mut out);
    out
}

pub fn main() {
    // How many pieces, then each piece's bytes. The host writes them; the guest trusts nothing about them
    // except that it will hash whatever it is given — which is the point, since the hash is what gets
    // checked against the chain.
    let n: u32 = sp1_zkvm::io::read();

    let mut cid_concat: Vec<u8> = Vec::new();
    let mut corpus: Vec<Vec<u8>> = Vec::with_capacity(n as usize);
    for _ in 0..n {
        let bytes: Vec<u8> = sp1_zkvm::io::read_vec();
        cid_concat.extend_from_slice(&commp::piece_cid(&bytes));
        corpus.push(bytes);
    }
    let input_commitment = keccak(&cid_concat);

    // The job. Deliberately trivial: count occurrences of a term across the inputs. The binding above is
    // what is being demonstrated; the work itself could be anything that fits in a zkVM, which rules out
    // most of what this POC actually runs.
    let term: Vec<u8> = sp1_zkvm::io::read_vec();
    let mut total: u64 = 0;
    for doc in &corpus {
        total += count_occurrences(doc, &term);
    }

    // The output is a file, because that is what the provider stores as a piece and what the contract sees
    // arriving in the data set. Its bytes must be byte-identical to what the provider writes, or the output
    // commitment will not match and the proof will be refused.
    let output = format!(
        "term: {}\noccurrences: {}\npieces: {}\n",
        String::from_utf8_lossy(&term),
        total,
        n
    );
    let output_commitment = keccak(&commp::piece_cid(output.as_bytes()));

    // The provider needs the exact bytes to store; they are not secret and not part of the journal.
    sp1_zkvm::io::commit_slice(&Journal::abi_encode(&[input_commitment, output_commitment]));
}

/// Overlapping occurrences are not counted twice; a naive scan is fine at this size.
fn count_occurrences(haystack: &[u8], needle: &[u8]) -> u64 {
    if needle.is_empty() || haystack.len() < needle.len() {
        return 0;
    }
    let mut n = 0u64;
    let mut i = 0usize;
    while i + needle.len() <= haystack.len() {
        if &haystack[i..i + needle.len()] == needle {
            n += 1;
            i += needle.len();
        } else {
            i += 1;
        }
    }
    n
}
