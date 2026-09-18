// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {FilecoinPayV1} from "filecoin-pay/src/FilecoinPayV1.sol";

/// @notice The part of PDPVerifier that ComputeService needs (FilOzone/pdp @ 4d6b30f, src/PDPVerifier.sol):
///         `pieceLive` (L356) and `getNextPieceId` (L381). Piece ids in a live data set only grow,
///         so pieces with id >= getNextPieceId(setId) at time t were added after t.
interface IPieceLiveness {
    function pieceLive(uint256 setId, uint256 pieceId) external view returns (bool);
    function getNextPieceId(uint256 setId) external view returns (uint256);
}

/// @notice FWSS per-data-set authorizer interface (FilOzone/filecoin-services @ 4cbbea4,
///         src/interfaces/IDataSetAuthorizer.sol). Once a client attaches an authorizer to its data set
///         (FWSS.setDataSetAuthorizer, L1540), FWSS asks it to approve every write to that data set.
interface IDataSetAuthorizer {
    function isAuthorized(
        uint256 dataSetId,
        address payer,
        bytes32 operation,
        bytes32 digest,
        bytes calldata signature,
        bytes calldata operationData
    ) external returns (bool authorized);
}

/// @notice The part of SessionKeyRegistry the authorizer needs (FilOzone/SessionKeyRegistry).
interface ISessionKeyRegistry {
    function authorizationExpiry(address user, address signer, bytes32 permission) external view returns (uint256);
}

/// @title ComputeService (proof of concept)
/// @notice Compute over a client's PDP data set, paid through Filecoin Pay.
///         ComputeService is the client's Filecoin Pay *operator*: it opens, changes and closes
///         payment rails client -> provider, within the limits the client approved.
///
///         Pay for time (sessions): openSession -> sessionReady (rate starts) -> closeSession (rate to 0, terminate).
///         Pay per job:            postJob (price locked) -> commitOutputs before deadline (pay, terminate)
///                                                        -> or expire after deadline (refund).
///
///         Job outputs go into the client's own data set. On FWSS this needs the client's authorization for each
///         addPieces; instead, the client attaches this contract as its data set's authorizer (IDataSetAuthorizer),
///         and it approves the provider's addPieces only while a job of that client with that provider is open.
///
///         Guarantees S1-S4 and J1-J3 are stated in the project's protocol design and tested in
///         test/ComputeGuarantees.t.sol (Filecoin Pay mechanics) and test/ComputeService.t.sol (this contract).
contract ComputeService is IDataSetAuthorizer {
    // ---------------------------------------------------------------- types

    enum SessionStatus { None, Open, Ready, Closed }
    enum JobStatus { None, Posted, Paid, Expired }

    struct Session {
        address client;
        address provider;
        uint256 railId;
        uint256 rate;          // token units per epoch
        uint256 lockupPeriod;  // epochs of "safety margin"
        uint256 dataSetId;
        bytes32 imageDigest;   // which program runs (container image digest)
        SessionStatus status;
    }

    struct Job {
        address client;
        address provider;
        uint256 railId;
        uint256 price;
        uint256 deadline;      // last epoch at which outputs can be committed
        uint256 dataSetId;
        bytes32 imageDigest;
        uint256 firstOutputPieceId; // outputs must be pieces added after the job was posted
        JobStatus status;
    }

    // ---------------------------------------------------------------- state

    FilecoinPayV1 public immutable payments;
    IERC20 public immutable token;
    IPieceLiveness public immutable pdp;
    ISessionKeyRegistry public immutable sessionKeys; // address(0) = no session keys (local POC)

    // FWSS operation id for adding pieces (SignatureVerificationLib.ADD_PIECES_TYPEHASH, filecoin-services at 4cbbea4, L29)
    bytes32 public constant ADD_PIECES_TYPEHASH = keccak256(
        "AddPieces(uint256 clientDataSetId,uint256 nonce,Cid[] pieceData,PieceMetadata[] pieceMetadata)"
        "Cid(bytes data)" "MetadataEntry(string key,string value)"
        "PieceMetadata(uint256 pieceIndex,MetadataEntry[] metadata)"
    );

    uint256 public nextSessionId = 1;
    uint256 public nextJobId = 1;
    mapping(uint256 => Session) public sessions;
    mapping(uint256 => Job) public jobs;
    // open (posted, not yet paid or expired) jobs per data set, client and provider
    mapping(uint256 dataSetId => mapping(address client => mapping(address provider => uint256))) public openJobs;

    // ---------------------------------------------------------------- events

    event SessionOpened(uint256 indexed sessionId, address indexed client, address indexed provider, uint256 railId, bytes32 imageDigest, uint256 rate, uint256 lockupPeriod, uint256 dataSetId);
    event SessionReady(uint256 indexed sessionId, uint256 epoch);
    event SessionClosed(uint256 indexed sessionId, address closedBy, bool rateStoppedAtClose);

    event JobPosted(uint256 indexed jobId, address indexed client, address indexed provider, uint256 railId, bytes32 imageDigest, uint256 dataSetId, uint256[] inputPieceIds, uint256 price, uint256 deadline);
    event JobPaid(uint256 indexed jobId, uint256[] outputPieceIds, uint256 epoch);
    event JobExpired(uint256 indexed jobId);

    // ---------------------------------------------------------------- errors

    error NotClient();
    error NotProvider();
    error NotParty();
    error WrongStatus();
    error PieceNotLive(uint256 dataSetId, uint256 pieceId);
    error NoOutputs();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error DeadlineInPast();
    error OutputNotNew(uint256 pieceId);

    constructor(FilecoinPayV1 payments_, IERC20 token_, IPieceLiveness pdp_, ISessionKeyRegistry sessionKeys_) {
        payments = payments_;
        token = token_;
        pdp = pdp_;
        sessionKeys = sessionKeys_;
    }

    // ================================================================ pay for time

    /// @notice Client opens a session with `provider`. A rail is created with lockup period
    ///         `lockupPeriod` and rate 0: nothing is billed until the provider signals ready.
    function openSession(address provider, bytes32 imageDigest, uint256 rate, uint256 lockupPeriod, uint256 dataSetId)
        external
        returns (uint256 sessionId)
    {
        uint256 railId = payments.createRail(token, msg.sender, provider, address(0), 0, address(0));
        payments.modifyRailLockup(railId, lockupPeriod, 0);
        sessionId = nextSessionId++;
        sessions[sessionId] = Session(msg.sender, provider, railId, rate, lockupPeriod, dataSetId, imageDigest, SessionStatus.Open);
        emit SessionOpened(sessionId, msg.sender, provider, railId, imageDigest, rate, lockupPeriod, dataSetId);
    }

    /// @notice Provider signals the service is running: the rate starts (billing starts here).
    ///         Reverts if the client is not funded for rate * lockupPeriod (Filecoin Pay rule, test V4).
    function sessionReady(uint256 sessionId) external {
        Session storage s = sessions[sessionId];
        if (msg.sender != s.provider) revert NotProvider();
        if (s.status != SessionStatus.Open) revert WrongStatus();
        s.status = SessionStatus.Ready;
        payments.modifyRailPayment(s.railId, s.rate, 0);
        emit SessionReady(sessionId, block.number);
    }

    /// @notice Client or provider ends the session.
    ///         If possible, the rate is set to 0 first, so payment stops at this epoch ("stop means stop", test S4).
    ///         If the client is underfunded, Filecoin Pay refuses the rate change (test S4b); the rail is then only
    ///         terminated and the provider can settle up to lockupLastSettledAt + lockupPeriod (test S1).
    function closeSession(uint256 sessionId) external {
        Session storage s = sessions[sessionId];
        if (msg.sender != s.client && msg.sender != s.provider) revert NotParty();
        if (s.status != SessionStatus.Open && s.status != SessionStatus.Ready) revert WrongStatus();
        bool stopped = true;
        if (s.status == SessionStatus.Ready) {
            try payments.modifyRailPayment(s.railId, 0, 0) {} catch { stopped = false; }
        }
        s.status = SessionStatus.Closed;
        payments.terminateRail(s.railId);
        emit SessionClosed(sessionId, msg.sender, stopped);
    }

    // ================================================================ pay per job

    /// @notice Client orders a job over live pieces of its data set. The price is locked in the rail's
    ///         fixed lockup (escrow) until the provider delivers or the deadline passes.
    function postJob(
        address provider,
        bytes32 imageDigest,
        uint256 dataSetId,
        uint256[] calldata inputPieceIds,
        uint256 price,
        uint256 deadline
    ) external returns (uint256 jobId) {
        if (deadline <= block.number) revert DeadlineInPast();
        for (uint256 i = 0; i < inputPieceIds.length; i++) {
            if (!pdp.pieceLive(dataSetId, inputPieceIds[i])) revert PieceNotLive(dataSetId, inputPieceIds[i]);
        }
        uint256 railId = payments.createRail(token, msg.sender, provider, address(0), 0, address(0));
        payments.modifyRailLockup(railId, 0, price);
        jobId = nextJobId++;
        jobs[jobId] = Job(
            msg.sender, provider, railId, price, deadline, dataSetId, imageDigest, pdp.getNextPieceId(dataSetId), JobStatus.Posted
        );
        openJobs[dataSetId][msg.sender][provider]++;
        emit JobPosted(jobId, msg.sender, provider, railId, imageDigest, dataSetId, inputPieceIds, price, deadline);
    }

    /// @notice Provider delivers: the output pieces must be live in the client's data set and added after the
    ///         job was posted (so pre-existing pieces cannot be passed off as outputs); the call must happen
    ///         no later than the deadline epoch. Pays the price, then terminates the rail
    ///         (pay-then-terminate order required, test V3).
    function commitOutputs(uint256 jobId, uint256[] calldata outputPieceIds) external {
        Job storage j = jobs[jobId];
        if (msg.sender != j.provider) revert NotProvider();
        if (j.status != JobStatus.Posted) revert WrongStatus();
        if (block.number > j.deadline) revert DeadlinePassed();
        if (outputPieceIds.length == 0) revert NoOutputs();
        for (uint256 i = 0; i < outputPieceIds.length; i++) {
            if (outputPieceIds[i] < j.firstOutputPieceId) revert OutputNotNew(outputPieceIds[i]);
            if (!pdp.pieceLive(j.dataSetId, outputPieceIds[i])) revert PieceNotLive(j.dataSetId, outputPieceIds[i]);
        }
        j.status = JobStatus.Paid;
        openJobs[j.dataSetId][j.client][j.provider]--;
        payments.modifyRailPayment(j.railId, 0, j.price);
        payments.terminateRail(j.railId);
        emit JobPaid(jobId, outputPieceIds, block.number);
    }

    /// @notice Anyone, after the deadline with no delivery: terminates the rail and releases the escrow
    ///         back to the client's available funds.
    function expire(uint256 jobId) external {
        Job storage j = jobs[jobId];
        if (j.status != JobStatus.Posted) revert WrongStatus();
        if (block.number <= j.deadline) revert DeadlineNotPassed();
        j.status = JobStatus.Expired;
        openJobs[j.dataSetId][j.client][j.provider]--;
        payments.terminateRail(j.railId);
        payments.modifyRailLockup(j.railId, 0, 0);
        emit JobExpired(jobId);
    }

    // ================================================================ FWSS data set authorizer

    /// @notice Called by FWSS for every write to a data set whose client attached this contract as authorizer.
    ///         Allowed: (1) anything signed by the client itself or by one of its valid session keys, so the
    ///         client's normal use is unchanged; (2) adding pieces signed by a provider while that client has an
    ///         open job with that provider on this data set (the window for delivering outputs).
    ///         Everything else (e.g. a provider removing pieces, or adding pieces with no open job) is refused.
    function isAuthorized(
        uint256 dataSetId,
        address payer,
        bytes32 operation,
        bytes32 digest,
        bytes calldata signature,
        bytes calldata /* operationData */
    ) external view returns (bool) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError) return false;
        if (signer == payer) return true;
        if (address(sessionKeys) != address(0) && sessionKeys.authorizationExpiry(payer, signer, operation) >= block.timestamp) {
            return true;
        }
        return operation == ADD_PIECES_TYPEHASH && openJobs[dataSetId][payer][signer] > 0;
    }
}
