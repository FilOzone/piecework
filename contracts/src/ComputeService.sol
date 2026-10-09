// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {FilecoinPayV1} from "filecoin-pay/src/FilecoinPayV1.sol";

/// @notice The part of PDPVerifier that ComputeService needs (FilOzone/pdp @ 4d6b30f, src/PDPVerifier.sol):
///         `pieceLive` (L356) and `getNextPieceId` (L381). Piece ids in a live data set only grow,
///         so pieces with id >= getNextPieceId(setId) at time t were added after t.
interface IPieceLiveness {
    struct Cid { bytes data; }
    function pieceLive(uint256 setId, uint256 pieceId) external view returns (bool);
    function getNextPieceId(uint256 setId) external view returns (uint256);
    /// @notice The piece's CID, which is a hash of its bytes (PDPVerifier L371). This is what lets a proof
    ///         about *bytes* be tied to a job about *piece ids*, without the bytes ever being on chain.
    function getPieceCid(uint256 setId, uint256 pieceId) external view returns (Cid memory);
}

/// @notice A proof that the work was actually done, checked before the provider is paid.
///
/// ComputeService deliberately knows nothing about any proving system. It hands the verifier three things it
/// already holds — which program was ordered, what went in, and what came out — plus whatever bytes the
/// provider supplied, and believes the answer. An SP1 or RISC Zero verifier, an attestation checker, or a
/// scheme where two providers must agree, are all the same shape from here, and the client picks which one it
/// trusts by naming its address when posting the job. A verification method cannot be forced on anyone: a
/// client that names no verifier gets exactly the behaviour that existed before this interface did.
interface IComputeProofVerifier {
    /// @param vkey             identifies the program, as the job's imageDigest
    /// @param inputCommitment  keccak256 over the CIDs of the pieces the job named as input
    /// @param outputCommitment keccak256 over the CIDs of the pieces being delivered
    /// @param proof            opaque to ComputeService
    function verifyComputeProof(
        bytes32 vkey,
        bytes32 inputCommitment,
        bytes32 outputCommitment,
        bytes calldata proof
    ) external view returns (bool);
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

/// @notice The part of FWSS's view contract ComputeService needs: who owns (pays for) a data set, and which
///         service provider holds it (FilecoinWarmStorageServiceStateView.getDataSet, filecoin-services at 4cbbea4, L82;
///         struct FilecoinWarmStorageService.DataSetInfoView, L165).
interface IDataSetView {
    struct DataSetInfoView {
        uint256 pdpRailId;
        uint256 cacheMissRailId;
        uint256 cdnRailId;
        address payer;
        address payee;
        address serviceProvider;
        uint256 commissionBps;
        uint256 clientDataSetId;
        uint256 pdpEndEpoch;
        uint256 providerId;
        uint96 pendingOneTimePayments;
        uint96 lifecycleReserveBalance;
        uint256 dataSetId;
    }

    function getDataSet(uint256 dataSetId) external view returns (DataSetInfoView memory);
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
        address verifier;         // address(0): delivery alone is the payment condition, as before
        bytes32 inputCommitment;  // fixed when the job is posted, so the inputs cannot be swapped afterwards
    }

    // ---------------------------------------------------------------- state

    FilecoinPayV1 public immutable payments;
    IERC20 public immutable token;
    IPieceLiveness public immutable pdp;
    ISessionKeyRegistry public immutable sessionKeys; // address(0) = no session keys (local POC)
    IDataSetView public immutable dataSets; // FWSS view: owner (payer) and service provider of each data set

    // FWSS operation id for adding pieces (SignatureVerificationLib.ADD_PIECES_TYPEHASH, filecoin-services at 4cbbea4, L29)
    bytes32 public constant ADD_PIECES_TYPEHASH = keccak256(
        "AddPieces(uint256 clientDataSetId,uint256 nonce,Cid[] pieceData,PieceMetadata[] pieceMetadata)"
        "Cid(bytes data)" "MetadataEntry(string key,string value)"
        "PieceMetadata(uint256 pieceIndex,MetadataEntry[] metadata)"
    );

    // FWSS operation id for scheduling piece removals (SignatureVerificationLib.SCHEDULE_PIECE_REMOVALS_TYPEHASH,
    // filecoin-services at 4cbbea4, L35)
    bytes32 public constant SCHEDULE_PIECE_REMOVALS_TYPEHASH =
        keccak256("SchedulePieceRemovals(uint256 clientDataSetId,uint256[] pieceIds)");

    uint256 public nextSessionId = 1;
    uint256 public nextJobId = 1;
    mapping(uint256 => Session) public sessions;
    mapping(uint256 => Job) public jobs;
    // open (posted, not yet paid or expired) jobs per data set, client and provider
    mapping(uint256 dataSetId => mapping(address client => mapping(address provider => uint256))) public openJobs;
    // running (ready, not yet closed) sessions per data set, client and provider. A session that is being paid
    // for by the epoch may write into the data set exactly as an open job may: the invariant is that a provider
    // can add pieces only while the client is paying it to, and pay-for-time is the second way that is true.
    mapping(uint256 dataSetId => mapping(address client => mapping(address provider => uint256))) public readySessions;
    // pieces the client lets the provider remove once that job has delivered (empty = nothing is ever removed)
    mapping(uint256 jobId => uint256[]) internal jobRemovals;
    // granted on delivery, spent when the provider schedules the removal: one piece, one removal
    mapping(uint256 dataSetId => mapping(address provider => mapping(uint256 pieceId => bool))) public mayRemove;

    // ---------------------------------------------------------------- events

    event SessionOpened(uint256 indexed sessionId, address indexed client, address indexed provider, uint256 railId, bytes32 imageDigest, uint256 rate, uint256 lockupPeriod, uint256 dataSetId);
    event SessionReady(uint256 indexed sessionId, uint256 epoch);
    event SessionClosed(uint256 indexed sessionId, address closedBy, bool rateStoppedAtClose);

    event JobPosted(uint256 indexed jobId, address indexed client, address indexed provider, uint256 railId, bytes32 imageDigest, uint256 dataSetId, uint256[] inputPieceIds, uint256 price, uint256 deadline);
    event RemovalAllowed(uint256 indexed jobId, uint256 dataSetId, address indexed provider, uint256[] pieceIds);
    event RemovalRevoked(uint256 indexed dataSetId, address indexed provider, uint256[] pieceIds);
    event JobNeedsProof(uint256 indexed jobId, address verifier, bytes32 inputCommitment);
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
    error NotDataSetOwner(uint256 dataSetId, address caller);
    error NotDataSetProvider(uint256 dataSetId, address provider);
    error ProofRejected(uint256 jobId);

    constructor(
        FilecoinPayV1 payments_,
        IERC20 token_,
        IPieceLiveness pdp_,
        ISessionKeyRegistry sessionKeys_,
        IDataSetView dataSets_
    ) {
        payments = payments_;
        token = token_;
        pdp = pdp_;
        sessionKeys = sessionKeys_;
        dataSets = dataSets_;
    }

    /// Only the owner (payer) of a data set can buy compute over it, and only from the service provider that
    /// holds it: compute happens where the data is, on data the caller controls.
    /// @notice A commitment to the *bytes* of a list of pieces, built from the CIDs the verifier already
    ///         stores. Piece ids mean nothing to a program running in a zkVM; the CID is a hash of the
    ///         content, so committing to CIDs is what lets an off-chain proof about bytes be checked against
    ///         an on-chain job about pieces. Order is part of the commitment: a program given its inputs in a
    ///         different order may legitimately produce a different answer.
    function _commitPieces(uint256 dataSetId, uint256[] memory pieceIds) internal view returns (bytes32) {
        bytes memory acc;
        for (uint256 i = 0; i < pieceIds.length; i++) {
            acc = abi.encodePacked(acc, pdp.getPieceCid(dataSetId, pieceIds[i]).data);
        }
        return keccak256(acc);
    }

    function _checkDataSet(uint256 dataSetId, address provider) internal view {
        IDataSetView.DataSetInfoView memory d = dataSets.getDataSet(dataSetId);
        if (d.payer != msg.sender) revert NotDataSetOwner(dataSetId, msg.sender);
        if (d.serviceProvider != provider) revert NotDataSetProvider(dataSetId, provider);
    }

    // ================================================================ pay for time

    /// @notice Client opens a session with `provider`. A rail is created with lockup period
    ///         `lockupPeriod` and rate 0: nothing is billed until the provider signals ready.
    function openSession(address provider, bytes32 imageDigest, uint256 rate, uint256 lockupPeriod, uint256 dataSetId)
        external
        returns (uint256 sessionId)
    {
        _checkDataSet(dataSetId, provider);
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
        readySessions[s.dataSetId][s.client][s.provider]++;
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
            readySessions[s.dataSetId][s.client][s.provider]--;
            try payments.modifyRailPayment(s.railId, 0, 0) {} catch { stopped = false; }
        }
        s.status = SessionStatus.Closed;
        payments.terminateRail(s.railId);
        emit SessionClosed(sessionId, msg.sender, stopped);
    }

    // ================================================================ pay per job

    /// @notice Client orders a job over live pieces of its data set. The price is locked in the rail's
    ///         fixed lockup (escrow) until the provider delivers or the deadline passes.
    /// @notice Order a job on delivery alone — unchanged behaviour, and still the default.
    function postJob(
        address provider,
        bytes32 imageDigest,
        uint256 dataSetId,
        uint256[] calldata inputPieceIds,
        uint256[] calldata removeOnDelivery,
        uint256 price,
        uint256 deadline
    ) external returns (uint256 jobId) {
        return postJob(provider, imageDigest, dataSetId, inputPieceIds, removeOnDelivery, price, deadline, address(0));
    }

    /// @notice Order a job that is paid only once a proof of the computation verifies as well.
    ///
    /// The client names the verifier, so it chooses what "proved" means to it and what that is worth; a
    /// provider that cannot produce such a proof simply does not deliver, and the deadline refunds the client
    /// as it always did. Nothing here makes the provider wait for its money: the proof is checked inside
    /// commitOutputs, so payment stays atomic and there is no challenge window to grief.
    ///
    /// The inputs are committed to now rather than at delivery, because the point of the proof is that the
    /// program ran over *these* bytes.
    function postJob(
        address provider,
        bytes32 imageDigest,
        uint256 dataSetId,
        uint256[] calldata inputPieceIds,
        uint256[] calldata removeOnDelivery,
        uint256 price,
        uint256 deadline,
        address verifier
    ) public returns (uint256 jobId) {
        if (deadline <= block.number) revert DeadlineInPast();
        _checkDataSet(dataSetId, provider);
        for (uint256 i = 0; i < inputPieceIds.length; i++) {
            if (!pdp.pieceLive(dataSetId, inputPieceIds[i])) revert PieceNotLive(dataSetId, inputPieceIds[i]);
        }
        for (uint256 i = 0; i < removeOnDelivery.length; i++) {
            if (!pdp.pieceLive(dataSetId, removeOnDelivery[i])) revert PieceNotLive(dataSetId, removeOnDelivery[i]);
        }
        uint256 railId = payments.createRail(token, msg.sender, provider, address(0), 0, address(0));
        payments.modifyRailLockup(railId, 0, price);
        jobId = nextJobId++;
        jobs[jobId] = Job(
            msg.sender, provider, railId, price, deadline, dataSetId, imageDigest, pdp.getNextPieceId(dataSetId),
            JobStatus.Posted, verifier,
            verifier == address(0) ? bytes32(0) : _commitPieces(dataSetId, inputPieceIds)
        );
        jobRemovals[jobId] = removeOnDelivery;
        openJobs[dataSetId][msg.sender][provider]++;
        emit JobPosted(jobId, msg.sender, provider, railId, imageDigest, dataSetId, inputPieceIds, price, deadline);
        if (verifier != address(0)) emit JobNeedsProof(jobId, verifier, jobs[jobId].inputCommitment);
    }

    /// @notice Provider delivers: the output pieces must be live in the client's data set and added after the
    ///         job was posted (so pre-existing pieces cannot be passed off as outputs); the call must happen
    ///         no later than the deadline epoch. Pays the price, then terminates the rail
    ///         (pay-then-terminate order required, test V3).
    function commitOutputs(uint256 jobId, uint256[] calldata outputPieceIds) external {
        commitOutputs(jobId, outputPieceIds, "");
    }

    /// @notice Deliver, with a proof when the job asked for one.
    function commitOutputs(uint256 jobId, uint256[] calldata outputPieceIds, bytes memory proof) public {
        Job storage j = jobs[jobId];
        if (msg.sender != j.provider) revert NotProvider();
        if (j.status != JobStatus.Posted) revert WrongStatus();
        if (block.number > j.deadline) revert DeadlinePassed();
        if (outputPieceIds.length == 0) revert NoOutputs();
        for (uint256 i = 0; i < outputPieceIds.length; i++) {
            if (outputPieceIds[i] < j.firstOutputPieceId) revert OutputNotNew(outputPieceIds[i]);
            if (!pdp.pieceLive(j.dataSetId, outputPieceIds[i])) revert PieceNotLive(j.dataSetId, outputPieceIds[i]);
        }
        // A proof of some other computation is worth nothing, so what is checked is not merely that a proof
        // verifies, but that it verifies against this job's program, this job's inputs, and the pieces being
        // delivered right now.
        if (j.verifier != address(0)) {
            if (!IComputeProofVerifier(j.verifier).verifyComputeProof(
                    j.imageDigest, j.inputCommitment, _commitPieces(j.dataSetId, outputPieceIds), proof)) {
                revert ProofRejected(jobId);
            }
        }
        j.status = JobStatus.Paid;
        openJobs[j.dataSetId][j.client][j.provider]--;
        uint256[] storage removals = jobRemovals[jobId];
        for (uint256 i = 0; i < removals.length; i++) mayRemove[j.dataSetId][j.provider][removals[i]] = true;
        if (removals.length > 0) emit RemovalAllowed(jobId, j.dataSetId, j.provider, removals);
        payments.modifyRailPayment(j.railId, 0, j.price);
        payments.terminateRail(j.railId);
        emit JobPaid(jobId, outputPieceIds, block.number);
    }

    /// @notice The client takes back a removal permission it granted, before the provider has used it.
    ///         A permission is only ever granted by the client, when a job it ordered delivers; this lets the
    ///         client change its mind after seeing the result, for as long as the pieces are still there.
    ///         Permissions already used are gone anyway, so revoking them does nothing.
    function revokeRemoval(uint256 dataSetId, address provider, uint256[] calldata pieceIds) external {
        if (dataSets.getDataSet(dataSetId).payer != msg.sender) revert NotDataSetOwner(dataSetId, msg.sender);
        for (uint256 i = 0; i < pieceIds.length; i++) mayRemove[dataSetId][provider][pieceIds[i]] = false;
        emit RemovalRevoked(dataSetId, provider, pieceIds);
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
        bytes calldata operationData
    ) external returns (bool) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError) return false;
        if (signer == payer) return true;
        if (address(sessionKeys) != address(0) && sessionKeys.authorizationExpiry(payer, signer, operation) >= block.timestamp) {
            return true;
        }
        if (operation == ADD_PIECES_TYPEHASH) {
            return openJobs[dataSetId][payer][signer] > 0 || readySessions[dataSetId][payer][signer] > 0;
        }
        // Removals: only the pieces the client listed with a job that the provider then delivered, once each
        // (FWSS passes abi.encode(clientDataSetId, pieceIds), SignatureVerificationLib L274).
        if (operation == SCHEDULE_PIECE_REMOVALS_TYPEHASH) {
            (, uint256[] memory pieceIds) = abi.decode(operationData, (uint256, uint256[]));
            if (pieceIds.length == 0) return false;
            for (uint256 i = 0; i < pieceIds.length; i++) {
                if (!mayRemove[dataSetId][signer][pieceIds[i]]) return false;
            }
            for (uint256 i = 0; i < pieceIds.length; i++) mayRemove[dataSetId][signer][pieceIds[i]] = false;
            return true;
        }
        return false;
    }
}
