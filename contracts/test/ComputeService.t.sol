// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.27;

// Tests of the ComputeService contract itself (src/ComputeService.sol), running against the real
// FilecoinPayV1 (lib/filecoin-pay @ 04ded6a) and MockPDP (stand-in for PDPVerifier.pieceLive).
// Each test names the guarantee from the protocol design it checks (S1-S4, J1-J3).

import {Test} from "forge-std/Test.sol";
import {FilecoinPayV1} from "filecoin-pay/src/FilecoinPayV1.sol";
import {PaymentsTestHelpers} from "filecoin-pay/test/helpers/PaymentsTestHelpers.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ComputeService, IPieceLiveness, ISessionKeyRegistry, IDataSetView} from "../src/ComputeService.sol";
import {MockPDP} from "../src/MockPDP.sol";

contract ComputeServiceTest is Test {
    PaymentsTestHelpers helper;
    FilecoinPayV1 payments;
    IERC20 token;
    MockPDP pdp;
    ComputeService cs;

    address CLIENT;
    address PROVIDER;
    address STRANGER = address(0xBEEF);

    uint256 constant R = 1e15; // session rate r per epoch
    uint256 constant L = 10; // lockup period L
    uint256 constant P_PRICE = 5e17; // job price p
    bytes32 constant IMAGE = keccak256("indexer:v1");
    uint256 dataSetId;

    function setUp() public {
        helper = new PaymentsTestHelpers();
        helper.setupStandardTestEnvironment();
        payments = helper.payments();
        token = helper.testToken();
        CLIENT = helper.USER1();
        PROVIDER = helper.USER2();

        pdp = new MockPDP();
        cs = new ComputeService(payments, token, IPieceLiveness(address(pdp)), ISessionKeyRegistry(address(0)), IDataSetView(address(pdp)));

        // The provider holds the client's data set with two input pieces (ids 0, 1).
        vm.startPrank(PROVIDER);
        dataSetId = pdp.createDataSet(CLIENT);
        pdp.addPiece(dataSetId, "notes.txt", "baga-input-1");
        pdp.addPiece(dataSetId, "papers.pdf", "baga-input-2");
        vm.stopPrank();
    }

    // ---------- helpers ----------

    function fee(uint256 gross) internal pure returns (uint256) {
        return (gross + 199) / 200; // NETWORK_FEE, FilecoinPayV1.sol L54-55
    }

    function funds(address who) internal view returns (uint256 f) {
        (f,,,) = payments.accounts(token, who);
    }

    function lockupCurrent(address who) internal view returns (uint256 lc) {
        (, lc,,) = payments.accounts(token, who);
    }

    function approveCS() internal {
        helper.setupOperatorApproval(CLIENT, address(cs), 100 ether, 100 ether, 1000);
    }

    function railOfSession(uint256 id) internal view returns (uint256 railId) {
        (,, railId,,,,,) = cs.sessions(id);
    }

    function railOfJob(uint256 id) internal view returns (uint256 railId) {
        (,, railId,,,,,,) = cs.jobs(id);
    }

    function settle(uint256 railId) internal returns (uint256 gross) {
        (gross,,,,,) = payments.settleRail(railId, vm.getBlockNumber());
    }

    function inputs() internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;
    }

    function noRemovals() internal pure returns (uint256[] memory) {
        return new uint256[](0);
    }

    function addOutput() internal returns (uint256[] memory ids) {
        vm.prank(PROVIDER);
        uint256 id = pdp.addPiece(dataSetId, "search-index.parquet", "baga-output-1");
        ids = new uint256[](1);
        ids[0] = id;
    }

    function startSession() internal returns (uint256 id, uint256 start) {
        vm.prank(CLIENT);
        id = cs.openSession(PROVIDER, IMAGE, R, L, dataSetId);
        vm.prank(PROVIDER);
        cs.sessionReady(id);
        start = vm.getBlockNumber();
    }

    function postJob(uint256 deadlineIn) internal returns (uint256 id) {
        vm.prank(CLIENT);
        id = cs.postJob(PROVIDER, IMAGE, dataSetId, inputs(), noRemovals(), P_PRICE, vm.getBlockNumber() + deadlineIn);
    }

    // ---------- pay for time ----------

    // Billing starts only at sessionReady: time between openSession and sessionReady is free.
    function test_session_noChargeBeforeReady() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveCS();
        vm.prank(CLIENT);
        uint256 id = cs.openSession(PROVIDER, IMAGE, R, L, dataSetId);
        helper.advanceBlocks(20);
        vm.prank(CLIENT);
        cs.closeSession(id);
        helper.advanceBlocks(L + 5);
        assertEq(settle(railOfSession(id)), 0, "nothing billed before ready");
        assertEq(lockupCurrent(CLIENT), 0, "nothing held");
    }

    // S4: the client stops, pays exactly r * (epochs of service), safety margin released.
    function test_S4_clientCloseStopsPayment() public {
        uint256 D = 1 ether;
        helper.makeDeposit(CLIENT, CLIENT, D);
        approveCS();
        (uint256 id, uint256 start) = startSession();
        assertEq(lockupCurrent(CLIENT), R * L, "safety margin r*L on hold");

        helper.advanceBlocks(30);
        uint256 stopEpoch = vm.getBlockNumber();
        vm.prank(CLIENT);
        cs.closeSession(id);

        helper.advanceBlocks(L + 100);
        uint256 providerBefore = funds(PROVIDER);
        uint256 gross = settle(railOfSession(id));
        assertEq(gross, R * (stopEpoch - start), "exactly the service time");
        assertEq(funds(PROVIDER) - providerBefore, gross - fee(gross), "provider paid net of fee");
        assertEq(funds(CLIENT), D - gross, "client charged exactly the service time");
        assertEq(lockupCurrent(CLIENT), 0, "margin released");
    }

    // S1: client runs out of funds; the provider closes; rate-to-0 is refused, so the rail is only
    // terminated and the provider collects the service time plus the safety margin r*L.
    function test_S1_providerCloseUnfundedClient() public {
        uint256 N = 5;
        helper.makeDeposit(CLIENT, CLIENT, R * L + R * N);
        approveCS();
        (uint256 id,) = startSession();
        helper.advanceBlocks(50);

        vm.prank(PROVIDER);
        cs.closeSession(id);
        helper.advanceBlocks(L + 100);
        uint256 gross = settle(railOfSession(id));
        assertEq(gross, R * (N + L), "provider gets r * (N + L)");
        assertEq(funds(CLIENT), 0, "client deposit fully used, never more");
    }

    // V4 via the contract: the provider cannot start billing an unfunded client.
    function test_session_readyRequiresFunds() public {
        helper.makeDeposit(CLIENT, CLIENT, R * L - 1);
        approveCS();
        vm.prank(CLIENT);
        uint256 id = cs.openSession(PROVIDER, IMAGE, R, L, dataSetId);
        vm.prank(PROVIDER);
        vm.expectRevert();
        cs.sessionReady(id);
    }

    function test_session_onlyProviderSignalsReady() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveCS();
        vm.prank(CLIENT);
        uint256 id = cs.openSession(PROVIDER, IMAGE, R, L, dataSetId);
        vm.prank(CLIENT);
        vm.expectRevert(ComputeService.NotProvider.selector);
        cs.sessionReady(id);
    }

    function test_session_strangerCannotClose() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveCS();
        (uint256 id,) = startSession();
        vm.prank(STRANGER);
        vm.expectRevert(ComputeService.NotParty.selector);
        cs.closeSession(id);
    }

    // S3: without the client's operator approval for ComputeService, no session can be opened.
    function test_S3_noSessionWithoutApproval() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        vm.prank(CLIENT);
        vm.expectRevert();
        cs.openSession(PROVIDER, IMAGE, R, L, dataSetId);
    }

    // ---------- pay per job ----------

    // J1: outputs committed before the deadline -> provider paid p (net of fee), escrow released.
    function test_J1_commitPays() public {
        uint256 D = 1 ether;
        helper.makeDeposit(CLIENT, CLIENT, D);
        approveCS();
        uint256 id = postJob(100);
        assertEq(lockupCurrent(CLIENT), P_PRICE, "p escrowed");

        helper.advanceBlocks(10);
        uint256[] memory outs = addOutput();
        uint256 providerBefore = funds(PROVIDER);
        vm.prank(PROVIDER);
        cs.commitOutputs(id, outs);

        assertEq(funds(PROVIDER) - providerBefore, P_PRICE - fee(P_PRICE), "provider paid p net of fee");
        assertEq(funds(CLIENT), D - P_PRICE, "client paid p");
        assertEq(lockupCurrent(CLIENT), 0, "nothing left on hold");
        assertTrue(pdp.pieceLive(dataSetId, outs[0]), "output stored in the client's data set");
    }

    // J2: nothing delivered by the deadline -> anyone can expire, client gets p back.
    function test_J2_expireRefunds() public {
        uint256 D = 1 ether;
        helper.makeDeposit(CLIENT, CLIENT, D);
        approveCS();
        uint256 id = postJob(100);
        helper.advanceBlocks(101);

        uint256[] memory outs = addOutput();
        vm.prank(PROVIDER);
        vm.expectRevert(ComputeService.DeadlinePassed.selector);
        cs.commitOutputs(id, outs);

        vm.prank(STRANGER);
        cs.expire(id);
        assertEq(lockupCurrent(CLIENT), 0, "escrow released");
        assertEq(funds(CLIENT), D, "client keeps everything");
        vm.prank(CLIENT);
        payments.withdraw(token, D);
    }

    function test_J2_noExpireBeforeDeadline() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveCS();
        uint256 id = postJob(100);
        helper.advanceBlocks(100); // exactly at the deadline: still the provider's time
        vm.expectRevert(ComputeService.DeadlineNotPassed.selector);
        cs.expire(id);
    }

    // J3: a job is paid at most once, and only p.
    function test_J3_paidOnce() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveCS();
        uint256 id = postJob(100);
        uint256[] memory outs = addOutput();
        vm.prank(PROVIDER);
        cs.commitOutputs(id, outs);
        vm.prank(PROVIDER);
        vm.expectRevert(ComputeService.WrongStatus.selector);
        cs.commitOutputs(id, outs);
        vm.expectRevert(ComputeService.WrongStatus.selector);
        cs.expire(id);
    }

    function test_job_inputsMustBeLive() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveCS();
        uint256[] memory bad = new uint256[](1);
        bad[0] = 99;
        vm.prank(CLIENT);
        vm.expectRevert(abi.encodeWithSelector(ComputeService.PieceNotLive.selector, dataSetId, 99));
        cs.postJob(PROVIDER, IMAGE, dataSetId, bad, noRemovals(), P_PRICE, vm.getBlockNumber() + 100);
    }

    function test_job_outputsMustBeLive() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveCS();
        uint256 id = postJob(100);
        uint256[] memory bad = new uint256[](1);
        bad[0] = 99;
        vm.prank(PROVIDER);
        vm.expectRevert(abi.encodeWithSelector(ComputeService.PieceNotLive.selector, dataSetId, 99));
        cs.commitOutputs(id, bad);
    }

    // A piece that was already in the data set (here: an input) cannot be delivered as an output.
    function test_job_outputsMustBeNew() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveCS();
        uint256 id = postJob(100);
        uint256[] memory old = new uint256[](1);
        old[0] = 0;
        vm.prank(PROVIDER);
        vm.expectRevert(abi.encodeWithSelector(ComputeService.OutputNotNew.selector, 0));
        cs.commitOutputs(id, old);
    }

    function test_job_onlyProviderCommits() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveCS();
        uint256 id = postJob(100);
        uint256[] memory outs = addOutput();
        vm.prank(CLIENT);
        vm.expectRevert(ComputeService.NotProvider.selector);
        cs.commitOutputs(id, outs);
    }

    // S3 for jobs: the escrow must fit the client's available funds.
    function test_job_escrowRequiresFunds() public {
        helper.makeDeposit(CLIENT, CLIENT, P_PRICE - 1);
        approveCS();
        vm.prank(CLIENT);
        vm.expectRevert();
        cs.postJob(PROVIDER, IMAGE, dataSetId, inputs(), noRemovals(), P_PRICE, vm.getBlockNumber() + 100);
    }

    // Only the data set's owner can order compute over it...
    function test_job_onlyDataSetOwner() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ComputeService.NotDataSetOwner.selector, dataSetId, STRANGER));
        cs.postJob(PROVIDER, IMAGE, dataSetId, inputs(), noRemovals(), P_PRICE, vm.getBlockNumber() + 100);
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ComputeService.NotDataSetOwner.selector, dataSetId, STRANGER));
        cs.openSession(PROVIDER, IMAGE, R, L, dataSetId);
    }

    // ...and only from the service provider that holds it.
    function test_job_onlyDataSetProvider() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveCS();
        vm.prank(CLIENT);
        vm.expectRevert(abi.encodeWithSelector(ComputeService.NotDataSetProvider.selector, dataSetId, STRANGER));
        cs.postJob(STRANGER, IMAGE, dataSetId, inputs(), noRemovals(), P_PRICE, vm.getBlockNumber() + 100);
    }

    // ---------- replacing files: the client says which pieces the provider may remove once it delivers ----------

    function postJobRemoving(uint256[] memory removals) internal returns (uint256 id) {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveCS();
        vm.prank(CLIENT);
        id = cs.postJob(PROVIDER, IMAGE, dataSetId, inputs(), removals, P_PRICE, vm.getBlockNumber() + 100);
    }

    function one(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    /// The provider may remove the listed pieces only after it has delivered, and only those.
    function test_removals_grantedOnlyOnDelivery() public {
        uint256 id = postJobRemoving(one(0));
        assertFalse(cs.mayRemove(dataSetId, PROVIDER, 0), "nothing before delivery");
        uint256[] memory outs = addOutput();
        vm.prank(PROVIDER);
        cs.commitOutputs(id, outs);
        assertTrue(cs.mayRemove(dataSetId, PROVIDER, 0), "the listed piece");
        assertFalse(cs.mayRemove(dataSetId, PROVIDER, 1), "not a piece the client did not list");
    }

    /// Nothing is removable when the client lists nothing (the default).
    function test_removals_noneByDefault() public {
        uint256 id = postJobRemoving(noRemovals());
        uint256[] memory outs = addOutput();
        vm.prank(PROVIDER);
        cs.commitOutputs(id, outs);
        assertFalse(cs.mayRemove(dataSetId, PROVIDER, 0));
        assertFalse(cs.mayRemove(dataSetId, PROVIDER, 1));
    }

    /// An expired job grants nothing.
    function test_removals_notAfterExpiry() public {
        uint256 id = postJobRemoving(one(0));
        vm.roll(vm.getBlockNumber() + 101);
        cs.expire(id);
        assertFalse(cs.mayRemove(dataSetId, PROVIDER, 0));
    }

    /// Through the authorizer: the delivering provider's signature passes once, for the listed pieces only.
    function test_removals_authorizerAcceptsOnceForTheProvider() public {
        uint256 pk = 0xA11CE;
        address signer = vm.addr(pk);
        vm.startPrank(signer);
        uint256 ds = pdp.createDataSet(CLIENT);
        pdp.addPiece(ds, "notes.txt", "baga-1");
        pdp.addPiece(ds, "papers.pdf", "baga-2");
        vm.stopPrank();

        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveCS();
        vm.prank(CLIENT);
        uint256 id = cs.postJob(signer, IMAGE, ds, inputs(), one(0), P_PRICE, vm.getBlockNumber() + 100);

        bytes32 digest = keccak256("a schedule-removals digest");
        (uint8 v, bytes32 r, bytes32 sSig) = vm.sign(pk, digest);
        bytes memory sig = abi.encodePacked(r, sSig, v);
        bytes memory data = abi.encode(uint256(1), one(0)); // FWSS sends (clientDataSetId, pieceIds)

        assertFalse(cs.isAuthorized(ds, CLIENT, cs.SCHEDULE_PIECE_REMOVALS_TYPEHASH(), digest, sig, data), "before delivery");

        vm.prank(signer);
        uint256 outId = pdp.addPiece(ds, "search-index.parquet", "baga-out");
        vm.prank(signer);
        cs.commitOutputs(id, one(outId));

        assertTrue(cs.isAuthorized(ds, CLIENT, cs.SCHEDULE_PIECE_REMOVALS_TYPEHASH(), digest, sig, data), "after delivery");
        assertFalse(cs.isAuthorized(ds, CLIENT, cs.SCHEDULE_PIECE_REMOVALS_TYPEHASH(), digest, sig, data), "only once");
        assertFalse(
            cs.isAuthorized(ds, CLIENT, cs.SCHEDULE_PIECE_REMOVALS_TYPEHASH(), digest, sig, abi.encode(uint256(1), one(1))),
            "not a piece the client did not list"
        );
    }

    /// The client can take a permission back, as long as the provider has not used it.
    function test_removals_clientCanRevoke() public {
        uint256 id = postJobRemoving(one(0));
        uint256[] memory outs = addOutput();
        vm.prank(PROVIDER);
        cs.commitOutputs(id, outs);
        assertTrue(cs.mayRemove(dataSetId, PROVIDER, 0), "granted on delivery");

        vm.prank(CLIENT);
        cs.revokeRemoval(dataSetId, PROVIDER, one(0));
        assertFalse(cs.mayRemove(dataSetId, PROVIDER, 0), "taken back");
    }

    /// Only the client who pays for the data set can revoke.
    function test_removals_onlyTheClientRevokes() public {
        uint256 id = postJobRemoving(one(0));
        uint256[] memory outs = addOutput();
        vm.prank(PROVIDER);
        cs.commitOutputs(id, outs);

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ComputeService.NotDataSetOwner.selector, dataSetId, STRANGER));
        cs.revokeRemoval(dataSetId, PROVIDER, one(0));
        assertTrue(cs.mayRemove(dataSetId, PROVIDER, 0), "still granted");
    }

    /// The client removing its own files needs no grant at all: it pays for the data set, so its own signature
    /// is enough, for any piece, as often as it likes. This is the path the client console uses.
    function test_removals_clientSignsForItsOwnFiles() public {
        uint256 pk = 0xC11E27;
        address client = vm.addr(pk);
        vm.startPrank(PROVIDER);
        uint256 ds = pdp.createDataSet(client);
        pdp.addPiece(ds, "notes.txt", "baga-1");
        pdp.addPiece(ds, "papers.pdf", "baga-2");
        vm.stopPrank();

        bytes32 digest = keccak256("the client's own schedule-removals digest");
        (uint8 v, bytes32 r, bytes32 sSig) = vm.sign(pk, digest);
        bytes memory sig = abi.encodePacked(r, sSig, v);

        // no job, no delivery, nothing granted to anyone
        assertFalse(cs.mayRemove(ds, PROVIDER, 0), "the provider may not");
        assertTrue(
            cs.isAuthorized(ds, client, cs.SCHEDULE_PIECE_REMOVALS_TYPEHASH(), digest, sig, abi.encode(uint256(1), one(0))),
            "the client may"
        );
        assertTrue(
            cs.isAuthorized(ds, client, cs.SCHEDULE_PIECE_REMOVALS_TYPEHASH(), digest, sig, abi.encode(uint256(1), one(1))),
            "any piece of its own"
        );
        assertTrue(
            cs.isAuthorized(ds, client, cs.SCHEDULE_PIECE_REMOVALS_TYPEHASH(), digest, sig, abi.encode(uint256(1), one(0))),
            "as often as it likes"
        );

        // somebody else's signature is still refused
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(uint256(0xBAD), digest);
        assertFalse(
            cs.isAuthorized(ds, client, cs.SCHEDULE_PIECE_REMOVALS_TYPEHASH(), digest, abi.encodePacked(r2, s2, v2), abi.encode(uint256(1), one(0))),
            "a stranger may not"
        );
    }
}
