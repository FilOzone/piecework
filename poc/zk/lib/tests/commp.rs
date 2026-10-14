//! Does our piece CID match what Calibration actually stores?
//! The expected value is what PDPVerifier.getPieceCid returns for piece 7 of data set 41739 — this file.
use piecework_lib::{piece_cid, tree_height};

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }

#[test]
fn matches_a_piece_that_is_really_stored() {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../jobs/transcribe/sample/working-group-call.m4a")).unwrap();
    assert_eq!(bytes.len(), 3_910_695);
    assert_eq!(tree_height(bytes.len() as u64), 17);
    assert_eq!(hex(&piece_cid(&bytes)),
        "0155912024d9a70f11dfd6807767d544c2ef37c933a091b03f27ca72ef424464aa5dc5a542f45cdc04");
}

#[test]
fn small_input_has_the_right_shape() {
    assert_eq!(tree_height(675), 5);
    let cid = piece_cid(&vec![0u8; 675]);
    assert_eq!(&cid[..4], &[0x01, 0x55, 0x91, 0x20]);
    let digest = &cid[5..];
    assert_eq!(digest[digest.len() - 33], 5, "height byte");
    assert_eq!(&digest[..2], &[0xd5, 0x02], "varint(341) padding");
}
