// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.27;

import {IComputeProofVerifier} from "./ComputeService.sol";

/// @title MockVerifier (tests and local POC only)
/// @notice Stands in for a real proving system so the *contract's* half of verified compute can be tested
///         without one. It accepts a proof when the proof bytes are exactly what an honest prover for this
///         job would have produced: keccak over the program, the inputs and the outputs.
///
///         That is obviously not a proof of anything — anyone holding the three commitments can forge it.
///         What it faithfully reproduces is the only property ComputeService depends on: a verifier says yes
///         to a proof that is bound to this program, these inputs and these outputs, and no to one that is
///         not. A real SP1 or RISC Zero verifier differs in being unforgeable, not in its shape.
contract MockVerifier is IComputeProofVerifier {
    bool public refuseEverything;

    function setRefuseEverything(bool v) external { refuseEverything = v; }

    function expected(bytes32 vkey, bytes32 inputCommitment, bytes32 outputCommitment)
        public pure returns (bytes memory)
    {
        return abi.encodePacked(keccak256(abi.encode(vkey, inputCommitment, outputCommitment)));
    }

    function verifyComputeProof(
        bytes32 vkey,
        bytes32 inputCommitment,
        bytes32 outputCommitment,
        bytes calldata proof
    ) external view returns (bool) {
        if (refuseEverything) return false;
        return keccak256(proof) == keccak256(expected(vkey, inputCommitment, outputCommitment));
    }
}
