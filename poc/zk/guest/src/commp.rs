//! Filecoin piece commitment, as the guest must compute it.
//!
//! NEVER COMPILED, NEVER CHECKED AGAINST A REAL PIECE. See ../../README.md — validating this against
//! PDPVerifier.getPieceCid for a piece that already exists is the first thing anyone should do, because a
//! commitment that is one byte wrong is a commitment to nothing and the failure looks like a broken prover.
//!
//! Two steps, both from the spec rather than from a working implementation:
//!
//! 1. fr32 padding. The tree is built over BLS12-381 field elements, which hold 254 usable bits, so the
//!    bytes are repacked: every 127 bytes of input become 128 bytes, with two zero bits inserted after each
//!    254 bits. This is why a piece's padded size is 128/127 of its real size.
//!
//! 2. A binary merkle tree over 32-byte leaves, where the parent of two nodes is sha256 of their
//!    concatenation with the top two bits of the last byte cleared (sha256-trunc254). Leaves are padded out
//!    with zero nodes to the next power of two.
//!
//! In the zkVM the sha256 compressions dominate: one per 64 bytes of padded data for the leaves, plus one
//! per internal node. SP1's sha256 precompile is what makes this tolerable rather than absurd.

use sha2::{Digest, Sha256};

const NODE: usize = 32;

/// Clear the top two bits of the last byte: the truncation that keeps a digest inside the field.
fn trunc254(mut d: [u8; NODE]) -> [u8; NODE] {
    d[NODE - 1] &= 0b0011_1111;
    d
}

fn hash_pair(l: &[u8; NODE], r: &[u8; NODE]) -> [u8; NODE] {
    let mut h = Sha256::new();
    h.update(l);
    h.update(r);
    let out: [u8; NODE] = h.finalize().into();
    trunc254(out)
}

/// Repack `src` so that every 127 bytes become 128, two zero bits inserted every 254.
///
/// Written for clarity rather than speed; a real implementation works on 127-byte blocks with shifts. If
/// this is the slow part in-circuit, that is where to look first.
pub fn fr32_pad(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len() * 128 / 127 + 128);
    let mut acc: u64 = 0;   // bit accumulator
    let mut bits: u32 = 0;  // how many bits are in it
    let mut since = 0u32;   // bits emitted since the last pad
    let mut cur: u8 = 0;
    let mut cur_bits: u32 = 0;

    let mut push_bit = |b: u8, out: &mut Vec<u8>, cur: &mut u8, cur_bits: &mut u32| {
        *cur |= b << *cur_bits;
        *cur_bits += 1;
        if *cur_bits == 8 {
            out.push(*cur);
            *cur = 0;
            *cur_bits = 0;
        }
    };

    for &byte in src {
        acc |= (byte as u64) << bits;
        bits += 8;
        while bits > 0 {
            let b = (acc & 1) as u8;
            acc >>= 1;
            bits -= 1;
            push_bit(b, &mut out, &mut cur, &mut cur_bits);
            since += 1;
            if since == 254 {
                push_bit(0, &mut out, &mut cur, &mut cur_bits);
                push_bit(0, &mut out, &mut cur, &mut cur_bits);
                since = 0;
            }
        }
    }
    while cur_bits != 0 {
        push_bit(0, &mut out, &mut cur, &mut cur_bits);
    }
    // The tree needs a whole number of 32-byte leaves.
    while out.len() % NODE != 0 {
        out.push(0);
    }
    out
}

/// The merkle root over the padded bytes: the piece commitment itself, before any CID wrapping.
pub fn commp_root(padded: &[u8]) -> [u8; NODE] {
    assert!(padded.len() % NODE == 0, "padded data must be whole nodes");
    let mut level: Vec<[u8; NODE]> = padded
        .chunks(NODE)
        .map(|c| {
            let mut n = [0u8; NODE];
            n.copy_from_slice(c);
            n
        })
        .collect();
    if level.is_empty() {
        return [0u8; NODE];
    }
    // Zero-pad to a power of two, as an unpadded tree has no defined root.
    let mut width = 1usize;
    while width < level.len() {
        width <<= 1;
    }
    level.resize(width, [0u8; NODE]);

    while level.len() > 1 {
        level = level
            .chunks(2)
            .map(|p| hash_pair(&p[0], &p[1]))
            .collect();
    }
    level[0]
}

/// The CID bytes as PDPVerifier stores them, which is what the on-chain commitment is taken over.
///
/// THIS IS THE PART MOST LIKELY TO BE WRONG. The POC's pieces are PieceCID v2 (`bafkzcib…`): codec raw
/// (0x55) and multihash fr32-sha256-trunc254-padbintree (0x1011), whose digest carries the tree height and
/// the real data length alongside the root. The layout below is a reading of the spec, not a transcription
/// of a working encoder, and it must be checked against a piece that already exists before it is believed.
pub fn piece_cid_v2(root: &[u8; NODE], unpadded_len: u64, height: u8) -> Vec<u8> {
    let mut cid = Vec::with_capacity(48);
    cid.push(0x01); // CIDv1
    cid.push(0x55); // raw
    // multihash code 0x1011 as an unsigned varint
    cid.extend_from_slice(&[0x91, 0x20]);
    let digest_len = 1 + 8 + NODE;
    cid.push(digest_len as u8);
    cid.push(height);
    cid.extend_from_slice(&unpadded_len.to_le_bytes());
    cid.extend_from_slice(root);
    cid
}

/// Height of the tree built over `unpadded_len` bytes of real data.
pub fn tree_height(unpadded_len: u64) -> u8 {
    let padded = unpadded_len * 128 / 127;
    let mut leaves = (padded + NODE as u64 - 1) / NODE as u64;
    if leaves == 0 {
        leaves = 1;
    }
    let mut h = 0u8;
    let mut w = 1u64;
    while w < leaves {
        w <<= 1;
        h += 1;
    }
    h
}

/// Everything together: bytes in, the CID bytes the chain would see out.
pub fn piece_cid(bytes: &[u8]) -> Vec<u8> {
    let padded = fr32_pad(bytes);
    let root = commp_root(&padded);
    piece_cid_v2(&root, bytes.len() as u64, tree_height(bytes.len() as u64))
}
