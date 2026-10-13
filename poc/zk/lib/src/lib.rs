//! The part of the job that has to run identically inside the zkVM and outside it.
//!
//! Keeping the piece-CID derivation here rather than in the guest is not tidiness. It is the only way to
//! check it: inside the zkVM it can only be observed through a proof, while here it can be run against a file
//! that is already stored on Calibration and compared with what PDPVerifier returns for it. If those disagree
//! by a byte, every proof the guest ever produces is refused, and the symptom looks like a broken prover.

use sha2::{Digest, Sha256};
use tiny_keccak::{Hasher, Keccak};

const NODE: usize = 32;

// ---------------------------------------------------------------- piece commitment

/// Clear the top two bits of the last byte: the truncation that keeps a digest inside the field.
fn trunc254(mut d: [u8; NODE]) -> [u8; NODE] {
    d[NODE - 1] &= 0b0011_1111;
    d
}

fn hash_pair(l: &[u8; NODE], r: &[u8; NODE]) -> [u8; NODE] {
    let mut h = Sha256::new();
    h.update(l);
    h.update(r);
    trunc254(h.finalize().into())
}

/// Repack so that every 127 bytes become 128: two zero bits inserted after each 254 bits, because the tree is
/// built over field elements that hold 254 usable bits.
pub fn fr32_pad(src: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(src.len() * 128 / 127 + 128);
    let mut cur: u8 = 0;
    let mut cur_bits: u32 = 0;
    let mut since: u32 = 0;

    let mut push = |bit: u8, out: &mut Vec<u8>, cur: &mut u8, cur_bits: &mut u32| {
        *cur |= bit << *cur_bits;
        *cur_bits += 1;
        if *cur_bits == 8 {
            out.push(*cur);
            *cur = 0;
            *cur_bits = 0;
        }
    };

    for &byte in src {
        for i in 0..8 {
            push((byte >> i) & 1, &mut out, &mut cur, &mut cur_bits);
            since += 1;
            if since == 254 {
                push(0, &mut out, &mut cur, &mut cur_bits);
                push(0, &mut out, &mut cur, &mut cur_bits);
                since = 0;
            }
        }
    }
    if cur_bits != 0 {
        out.push(cur);
    }
    while out.len() % NODE != 0 {
        out.push(0);
    }
    out
}

/// The merkle root over the padded bytes, zero-padded to a power of two.
pub fn commp_root(padded: &[u8], height: u8) -> [u8; NODE] {
    let mut level: Vec<[u8; NODE]> = padded
        .chunks(NODE)
        .map(|c| {
            let mut n = [0u8; NODE];
            n[..c.len()].copy_from_slice(c);
            n
        })
        .collect();
    level.resize(1usize << height, [0u8; NODE]);
    while level.len() > 1 {
        level = level.chunks(2).map(|p| hash_pair(&p[0], &p[1])).collect();
    }
    level[0]
}

/// Unsigned LEB128, as multiformats uses.
fn varint(mut n: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let b = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(b);
            return out;
        }
        out.push(b | 0x80);
    }
}

/// Height of the tree over this many real bytes.
pub fn tree_height(unpadded_len: u64) -> u8 {
    let padded = unpadded_len.div_ceil(127) * 128;
    let leaves = padded.div_ceil(NODE as u64).max(1);
    let mut h = 0u8;
    while (1u64 << h) < leaves {
        h += 1;
    }
    h
}

/// The CID bytes PDPVerifier stores, which is what the on-chain commitment is taken over:
///
///   CIDv1 (0x01) | raw (0x55) | varint(0x1011) | digest length | varint(padding) | height | root
///
/// where padding is the unpadded capacity at that height minus the payload length.
pub fn piece_cid(bytes: &[u8]) -> Vec<u8> {
    let height = tree_height(bytes.len() as u64);
    let root = commp_root(&fr32_pad(bytes), height);
    let capacity_unpadded = ((NODE as u64) << height) / 128 * 127;
    let padding = capacity_unpadded.saturating_sub(bytes.len() as u64);

    let mut digest = varint(padding);
    digest.push(height);
    digest.extend_from_slice(&root);

    let mut cid = Vec::with_capacity(digest.len() + 5);
    cid.push(0x01);
    cid.push(0x55);
    cid.extend_from_slice(&varint(0x1011));
    cid.push(digest.len() as u8);
    cid.extend_from_slice(&digest);
    cid
}

// ---------------------------------------------------------------- the job

pub fn keccak(data: &[u8]) -> [u8; 32] {
    let mut k = Keccak::v256();
    let mut out = [0u8; 32];
    k.update(data);
    k.finalize(&mut out);
    out
}

/// keccak over the concatenated CIDs, in order. Order is part of the commitment: the chain iterates the
/// job's input piece ids in the order the client gave them.
pub fn commit_pieces(pieces: &[Vec<u8>]) -> [u8; 32] {
    commit_cids(&pieces.iter().map(|p| piece_cid(p)).collect::<Vec<_>>())
}

/// The same commitment, over CIDs that are already known. This is exactly what ComputeService does on chain:
/// concatenate each input piece's CID in the order the job listed them, then keccak256. abi.encodePacked of
/// bytes is the bytes, so there is nothing else in the preimage.
pub fn commit_cids(cids: &[Vec<u8>]) -> [u8; 32] {
    let mut acc = Vec::new();
    for c in cids { acc.extend_from_slice(c); }
    keccak(&acc)
}

/// Non-overlapping occurrences. The job is trivial on purpose; the binding is the expensive part.
pub fn count_occurrences(haystack: &[u8], needle: &[u8]) -> u64 {
    if needle.is_empty() || haystack.len() < needle.len() {
        return 0;
    }
    let (mut n, mut i) = (0u64, 0usize);
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

pub fn report(term: &str, total: u64, pieces: usize) -> String {
    format!("term: {term}\noccurrences: {total}\npieces: {pieces}\n")
}
