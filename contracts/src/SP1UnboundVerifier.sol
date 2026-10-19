// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.27;

import {IComputeProofVerifier} from "./ComputeService.sol";
import {ISP1Verifier} from "./SP1ComputeVerifier.sol";

/// @title SP1UnboundVerifier
/// @notice Pays against a proof that the computation ran, without the chain checking what it ran over.
///
/// This is `SP1ComputeVerifier` with one comparison removed, and the removal is the entire product
/// difference between two jobs a client can choose between.
///
/// The bound adapter refuses to look at a proof until the input commitment in its journal equals the one
/// ComputeService derived from the CIDs PDP holds. Satisfying that forces the guest to derive each piece's
/// Filecoin CID in-circuit — fr32 padding and a sha256 merkle tree.
///
/// Measured on the same inputs, whole guest to whole guest: 99 cycles a byte bound against 24 attested, so
/// about four times the proving cost. The binding itself is the 12.5 a byte a flat sha256 costs versus 87
/// for the piece CID — nearer seven times — but the job's own work, counting a term across the input, is
/// about 11.6 a byte and is paid either way. It was invisible at 99 and is half the bill at 24. Proving is
/// memory-bound, so the same ratio is also roughly how much more data one attested proof can cover.
///
/// A client who does not need the chain to enforce *which* bytes were read can order the attested job and
/// pay less. Its guest commits `keccak256(sha256(piece_1) || sha256(piece_2) || ...)`, and no contract can
/// check that against anything: a piece CID is a merkle root over fr32-padded data and there is no on-chain
/// path from it to a sha256 of the raw bytes. So this adapter does not pretend to try.
///
/// What it still checks, and what that is worth:
///   - the Groth16 proof itself, against the program key the job named. The computation is not in doubt.
///   - the output commitment, which is a real piece CID of the bytes being delivered. The result is bound
///     to the proof even though the input is not, and it costs nothing worth saving because the output is
///     a few hundred bytes.
///
/// What the client gets instead of enforcement is evidence. The claimed input digests are in the journal,
/// which sits in the calldata of the `commitOutputs` transaction permanently and attributably, and the
/// guest also writes them into the delivered file so reading them needs no transaction decoding. A client
/// who later retrieves a piece and finds its sha256 absent from that list holds a recorded, signed claim
/// that does not match the data. That is a basis for not using a provider again, not for refusing to pay:
/// payment here is still atomic with verification, as it is for the bound job, and nothing is clawed back.
///
/// The `inputCommitment` argument is accepted and ignored rather than removed, because the interface is
/// what lets a client pick its verifier by address at `postJob`. Changing the signature would mean changing
/// ComputeService, and the point of this contract is that it needs no change there at all.
contract SP1UnboundVerifier is IComputeProofVerifier {
    ISP1Verifier public immutable sp1;

    constructor(ISP1Verifier verifier) {
        sp1 = verifier;
    }

    /// @param proof abi.encode(publicValues, proofBytes) — the journal and the Groth16 proof.
    function verifyComputeProof(
        bytes32 vkey,
        bytes32, // inputCommitment — deliberately unused; see the notice above
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
        } catch {
            return false;
        }

        if (publicValues.length < 64) return false;
        // The first field is read past rather than read: the journal keeps the bound guest's shape so that
        // this adapter stays a near-copy, and a reader comparing the two sees one missing comparison.
        (, bytes32 provenOutputs) = abi.decode(publicValues, (bytes32, bytes32));
        // Still checked before the proof is looked at. A valid proof of someone else's output is still not
        // this job's output.
        if (provenOutputs != outputCommitment) return false;

        try sp1.verifyProof(vkey, publicValues, proofBytes) {
            return true;
        } catch {
            return false;
        }
    }

    function split(bytes calldata proof) external pure returns (bytes memory, bytes memory) {
        return abi.decode(proof, (bytes, bytes));
    }
}
