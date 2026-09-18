// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.27;

// Checks of the Filecoin Pay mechanics that the "Compute on FOC" proposal relies on.
// Runs against FilOzone/filecoin-pay pinned at 04ded6a (git submodule lib/filecoin-pay, read-only).
// Roles: CLIENT = C (payer), PROVIDER = P (payee), OPERATOR = the ComputeService contract O
// (simulated here by an address acting as rail operator).
// Each test is named after the guarantee (S1-S3, J1-J3) or mechanic (V1-V5) it checks.

import {Test} from "forge-std/Test.sol";
import {FilecoinPayV1} from "filecoin-pay/src/FilecoinPayV1.sol";
import {PaymentsTestHelpers} from "filecoin-pay/test/helpers/PaymentsTestHelpers.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract ComputeGuaranteesTest is Test {
    PaymentsTestHelpers helper;
    FilecoinPayV1 payments;

    address CLIENT;
    address PROVIDER;
    address OPERATOR;
    IERC20 token;

    uint256 constant R = 1e15; // session rate r, token units per epoch
    uint256 constant L = 10; // session lockup period L, epochs
    uint256 constant P_PRICE = 5e17; // job price p

    function setUp() public {
        helper = new PaymentsTestHelpers();
        helper.setupStandardTestEnvironment();
        payments = helper.payments();
        CLIENT = helper.USER1();
        PROVIDER = helper.USER2();
        OPERATOR = helper.OPERATOR();
        token = helper.testToken();
    }

    // ---------- helpers ----------

    function fee(uint256 gross) internal pure returns (uint256) {
        // NETWORK_FEE = 1/200, rounded up (FilecoinPayV1.sol L54-55, L1085)
        return (gross + 199) / 200;
    }

    function funds(address who) internal view returns (uint256 f) {
        (f,,,) = payments.accounts(token, who);
    }

    function lockupCurrent(address who) internal view returns (uint256 lc) {
        (, lc,,) = payments.accounts(token, who);
    }

    function lockupLastSettledAt(address who) internal view returns (uint256 at) {
        (,,, at) = payments.accounts(token, who);
    }

    function approveOperator() internal {
        helper.setupOperatorApproval(CLIENT, OPERATOR, 100 ether, 100 ether, 1000);
    }

    // openSession as described in the proposal: createRail, lockup period L, rate r
    function openSession() internal returns (uint256 railId) {
        vm.startPrank(OPERATOR);
        railId = payments.createRail(token, CLIENT, PROVIDER, address(0), 0, address(0));
        payments.modifyRailLockup(railId, L, 0);
        payments.modifyRailPayment(railId, R, 0);
        vm.stopPrank();
    }

    // postJob as described in the proposal: createRail, fixed lockup p (escrow)
    function postJob() internal returns (uint256 railId) {
        vm.startPrank(OPERATOR);
        railId = payments.createRail(token, CLIENT, PROVIDER, address(0), 0, address(0));
        payments.modifyRailLockup(railId, 0, P_PRICE);
        vm.stopPrank();
    }

    function settle(uint256 railId) internal returns (uint256 gross) {
        (gross,,,,,) = payments.settleRail(railId, vm.getBlockNumber());
    }

    // ---------- Sessions ----------

    // V1: when the client's funds run out, lockupLastSettledAt stops advancing,
    // and an ACTIVE rail cannot be settled beyond it.
    function test_V1_lockupStopsWhenFundsRunOut() public {
        uint256 N = 20;
        helper.makeDeposit(CLIENT, CLIENT, R * L + R * N); // funds for lockup L plus N epochs
        approveOperator();
        uint256 start = vm.getBlockNumber();
        uint256 railId = openSession();

        helper.advanceBlocks(N + 50);
        uint256 gross = settle(railId);

        assertEq(lockupLastSettledAt(CLIENT), start + N, "lockup should stop at start + N");
        assertEq(gross, R * N, "active rail settles only up to lockupLastSettledAt");
    }

    // S1: even if the client never closes and runs out of funds, the provider obtains r for
    // every epoch up to lockupLastSettledAt + L, by terminating the rail (via the operator).
    function test_S1_providerPaidUpToLockupPlusL() public {
        uint256 N = 20;
        helper.makeDeposit(CLIENT, CLIENT, R * L + R * N);
        approveOperator();
        uint256 railId = openSession();
        uint256 providerBefore = funds(PROVIDER);

        helper.advanceBlocks(N + 50);
        uint256 g1 = settle(railId); // up to lockupLastSettledAt

        vm.prank(OPERATOR); // provider-triggered closeSession, executed by O
        payments.terminateRail(railId);

        helper.advanceBlocks(L + 5);
        uint256 g2 = settle(railId); // up to endEpoch

        assertEq(g1 + g2, R * (N + L), "provider gross = r * (N + L)");
        assertEq(funds(PROVIDER) - providerBefore, (g1 - fee(g1)) + (g2 - fee(g2)), "net of fees");
    }

    // S2 / V2: operator-initiated termination at epoch e_c gives endEpoch = e_c + L
    // when the client is funded; total paid = r * (k + L).
    function test_S2_V2_operatorCloseBoundsClientExposure() public {
        uint256 D = 1 ether;
        helper.makeDeposit(CLIENT, CLIENT, D);
        approveOperator();
        uint256 start = vm.getBlockNumber();
        uint256 railId = openSession();

        uint256 k = 30;
        helper.advanceBlocks(k);
        uint256 closeEpoch = vm.getBlockNumber();
        vm.prank(OPERATOR);
        payments.terminateRail(railId);

        FilecoinPayV1.RailView memory rv = payments.getRail(railId);
        assertEq(rv.endEpoch, closeEpoch + L, "endEpoch = close epoch + L");

        helper.advanceBlocks(L + 100);
        uint256 gross = settle(railId);
        assertEq(gross, R * (closeEpoch - start + L), "client pays r * (k + L)");

        // nothing more can be charged; client funds are free again
        assertEq(lockupCurrent(CLIENT), 0, "no residual lockup after finalization");
        assertEq(funds(CLIENT), D - gross, "client keeps the rest");
    }

    // S2 variant: client-initiated termination (client fully funded) gives the same bound.
    function test_S2_clientCloseBoundsClientExposure() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveOperator();
        uint256 start = vm.getBlockNumber();
        uint256 railId = openSession();

        helper.advanceBlocks(30);
        uint256 closeEpoch = vm.getBlockNumber();
        vm.prank(CLIENT);
        payments.terminateRail(railId);

        helper.advanceBlocks(L + 100);
        uint256 gross = settle(railId);
        assertEq(gross, R * (closeEpoch - start + L), "client pays r * (k + L)");
    }

    // S3: without operator approval no rail can be created; allowances cap rate and lockup period.
    function test_S3_noRailWithoutApproval() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        vm.prank(OPERATOR);
        vm.expectRevert();
        payments.createRail(token, CLIENT, PROVIDER, address(0), 0, address(0));
    }

    function test_S3_rateAllowanceEnforced() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        helper.setupOperatorApproval(CLIENT, OPERATOR, R - 1, 100 ether, 1000); // rate allowance below r
        vm.startPrank(OPERATOR);
        uint256 railId = payments.createRail(token, CLIENT, PROVIDER, address(0), 0, address(0));
        payments.modifyRailLockup(railId, L, 0);
        vm.expectRevert();
        payments.modifyRailPayment(railId, R, 0);
        vm.stopPrank();
    }

    function test_S3_maxLockupPeriodEnforced() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        helper.setupOperatorApproval(CLIENT, OPERATOR, 100 ether, 100 ether, L - 1); // max period below L
        vm.startPrank(OPERATOR);
        uint256 railId = payments.createRail(token, CLIENT, PROVIDER, address(0), 0, address(0));
        vm.expectRevert();
        payments.modifyRailLockup(railId, L, 0);
        vm.stopPrank();
    }

    // V4: opening a session (setting rate r with lockup L) fails if the client cannot fund r * L.
    function test_V4_openSessionRequiresFunds() public {
        helper.makeDeposit(CLIENT, CLIENT, R * L - 1);
        approveOperator();
        vm.startPrank(OPERATOR);
        uint256 railId = payments.createRail(token, CLIENT, PROVIDER, address(0), 0, address(0));
        payments.modifyRailLockup(railId, L, 0);
        vm.expectRevert();
        payments.modifyRailPayment(railId, R, 0);
        vm.stopPrank();
    }

    // V4 variant: a client whose account lockup is no longer fully settled (funds exhausted)
    // cannot open a new session.
    function test_V4_underfundedClientCannotOpenNewSession() public {
        helper.makeDeposit(CLIENT, CLIENT, R * L + R * 5);
        approveOperator();
        openSession();
        helper.advanceBlocks(50); // funds exhausted after 5 epochs

        vm.startPrank(OPERATOR);
        uint256 rail2 = payments.createRail(token, CLIENT, PROVIDER, address(0), 0, address(0));
        vm.expectRevert();
        payments.modifyRailLockup(rail2, L, 0);
        vm.stopPrank();
    }

    // ---------- Batch jobs ----------

    // J1 (order A): one-time payment of p from fixed lockup on the active rail, then terminate.
    function test_J1_payThenTerminate() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveOperator();
        uint256 railId = postJob();
        uint256 providerBefore = funds(PROVIDER);

        vm.startPrank(OPERATOR);
        payments.modifyRailPayment(railId, 0, P_PRICE);
        payments.terminateRail(railId);
        vm.stopPrank();

        assertEq(funds(PROVIDER) - providerBefore, P_PRICE - fee(P_PRICE), "V5: provider gets p minus fee");
        assertEq(funds(CLIENT), 1 ether - P_PRICE, "client charged exactly p");
    }

    // V3 (order B): terminate first, then one-time payment. With lockup period 0 the rail's
    // endEpoch is the termination epoch, so the payment REVERTS
    // (CannotModifyTerminatedRailBeyondEndEpoch). Consequence: jobs must pay, then terminate.
    function test_V3_terminateThenPayReverts() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveOperator();
        uint256 railId = postJob();

        vm.startPrank(OPERATOR);
        payments.terminateRail(railId);
        vm.expectRevert();
        payments.modifyRailPayment(railId, 0, P_PRICE);
        vm.stopPrank();
    }

    // J1 robustness: the one-time payment goes through even if the client's account has since
    // become underfunded by another (session) rail.
    function test_J1_paymentSurvivesClientUnderfunding() public {
        helper.makeDeposit(CLIENT, CLIENT, P_PRICE + R * L + R * 5);
        approveOperator();
        uint256 jobRail = postJob();
        openSession(); // drains the account after 5 epochs
        helper.advanceBlocks(50);

        uint256 providerBefore = funds(PROVIDER);
        vm.prank(OPERATOR);
        payments.modifyRailPayment(jobRail, 0, P_PRICE);
        assertEq(funds(PROVIDER) - providerBefore, P_PRICE - fee(P_PRICE), "escrowed p still paid");
    }

    // J2 / V3: expire = terminate, then reduce fixed lockup to 0; the client can withdraw p.
    function test_J2_expireRefundsEscrow() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveOperator();
        uint256 railId = postJob();
        assertEq(lockupCurrent(CLIENT), P_PRICE, "p escrowed");

        vm.startPrank(OPERATOR);
        payments.terminateRail(railId);
        payments.modifyRailLockup(railId, 0, 0);
        vm.stopPrank();

        assertEq(lockupCurrent(CLIENT), 0, "escrow released");
        vm.prank(CLIENT);
        payments.withdraw(token, 1 ether);
        assertEq(funds(CLIENT), 0, "client withdrew everything, including p");
    }

    // J3: the operator cannot pay more than the escrowed p.
    function test_J3_cannotPayMoreThanEscrow() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveOperator();
        uint256 railId = postJob();
        vm.prank(OPERATOR);
        vm.expectRevert();
        payments.modifyRailPayment(railId, 0, P_PRICE + 1);
    }

    // V5: network fee on rate settlement is ceil(gross / 200).
    function test_V5_settlementFee() public {
        helper.makeDeposit(CLIENT, CLIENT, 1 ether);
        approveOperator();
        uint256 railId = openSession();
        helper.advanceBlocks(7);
        uint256 providerBefore = funds(PROVIDER);
        uint256 gross = settle(railId);
        assertEq(gross, R * 7, "gross = r * epochs");
        assertEq(funds(PROVIDER) - providerBefore, gross - fee(gross), "net = gross - ceil(gross/200)");
    }
}
