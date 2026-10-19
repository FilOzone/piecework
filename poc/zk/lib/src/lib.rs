//! The part of the job that has to run identically inside the zkVM and outside it.
//!
//! Keeping the piece-CID derivation here rather than in the guest is not tidiness. It is the only way to
//! check it: inside the zkVM it can only be observed through a proof, while here it can be run against a file
//! that is already stored on Calibration and compared with what PDPVerifier returns for it. If those disagree
//! by a byte, every proof the guest ever produces is refused, and the symptom looks like a broken prover.

use sha2::digest::generic_array::GenericArray;
use sha2::{Digest, Sha256};
use tiny_keccak::{Hasher, Keccak};

const NODE: usize = 32;

// ---------------------------------------------------------------- piece commitment

/// Clear the top two bits of the last byte: the truncation that keeps a digest inside the field.
fn trunc254(mut d: [u8; NODE]) -> [u8; NODE] {
    d[NODE - 1] &= 0b0011_1111;
    d
}

/// SHA-256 of a message that is always exactly 64 bytes, which makes both of its blocks known in
/// advance: the pair itself, then a padding block that is a constant.
///
/// Going through `Digest` instead costs about 2000 cycles a call in buffering machinery for a length
/// that never varies, and a 16 KB piece calls this 1023 times — which made the merkle tree, not the
/// hashing, the dominant cost of binding a proof to a piece.
fn hash_pair(l: &[u8; NODE], r: &[u8; NODE]) -> [u8; NODE] {
    const IV: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    // The 1 bit, zeros, then the message length in bits — 512 — as a big-endian u64.
    const PAD: [u8; 64] = {
        let mut p = [0u8; 64];
        p[0] = 0x80;
        p[62] = 0x02;
        p
    };

    let mut block = [0u8; 64];
    block[..NODE].copy_from_slice(l);
    block[NODE..].copy_from_slice(r);

    let mut state = IV;
    sha2::compress256(
        &mut state,
        &[*GenericArray::from_slice(&block), *GenericArray::from_slice(&PAD)],
    );

    let mut out = [0u8; NODE];
    for (i, w) in state.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&w.to_be_bytes());
    }
    trunc254(out)
}

/// Repack so that every 127 bytes become 128: two zero bits inserted after each 254 bits, because the tree is
/// built over field elements that hold 254 usable bits.
pub fn fr32_pad(src: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(src.len() * 128 / 127 + 128);
    let full = src.len() / 127;
    for b in 0..full {
        pad_block(&src[b * 127..(b + 1) * 127], &mut out);
    }
    // A 127-byte block ends on a whole output byte with no carry (1016 source bits + 8 inserted = 1024),
    // so the bit-wise tail starts from clean state and the two paths compose.
    pad_tail(&src[full * 127..], &mut out);
    while out.len() % NODE != 0 {
        out.push(0);
    }
    out
}

/// One 127-byte block, eight times cheaper than doing it a bit at a time.
///
/// 127 bytes is 1016 bits is exactly four 254-bit groups, so a whole block becomes four 32-byte nodes
/// with no carry between blocks. Node `k` begins at source bit `254k`, whose offset within a byte is
/// `254k mod 8` — 0, 6, 4, 2 — and that shift is the same for all 32 bytes of the node. So each output
/// byte is one shift-or of two neighbouring source bytes, rather than eight shift-mask-push steps.
///
/// Measured in the zkVM: the bit-wise version costs 115 cycles per byte, about half of the whole
/// piece-CID derivation. This is the same transform, not an approximation of it — `fr32_matches_bitwise`
/// holds it against the original over every length that can behave differently.
fn pad_block(src: &[u8], out: &mut Vec<u8>) {
    debug_assert_eq!(src.len(), 127);
    // 128th byte stays zero: node 3's last output byte reads one past the block, and the bits it takes
    // from there are inserted zeros, not data.
    let mut buf = [0u8; 128];
    buf[..127].copy_from_slice(src);

    let mut block = [0u8; 128];
    for k in 0..4usize {
        let s = (254 * k % 8) as u32;
        let base = 254 * k / 8;
        for j in 0..32usize {
            block[k * 32 + j] = if s == 0 {
                buf[base + j]
            } else {
                (buf[base + j] >> s) | (buf[base + j + 1] << (8 - s))
            };
        }
        // The top two bits of every node are the padding, so they are zero whatever landed there.
        block[k * 32 + 31] &= 0x3f;
    }
    out.extend_from_slice(&block);
}

/// The leftover under 127 bytes, done a bit at a time. This is the original implementation: short
/// enough not to matter for cost, and it is the definition the fast path is tested against.
fn pad_tail(src: &[u8], out: &mut Vec<u8>) {
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
            push((byte >> i) & 1, out, &mut cur, &mut cur_bits);
            since += 1;
            if since == 254 {
                push(0, out, &mut cur, &mut cur_bits);
                push(0, out, &mut cur, &mut cur_bits);
                since = 0;
            }
        }
    }
    if cur_bits != 0 {
        out.push(cur);
    }
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
/// A piece's bytes hashed flat, instead of reduced to its Filecoin CID.
///
/// This is the cheap binding: one linear pass, about 12.5 cycles a byte in the zkVM against 100 for
/// `piece_cid`, because it is 64 bytes per compression with no fr32 padding beneath it and no tree above.
///
/// What it saves it gives up in meaning. A digest of the bytes the prover was handed says nothing about the
/// piece the client pays to store, and no contract can check it against PDP — there is no on-chain path
/// from a piece CID to a sha256 of the raw data. Returned as a `Vec<u8>` so it drops into `commit_cids`
/// where a CID would go: the journal keeps its shape, and only the meaning of the first field changes.
/// `SP1UnboundVerifier` is the contract that accepts it, and says what that costs the client.
pub fn sha256_digest(bytes: &[u8]) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().to_vec()
}

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

/// The job's output, and the bytes the guest commits to.
///
/// It has to clear 127 bytes, which is the smallest piece a provider will store. The first version of this
/// returned 39 and the job proved correctly, then failed at delivery with "Invalid upload size" after eight
/// minutes of proving — on a real provider, because the stand-in never enforced the minimum. A result too
/// small to store is a job that cannot be paid for.
///
/// Padding would have done it, but a result worth reading does the same job: what was counted, over how
/// many pieces, and what the proof alongside it actually attests to.
pub fn report(term: &str, total: u64, pieces: usize) -> String {
    format!(
        "term: {term}\noccurrences: {total}\npieces: {pieces}\n\n\
         This count was produced inside a zkVM. The proof delivered with it commits to the Filecoin piece \
         CIDs of the inputs above and of this file, so it attests that exactly these bytes were counted \
         over exactly those pieces.\n"
    )
}

/// The same answer, for the job whose proof is not bound to the stored pieces.
///
/// Deliberately a separate function rather than a flag on `report`: that one's bytes are part of the bound
/// guest's output commitment, so changing it changes a verification key and every catalogue entry naming it.
///
/// The wording is the point. `report` says the proof attests that exactly these bytes were counted over
/// exactly those pieces, and for this job that is false — so saying it would be worse than saying nothing.
/// Someone reading the delivered file should be able to tell which of the two jobs produced it without
/// looking anything up.
pub fn report_attested(term: &str, total: u64, pieces: usize, digests: &[Vec<u8>]) -> String {
    let mut listed = String::new();
    for d in digests {
        listed.push_str("  sha256: ");
        for b in d {
            listed.push_str(&format!("{b:02x}"));
        }
        listed.push('\n');
    }
    format!(
        "term: {term}\noccurrences: {total}\npieces: {pieces}\n\n\
         inputs this count was taken over:\n{listed}\n\
         This count was produced inside a zkVM and the chain checked the proof, so the computation is not \
         in doubt. The proof commits to the sha256 digests above, NOT to the Filecoin piece CIDs of the \
         inputs, and nothing on chain ties those digests to the pieces you pay to store — that is what \
         makes this job cheap to prove. Retrieve a piece and hash it: if its sha256 is not listed above, \
         the digests are on chain in the delivering transaction as evidence of what was claimed.\n"
    )
}

// ---------------------------------------------------------------- summing amounts
//
// The job this exists for: prove a total over a file without showing the file. The answer goes in the
// output piece, which holds the total and nothing else; the input stays in the client's data set. A
// counterparty given the output, the proof, and the input piece ids checks that the proof commits to
// exactly those pieces — which are on chain, and which PDP shows are still held — and learns the total
// without ever seeing a line of it.

/// Amounts are parsed in minor units (cents) and summed as integers.
///
/// Floating point is not an option here. The sum is the thing being proved: it has to be exactly
/// reproducible by anyone re-running the guest, and binary floating point is neither exact for decimal
/// money nor associative, so the same lines in a different order could give a different total. An i128 of
/// cents holds any plausible sum without rounding and without overflow.
pub const MAX_DECIMALS: usize = 2;

/// One amount per line, optionally after a label and a comma: `invoice-2, 4800.00` or just `4800.00`.
/// A thousands separator is allowed inside the integer part. Anything else is a parse failure rather than a
/// guess — in a computation someone is paying to have proved, a line quietly read as zero is worse than a
/// line that stops the job.
pub fn parse_amount(line: &str) -> Option<i128> {
    // A comma is ambiguous here and getting it wrong is expensive: "4,800.00" read as a label followed by
    // an amount gives 800.00, a total short by four thousand, proved and paid for. So a comma counts as a
    // thousands separator when it sits between a digit and exactly three digits, and as a field separator
    // otherwise. The amount is whatever follows the last field separator.
    let bytes = line.as_bytes();
    let thousands = |i: usize| -> bool {
        let before_digit = i > 0 && bytes[i - 1].is_ascii_digit();
        let three = bytes.len() > i + 3 && bytes[i + 1..i + 4].iter().all(|c| c.is_ascii_digit());
        let ends = bytes.len() == i + 4 || !bytes[i + 4].is_ascii_digit();
        before_digit && three && ends
    };
    let cut = (0..bytes.len()).rev().find(|&i| bytes[i] == b',' && !thousands(i));
    let field = match cut { Some(i) => &line[i + 1..], None => line }.trim();
    let field = field.strip_prefix('$').or_else(|| field.strip_prefix('\u{20ac}')).unwrap_or(field).trim();
    let (neg, field) = match field.strip_prefix('-') {
        Some(rest) => (true, rest.trim()),
        None => (false, field),
    };
    let (int_part, frac_part) = match field.split_once('.') {
        Some((a, b)) => (a, b),
        None => (field, ""),
    };
    if frac_part.len() > MAX_DECIMALS || !frac_part.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let digits: Vec<u8> = int_part.bytes().filter(|c| *c != b',' && *c != b'_').collect();
    if digits.is_empty() || !digits.iter().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut cents: i128 = 0;
    for d in &digits {
        cents = cents.checked_mul(10)?.checked_add((d - b'0') as i128)?;
    }
    for _ in 0..MAX_DECIMALS {
        cents = cents.checked_mul(10)?;
    }
    for (i, d) in frac_part.bytes().enumerate() {
        cents = cents.checked_add(((d - b'0') as i128) * 10i128.pow((MAX_DECIMALS - 1 - i) as u32))?;
    }
    Some(if neg { -cents } else { cents })
}

/// Every parsable line, summed. Blank lines and anything that is not an amount are skipped and counted
/// separately: a file with a header row should still total, but the client needs to see that something was
/// not read rather than have it folded silently into the answer.
pub fn sum_amounts(bytes: &[u8]) -> (i128, u64, u64) {
    let text = core::str::from_utf8(bytes).unwrap_or("");
    let (mut total, mut counted, mut skipped) = (0i128, 0u64, 0u64);
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match parse_amount(line) {
            Some(v) => { total += v; counted += 1; }
            None => skipped += 1,
        }
    }
    (total, counted, skipped)
}

/// Cents back into a decimal string, for the output piece. Done by hand because the point is that anyone
/// can reproduce these exact bytes: the output's CID is what the proof commits to.
pub fn format_cents(cents: i128) -> String {
    let neg = cents < 0;
    let a = cents.unsigned_abs();
    let (whole, frac) = (a / 100, a % 100);
    format!("{}{}.{:02}", if neg { "-" } else { "" }, whole, frac)
}
