// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.27;

/// @title IComputeService (proposed interface, not yet implemented)
/// @notice Compute over a client's PDP data set, paid through Filecoin Pay.
///         ComputeService acts as the client's Filecoin Pay operator.
///         Sessions are paid per epoch (rate rail); batch jobs are paid once (fixed lockup).
interface IComputeService {
    // ---------- Sessions: pay for time ----------

    /// Creates a rail client -> provider with lockup period `lockupPeriod` and rate 0.
    function openSession(address provider, bytes32 imageDigest, uint256 rate, uint256 lockupPeriod, uint256 dataSetId)
        external
        returns (uint256 sessionId);

    /// Provider only. Sets the rail rate to `rate`: billing starts here.
    function sessionReady(uint256 sessionId) external;

    /// Client or provider. If the client stops (and is funded): sets the rate to 0, then terminates the rail,
    /// so payment stops at the stop epoch and the safety margin is released (test S4).
    /// If the provider stops because the client is underfunded: terminates only, so the provider can settle
    /// up to lockupLastSettledAt + lockupPeriod (test S1). Does not settle.
    function closeSession(uint256 sessionId) external;

    event SessionOpened(uint256 indexed sessionId, address indexed client, address indexed provider, uint256 railId);
    event SessionReady(uint256 indexed sessionId, uint256 epoch);
    event SessionClosed(uint256 indexed sessionId, uint256 endEpoch);

    // ---------- Batch jobs: pay per job ----------

    /// Checks input pieces are live in PDP; creates a rail with fixed lockup `price` (escrow).
    function postJob(
        address provider,
        bytes32 imageDigest,
        uint256 dataSetId,
        uint256[] calldata inputPieceIds,
        uint256 price,
        uint256 deadline
    ) external returns (uint256 jobId);

    /// Provider only, before the deadline. Checks output pieces, pays `price` (one-time), then terminates the rail.
    function commitOutputs(uint256 jobId, uint256[] calldata outputPieceIds) external;

    /// Anyone, after the deadline with no outputs. Terminates the rail and releases the escrow to the client.
    function expire(uint256 jobId) external;

    event JobPosted(uint256 indexed jobId, address indexed client, address indexed provider, uint256 price, uint256 deadline);
    event JobPaid(uint256 indexed jobId, uint256[] outputPieceIds, uint256 epoch);
    event JobExpired(uint256 indexed jobId);
}
