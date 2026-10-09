// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.27;

import {ISP1Verifier} from "./SP1ComputeVerifier.sol";

/// @title MockSP1Verifier (tests only)
/// @notice Stands in for SP1's verifier so the adapter's own logic can be tested without a prover or the
///         pairing precompiles. It reverts exactly where the real one reverts — on a proof that does not
///         match the program key and the journal — and that is the whole of what the adapter depends on.
///         It is not sound: `accept` simply records which (vkey, publicValues, proofBytes) triples are to be
///         believed. Soundness is what the real verifier adds; shape is what is being tested here.
contract MockSP1Verifier is ISP1Verifier {
    mapping(bytes32 => bool) public believed;

    function accept(bytes32 vkey, bytes calldata publicValues, bytes calldata proofBytes) external {
        believed[keccak256(abi.encode(vkey, publicValues, proofBytes))] = true;
    }

    function verifyProof(bytes32 vkey, bytes calldata publicValues, bytes calldata proofBytes) external view {
        require(believed[keccak256(abi.encode(vkey, publicValues, proofBytes))], "SP1: bad proof");
    }
}
