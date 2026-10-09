// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.27;

import {IComputeProofVerifier} from "./ComputeService.sol";

/// @notice The part of ComputeService this verifier reads back.
interface IJobView {
    function jobs(uint256 jobId) external view returns (
        address client, address provider, uint256 railId, uint256 price, uint256 deadline,
        uint256 dataSetId, bytes32 imageDigest, uint256 firstOutputPieceId, uint8 status,
        address verifier, bytes32 inputCommitment
    );
}

/// @title AgreementVerifier
/// @notice Verification by having the work done twice, by different providers, and paying only when they
///         produce the same bytes.
///
/// The client orders the same program over the same pieces from two providers and names this contract as the
/// verifier on both jobs. Each provider runs the work and declares the commitment of what it produced. Once
/// two different providers have declared the same thing, each of their jobs can be delivered and paid. If
/// they disagree, neither can be paid, both jobs run out of time, and the client takes its money back through
/// the ordinary expiry path.
///
/// Why this rather than a proof of execution: a zk proof costs a thousand times the compute and is only worth
/// that when the answer must convince a stranger. Paying twice is a price a client can reason about, it works
/// on jobs whose output cannot be checked by eye — embeddings, where ten thousand plausible rows of numbers
/// look exactly like ten thousand real ones — and both providers must hold the data to do it, so buying
/// verification buys replication.
///
/// What it does not do. Two providers that collude defeat it entirely; this buys independence, not
/// soundness, and it is worth only as much as the independence of the two. It also requires the work to be
/// reproducible: measured on this POC's jobs, pii-redact, query, embed and transcribe are all bit-identical
/// across runs on a processor. On a GPU they very likely are not, and nothing here can fix that — a client
/// wanting agreement over a GPU job is asking two cards to produce identical floating point, which they will
/// not. That tension is real and unresolved.
contract AgreementVerifier is IComputeProofVerifier {
    IJobView public immutable computeService;

    /// What each provider says it produced, per unit of work.
    mapping(bytes32 workKey => mapping(address provider => bytes32)) public declaredBy;
    /// How many distinct providers stand behind each answer.
    mapping(bytes32 workKey => mapping(bytes32 outputCommitment => uint256)) public standingBehind;

    uint256 public constant REQUIRED = 2;

    event Declared(bytes32 indexed workKey, address indexed provider, bytes32 outputCommitment, uint256 agreeing);

    error NotTheJobsProvider();
    error NotForThisVerifier();

    constructor(IJobView cs) { computeService = cs; }

    /// @notice The same program over the same inputs for the same client is the same work, whoever runs it.
    ///         Deriving the key this way is what lets two independently posted jobs find each other without
    ///         the client having to introduce them.
    function workKey(address client, bytes32 vkey, bytes32 inputCommitment) public pure returns (bytes32) {
        return keccak256(abi.encode(client, vkey, inputCommitment));
    }

    /// @notice A provider says what it got. Cheap, and says nothing about whether it will be believed.
    function declare(uint256 jobId, bytes32 outputCommitment) external {
        (address client, address provider,,,,, bytes32 vkey,,, address verifier, bytes32 inputCommitment) =
            computeService.jobs(jobId);
        if (msg.sender != provider) revert NotTheJobsProvider();
        if (verifier != address(this)) revert NotForThisVerifier();

        bytes32 key = workKey(client, vkey, inputCommitment);
        bytes32 previous = declaredBy[key][msg.sender];
        // A provider changing its mind moves its support rather than adding to it, so that no one can reach
        // the threshold alone by declaring twice.
        if (previous != bytes32(0)) standingBehind[key][previous]--;
        declaredBy[key][msg.sender] = outputCommitment;
        standingBehind[key][outputCommitment]++;
        emit Declared(key, msg.sender, outputCommitment, standingBehind[key][outputCommitment]);
    }

    /// @notice True once REQUIRED different providers have declared this same result for this work.
    ///         `proof` is the job id being delivered, which is how this contract finds the client; the
    ///         program and the inputs come from ComputeService itself, so a caller cannot claim someone
    ///         else's agreement by passing different arguments.
    function verifyComputeProof(
        bytes32 vkey,
        bytes32 inputCommitment,
        bytes32 outputCommitment,
        bytes calldata proof
    ) external view returns (bool) {
        if (proof.length != 32) return false;
        uint256 jobId = abi.decode(proof, (uint256));
        (address client,,,,,, bytes32 jobVkey,,,, bytes32 jobInputs) = computeService.jobs(jobId);
        if (jobVkey != vkey || jobInputs != inputCommitment) return false;
        return standingBehind[workKey(client, vkey, inputCommitment)][outputCommitment] >= REQUIRED;
    }
}
