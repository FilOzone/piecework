// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.27;

import {IComputeProofVerifier} from "./ComputeService.sol";

/// @notice SP1's on-chain verifier (succinctlabs/sp1-contracts, ISP1Verifier). It reverts rather than
///         returning false, which is why every call here is wrapped.
interface ISP1Verifier {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}

/// @title SP1ComputeVerifier
/// @notice Pays only against a proof that the program actually ran over the client's stored pieces.
///
/// The adapter is three lines of logic and one idea. A zkVM proves that *some* program ran over *some* bytes
/// and produced *some* output; on its own that is worth nothing to a payment condition, because a provider
/// could honestly compute yesterday's data, or someone else's, and be paid for today's job. What makes it
/// worth something is refusing to look at the proof until the values it commits to are the ones the chain
/// independently worked out: the CIDs of the pieces this job named, and the CIDs of the pieces being
/// delivered right now.
///
/// That is a demand on the guest program, not a convenience here. For its journal to carry the same input
/// commitment the chain computed, the guest has to derive each piece's CID from the bytes it was given —
/// Filecoin's piece commitment, not a convenient sha256 of a blob it chose. Any guest that commits to a
/// cheaper digest will simply never verify, which is the intended outcome: the alternative is a system where
/// "proven" means the provider proved something about bytes it picked itself.
contract SP1ComputeVerifier is IComputeProofVerifier {
    ISP1Verifier public immutable sp1;

    constructor(ISP1Verifier verifier) { sp1 = verifier; }

    /// @param proof abi.encode(publicValues, proofBytes) — the journal and the Groth16 proof.
    function verifyComputeProof(
        bytes32 vkey,
        bytes32 inputCommitment,
        bytes32 outputCommitment,
        bytes calldata proof
    ) external view returns (bool) {
        bytes memory publicValues;
        bytes memory proofBytes;
        // Malformed bytes are a refusal, not a revert: a provider sending rubbish should fail its own job,
        // not make the call unrecoverable for the client.
        try this.split(proof) returns (bytes memory pv, bytes memory pb) {
            publicValues = pv;
            proofBytes = pb;
        } catch { return false; }

        if (publicValues.length < 64) return false;
        (bytes32 provenInputs, bytes32 provenOutputs) = abi.decode(publicValues, (bytes32, bytes32));
        // Checked before the proof is even looked at: a valid proof of the wrong work is still the wrong work.
        if (provenInputs != inputCommitment || provenOutputs != outputCommitment) return false;

        try sp1.verifyProof(vkey, publicValues, proofBytes) { return true; } catch { return false; }
    }

    function split(bytes calldata proof) external pure returns (bytes memory, bytes memory) {
        return abi.decode(proof, (bytes, bytes));
    }
}
