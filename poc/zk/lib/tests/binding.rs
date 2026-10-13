//! The other half of the binding: does keccak over the input CIDs, as the guest computes it, equal what
//! ComputeService computes on chain from piece ids it already holds?
//!
//! The contract does, for each input piece in order:
//!     acc = abi.encodePacked(acc, pdp.getPieceCid(dataSetId, pieceId).data)
//! then keccak256(acc). abi.encodePacked of bytes is the bytes themselves, so this is keccak over the CIDs
//! concatenated in order — which is what commit_pieces does. The expected values below are the real CIDs of
//! pieces 7 and 8 of data set 41739, read from PDPVerifier.
use piecework_lib::{commit_cids, keccak};

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }

const CID7: &str = "0155912024d9a70f11dfd6807767d544c2ef37c933a091b03f27ca72ef424464aa5dc5a542f45cdc04";
const CID8: &str = "0155912023d502052092a494a12b3c088af4a7d2530d25e72052ab9fdbd6580abdcd17142e3c6f2c";

#[test]
fn commitment_is_keccak_over_the_cids_in_order() {
    let mut acc = unhex(CID7);
    acc.extend_from_slice(&unhex(CID8));
    let expected = hex(&keccak(&acc));

    // What the guest would produce, given the same two pieces in the same order.
    let got = hex(&commit_cids(&[unhex(CID7), unhex(CID8)]));
    assert_eq!(got, expected, "guest commitment must equal the chain's");
    println!("commitment = 0x{got}");
}

#[test]
fn order_is_part_of_the_commitment() {
    let a = commit_cids(&[unhex(CID7), unhex(CID8)]);
    let b = commit_cids(&[unhex(CID8), unhex(CID7)]);
    assert_ne!(a, b, "swapping the inputs must change the commitment");
}
