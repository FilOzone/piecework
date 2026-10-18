//! The block-wise fr32 padding against the bit-wise one it replaced.
//!
//! The fast path in `fr32_pad` claims to be the same transform as walking the input a bit at a time.
//! If it is not, every piece CID derived in the guest is wrong — which would show up as a proof the
//! contract refuses for committing to the wrong inputs, indistinguishable from a forgery attempt.
//! So the old implementation is kept here as the definition and the two are compared directly.

use piecework_lib::fr32_pad;

/// The original, bit at a time. Not fast, and not meant to be: this is the reference.
fn reference(src: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut cur: u8 = 0;
    let mut cur_bits: u32 = 0;
    let mut since: u32 = 0;

    let push = |bit: u8, out: &mut Vec<u8>, cur: &mut u8, cur_bits: &mut u32| {
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
    while out.len() % 32 != 0 {
        out.push(0);
    }
    out
}

/// Deterministic, so a failure is reproducible without carrying a fixture around.
fn fill(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

#[test]
fn fr32_matches_bitwise() {
    // Every length up to three blocks catches off-by-one at a block edge; the larger ones catch an
    // error that only appears once the fast path has run several times.
    let lengths: Vec<usize> = (0..=400)
        .chain([507, 508, 509, 1016, 1024, 4095, 4096, 8191])
        .collect();
    for len in lengths {
        for seed in [1u64, 0x9e3779b97f4a7c15, 0xdead_beef] {
            let src = fill(len, seed);
            assert_eq!(
                fr32_pad(&src),
                reference(&src),
                "fr32 differs from the bit-wise reference at len {len}, seed {seed:#x}"
            );
        }
        // All-ones is the case where the two inserted zero bits actually change a byte: with random
        // data a missing mask is invisible about three times in four.
        let src = vec![0xffu8; len];
        assert_eq!(fr32_pad(&src), reference(&src), "fr32 differs on all-ones at len {len}");
    }
}

#[test]
fn padding_bits_are_zero() {
    // Independently of the reference: the top two bits of every 32-byte node are the inserted zeros.
    // 254 bits of data per node is what makes the output a sequence of valid field elements, which is
    // the whole reason fr32 exists.
    let out = fr32_pad(&vec![0xffu8; 1270]);
    assert_eq!(out.len() % 32, 0);
    for (n, node) in out.chunks(32).enumerate() {
        assert_eq!(node[31] & 0xc0, 0, "node {n} has data in its padding bits");
    }
}
