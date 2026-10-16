// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
// The file is SP1VerifierGroth16.sol but the contract inside it is plain `SP1Verifier`. ISP1Verifier comes
// from SP1ComputeVerifier.sol, which declares its own copy of the interface; importing the vendored one
// here as well would be a clashing declaration of the same name.
import {SP1Verifier} from "../src/vendor/sp1-v6.1.0/SP1VerifierGroth16.sol";
import {SP1ComputeVerifier, ISP1Verifier} from "../src/SP1ComputeVerifier.sol";

/// A real Groth16 proof, produced by this repo's own guest program, checked against SP1's own verifier.
///
/// Everything else in the suite proves the contract's *logic* against a mock. This proves the thing a mock
/// cannot: that the proof our prover emits is one SP1's verifier accepts, and that its journal carries the
/// commitments ComputeService derives — the two halves actually meeting. It took 22 minutes and 16M
/// constraints to produce these bytes, which is exactly why they belong in a test rather than in a session
/// transcript: regenerating them is expensive, and a change that breaks the binding is cheap to make.
///
/// These constants are a historical artifact and are meant to stay that way. The guest has changed since —
/// its output had to clear the 127-byte minimum piece size — so the catalogue's key is now 0x00086aa3… and
/// no longer this one. That does not weaken the test: it checks that a proof this prover produced is one
/// SP1's verifier accepts and that the adapter binds it to the right commitments, and a proof is as good
/// evidence of that a month later as on the day. Regenerating it would cost eight minutes and prove the
/// same thing.
///
/// Provenance: `piecework --prove --mode groth16 --term sealing` over a 4,096-byte input, SP1 v6.9.0,
/// circuit v6.1.0, 15,972,262 constraints. The guest derives each input piece's Filecoin CID in-circuit,
/// so publicValues is keccak(cid(input)) ‖ keccak(cid(output)) and nothing cheaper will satisfy it.
///
/// Regenerate with (from poc/):
///   docker run --rm -v "$PWD:/work" -v piecework-sp1:/root/.sp1 -w /work/zk/sp1 piecework/sp1:v6 \
///     sh -c './target/release/piecework --prove --mode groth16 --term sealing in/size-4096.bin'
///
/// Note on what this does and does not establish: Foundry runs revm, so a pass here shows the proof and
/// the binding are correct, not that Filecoin's EVM can run the verifier. That is settled separately —
/// FEVM implements the BN254 precompiles, confirmed by a probe contract deployed to Calibration, because
/// a top-level eth_call to 0x08 returns empty whether or not the precompile exists.
contract RealProofTest is Test {
    bytes32 constant VKEY = 0x006ea1696714f9709a7beb7adb073ec17c5aaa0dd3fb03047df8545902b014df;
    bytes32 constant INPUT_COMMITMENT = 0x8e489bddca53f1f20aa2e6f4769713a8573fd55e50982a6b5c2da5ed2d6a6abd;
    bytes32 constant OUTPUT_COMMITMENT = 0xa50f20aca1f66af01ffd74edaae4ba72d0dabe12b2d36c7e4be2dab549618aff;

    bytes constant PUBLIC_VALUES = hex"8e489bddca53f1f20aa2e6f4769713a8573fd55e50982a6b5c2da5ed2d6a6abd"
        hex"a50f20aca1f66af01ffd74edaae4ba72d0dabe12b2d36c7e4be2dab549618aff";

    bytes constant PROOF =
        hex"4388a21c"
        hex"0000000000000000000000000000000000000000000000000000000000000000"
        hex"002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f25352"
        hex"0000000000000000000000000000000000000000000000000000000000000000"
        hex"09720dce79d9ab3367a8cd5339cf3dfab1b9d5d100f766bbe0cb83a2cbd53386"
        hex"117d92ebacd3ed5c7d2c3de188909e5c1e842c8b2feaee331da862038033e3a4"
        hex"291a4d782f2208ce6d8dd6908bd77062f3fe5b0b8b7a8b7acb5af6b1b2f7fcbb"
        hex"019a394f6ba053638d75a24f36d8a90dc0ed4a90d9162c1b65b315b5ad4a92ba"
        hex"0ee81a3feebe93ebe67c170b50190e10ffccd68e8974c03c843d1e96caf1d7f0"
        hex"22fe4d1843d9c64d7235694649fc0b3a900a40b0c28a873d3a17f30744ada8ab"
        hex"222035df0cac912e11704c5ed236ad7198fd785bb07225e91c10cadf3ddae2d9"
        hex"1387ead87112274fdf99571174e5007a3374de69d435c387a9355800e505fc7c";

    SP1Verifier sp1;
    SP1ComputeVerifier adapter;

    function setUp() public {
        sp1 = new SP1Verifier();
        adapter = new SP1ComputeVerifier(ISP1Verifier(address(sp1)));
    }

    /// The verifier we would deploy is the one the prover's circuit was built for. A mismatch here is the
    /// failure mode that looks exactly like a forged proof, so it is worth asserting rather than assuming.
    function test_R0_verifierIsTheVersionTheCircuitWasBuiltFor() public view {
        assertEq(sp1.VERSION(), "v6.1.0");
    }

    function test_R1_sp1AcceptsOurProof() public view {
        sp1.verifyProof(VKEY, PUBLIC_VALUES, PROOF); // reverts if the proof is not good
    }

    /// Without this the test above means nothing: a verifier that accepts everything also accepts a real
    /// proof. One byte of the last field element is enough.
    function test_R2_oneByteChangedIsRejected() public {
        bytes memory tampered = PROOF;
        tampered[tampered.length - 1] = bytes1(uint8(tampered[tampered.length - 1]) ^ 0x01);
        vm.expectRevert();
        sp1.verifyProof(VKEY, PUBLIC_VALUES, tampered);
    }

    function test_R3_adapterAcceptsItForTheCommitmentsItProves() public view {
        assertTrue(adapter.verifyComputeProof(
            VKEY, INPUT_COMMITMENT, OUTPUT_COMMITMENT, abi.encode(PUBLIC_VALUES, PROOF)));
    }

    /// The property the whole design rests on. The proof is genuine and SP1 accepts it, and the adapter
    /// still refuses, because the job's inputs are not the ones the journal commits to. Without this a
    /// provider could honestly compute over last week's data and be paid for this week's job.
    function test_R4_aGenuineProofOfDifferentInputsIsRefused() public view {
        assertFalse(adapter.verifyComputeProof(
            VKEY, keccak256("some other pieces"), OUTPUT_COMMITMENT, abi.encode(PUBLIC_VALUES, PROOF)));
    }

    function test_R5_aGenuineProofOfDifferentOutputsIsRefused() public view {
        assertFalse(adapter.verifyComputeProof(
            VKEY, INPUT_COMMITMENT, keccak256("some other result"), abi.encode(PUBLIC_VALUES, PROOF)));
    }

    /// imageDigest doubles as the verification key, so ordering a job under the wrong program must fail
    /// even when every commitment lines up. This is what stops a catalogue job's keccak256("name") digest
    /// being passed off as a vkey.
    function test_R6_theWrongProgramIsRefused() public view {
        assertFalse(adapter.verifyComputeProof(
            bytes32(uint256(VKEY) ^ 1), INPUT_COMMITMENT, OUTPUT_COMMITMENT,
            abi.encode(PUBLIC_VALUES, PROOF)));
    }

    /// A provider sending rubbish should fail its own job, not make the call unrecoverable for the client.
    function test_R7_rubbishIsARefusalNotARevert() public view {
        assertFalse(adapter.verifyComputeProof(
            VKEY, INPUT_COMMITMENT, OUTPUT_COMMITMENT, hex"dead"));
    }
}
