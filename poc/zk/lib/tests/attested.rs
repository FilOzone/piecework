//! The cheap binding, and the file that carries it.

use piecework_lib::{commit_cids, report, report_attested, sha256_digest};

/// A known-answer test rather than a comparison against another sha256: an implementation that is wrong in
/// the same way as its reference passes.
#[test]
fn digest_is_sha256() {
    // sha256("abc"), the first vector in FIPS 180-4.
    let d = sha256_digest(b"abc");
    let hex: String = d.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert_eq!(d.len(), 32);
}

#[test]
fn order_is_part_of_the_commitment() {
    // Same property the bound job has, and for the same reason: a job over (a, b) is not a job over (b, a),
    // so the commitment has to distinguish them.
    let a = sha256_digest(b"alpha");
    let b = sha256_digest(b"beta");
    assert_ne!(
        commit_cids(&[a.clone(), b.clone()]),
        commit_cids(&[b, a]),
        "swapping the inputs left the commitment unchanged"
    );
}

/// The smallest piece a provider will store is 127 bytes. A 39-byte output once proved correctly and then
/// died on delivery with `Invalid upload size`, eight minutes into the job — the proof was fine and the
/// result was unstorable. Both reports are checked, because the cost of being wrong is paid at the very end.
#[test]
fn both_reports_can_be_stored_as_a_piece() {
    let d = vec![sha256_digest(b"one"), sha256_digest(b"two")];
    for (name, text) in [
        ("report", report("payment", 0, 1)),
        ("report_attested", report_attested("payment", 0, 1, &d[..1])),
        ("report_attested, two pieces", report_attested("payment", 7, 2, &d)),
    ] {
        assert!(
            text.len() >= 127,
            "{name} is {} bytes; the minimum piece size is 127",
            text.len()
        );
    }
}

/// The two jobs make different claims, and the delivered file is the only place a reader sees which one ran.
#[test]
fn the_attested_report_does_not_claim_piece_binding() {
    let d = vec![sha256_digest(b"one")];
    let attested = report_attested("payment", 3, 1, &d);
    assert!(
        !attested.contains("exactly those pieces"),
        "the attested report repeats the bound report's claim"
    );
    assert!(attested.contains("NOT to the Filecoin piece CIDs"), "the weaker claim is not stated");
    // The digests have to be in the file, or "retrieve a piece and hash it" is not actionable.
    let hex: String = d[0].iter().map(|b| format!("{b:02x}")).collect();
    assert!(attested.contains(&hex), "the input digest is not listed in the report");
    // And the bound one must still say what it attests to.
    assert!(report("payment", 3, 1).contains("exactly those pieces"));
}
