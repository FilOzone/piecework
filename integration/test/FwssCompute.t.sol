// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.27;

// ComputeService with the real FOC contracts, at the versions deployed on calibnet and mainnet
// (FilOzone/filecoin-services @ 4cbbea4 = FWSS v1.4.0; its PDPVerifier; Filecoin Pay v1.0.0).
// Nothing is mocked except the USDFC token and the FVM precompiles (FilOz's MockFVMTest, as in PDP's own tests). Signatures are real (EIP-712, signed with test keys).
//
// What is checked: job outputs can be added to the client's own FWSS data set by the provider, without
// the client signing each time, because the client attached ComputeService as the data set's authorizer
// (FWSS.setDataSetAuthorizer). The window is exactly "while a job is open".

import {MockFVMTest} from "@fvm-solidity/mocks/MockFVMTest.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {FilecoinPayV1} from "@fws-payments/FilecoinPayV1.sol";
import {PDPVerifier} from "@pdp/PDPVerifier.sol";
import {Cids} from "@pdp/Cids.sol";
import {SessionKeyRegistry} from "@session-key-registry/SessionKeyRegistry.sol";
import {FilecoinWarmStorageService} from "fwss/FilecoinWarmStorageService.sol";
import {FilecoinWarmStorageServiceStateView} from "fwss/FilecoinWarmStorageServiceStateView.sol";
import {ServiceProviderRegistry} from "fwss/ServiceProviderRegistry.sol";
import {ServiceProviderRegistryStorage} from "fwss/ServiceProviderRegistryStorage.sol";
import {SignatureVerificationLib} from "fwss/lib/SignatureVerificationLib.sol";
import {PDPOffering} from "fwss-test/PDPOffering.sol";
import {Errors} from "fwss/Errors.sol";
import {ComputeService, IPieceLiveness, ISessionKeyRegistry} from "focc/ComputeService.sol";

contract TestUSDFC is ERC20 {
    constructor() ERC20("USDFC", "USDFC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract FwssComputeTest is MockFVMTest {
    using PDPOffering for PDPOffering.Schema;

    TestUSDFC usdfc;
    FilecoinPayV1 payments;
    SessionKeyRegistry skr;
    PDPVerifier pdp;
    ServiceProviderRegistry registry;
    FilecoinWarmStorageService fwss;
    ComputeService cs;

    uint256 constant CLIENT_PK = 0xC11E17;
    uint256 constant PROVIDER_PK = 0xB0B;
    address client;
    address provider;

    uint256 constant CLIENT_DATA_SET_ID = 1;
    uint256 dataSetId;
    uint256 nextNonce = 100;

    uint256 constant P_PRICE = 5e17;
    bytes4 constant OK = bytes4(0);
    bytes32 constant IMAGE = keccak256("indexer:v1");

    function setUp() public override {
        super.setUp();
        client = vm.addr(CLIENT_PK);
        provider = vm.addr(PROVIDER_PK);
        vm.deal(client, 100 ether);
        vm.deal(provider, 100 ether);

        usdfc = new TestUSDFC();
        payments = new FilecoinPayV1();
        skr = new SessionKeyRegistry();

        PDPVerifier pdpImpl = new PDPVerifier(1, 2);
        pdp = PDPVerifier(address(new ERC1967Proxy(address(pdpImpl), abi.encodeCall(PDPVerifier.initialize, ()))));

        ServiceProviderRegistry regImpl = new ServiceProviderRegistry(1);
        registry = ServiceProviderRegistry(
            address(new ERC1967Proxy(address(regImpl), abi.encodeCall(ServiceProviderRegistry.initialize, ())))
        );

        FilecoinWarmStorageService fwssImpl = new FilecoinWarmStorageService(
            address(pdp), address(payments), usdfc, address(0xBEEF), registry, skr, 1
        );
        fwss = FilecoinWarmStorageService(
            address(
                new ERC1967Proxy(
                    address(fwssImpl),
                    abi.encodeCall(FilecoinWarmStorageService.initialize, (uint64(2880), uint256(60), address(0xCAFE)))
                )
            )
        );
        fwss.setViewContract(address(new FilecoinWarmStorageServiceStateView(fwss)));

        cs = new ComputeService(payments, usdfc, IPieceLiveness(address(pdp)), ISessionKeyRegistry(address(skr)));

        // provider registers (PDP product) and is approved by FWSS
        PDPOffering.Schema memory offer = PDPOffering.Schema({
            serviceURL: "https://provider.example",
            minPieceSizeInBytes: 127,
            maxPieceSizeInBytes: 1 << 30,
            ipniPiece: true,
            ipniIpfs: false,
            storagePricePerTibPerDay: 1 ether,
            minProvingPeriodInEpochs: 2880,
            location: "local",
            paymentTokenAddress: IERC20(address(0))
        });
        (string[] memory keys, bytes[] memory values) = offer.toCapabilities();
        vm.prank(provider);
        uint256 providerId = registry.registerProvider{value: 5 ether}(
            provider, "provider", "local provider", ServiceProviderRegistryStorage.ProductType.PDP, keys, values
        );
        fwss.addApprovedProvider(providerId);

        // client funds Filecoin Pay and approves both operators: FWSS (storage) and ComputeService (compute)
        usdfc.mint(client, 100 ether);
        vm.startPrank(client);
        usdfc.approve(address(payments), 100 ether);
        payments.deposit(usdfc, client, 50 ether);
        payments.setOperatorApproval(usdfc, address(fwss), true, 10 ether, 50 ether, 1 << 40);
        payments.setOperatorApproval(usdfc, address(cs), true, 10 ether, 50 ether, 10000);
        vm.stopPrank();

        // the client's data set, created by the provider with the client's signature, with 2 input pieces
        dataSetId = createDataSet();
        addPieces(CLIENT_PK, piece("notes.txt"), OK);
        addPieces(CLIENT_PK, piece("papers.pdf"), OK);
    }

    // ---------------------------------------------------------------- helpers

    function domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("FilecoinWarmStorageService"),
                keccak256("1"),
                block.chainid,
                address(fwss)
            )
        );
    }

    function sign(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function piece(string memory name) internal pure returns (Cids.Cid[] memory p) {
        p = new Cids.Cid[](1);
        p[0] = Cids.CommPv2FromDigest(0, 4, keccak256(bytes(name)));
    }

    function createDataSet() internal returns (uint256 id) {
        string[] memory k = new string[](0);
        string[] memory v = new string[](0);
        bytes memory sig = sign(CLIENT_PK, SignatureVerificationLib.createDataSetStructHash(CLIENT_DATA_SET_ID, provider, k, v));
        vm.prank(provider);
        id = pdp.createDataSet{value: 1 ether}(address(fwss), abi.encode(client, CLIENT_DATA_SET_ID, k, v, sig));
    }

    // provider submits addPieces; `signerPk` signs the FWSS AddPieces message (client, or provider for outputs)
    function addPieces(uint256 signerPk, Cids.Cid[] memory pieces, bytes4 expectRevert) internal returns (uint256 firstId) {
        string[][] memory k = new string[][](0);
        string[][] memory v = new string[][](0);
        uint256 nonce = nextNonce++;
        bytes memory sig =
            sign(signerPk, SignatureVerificationLib.addPiecesStructHash(CLIENT_DATA_SET_ID, nonce, pieces, k, v));
        firstId = pdp.getNextPieceId(dataSetId);
        vm.prank(provider);
        if (expectRevert != bytes4(0)) vm.expectPartialRevert(expectRevert);
        pdp.addPieces(dataSetId, address(0), pieces, abi.encode(nonce, k, v, sig));
    }

    function inputs() internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;
    }

    function postJob() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = cs.postJob(provider, IMAGE, dataSetId, inputs(), P_PRICE, vm.getBlockNumber() + 100);
    }

    function attachAuthorizer() internal {
        vm.prank(client);
        fwss.setDataSetAuthorizer(dataSetId, address(cs));
    }

    function funds(address who) internal view returns (uint256 f) {
        (f,,,) = payments.accounts(usdfc, who);
    }

    function one(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    // ---------------------------------------------------------------- tests

    // Real PDP: input pieces are live, the job is posted on them.
    function test_inputsAreLiveInRealPDP() public {
        assertTrue(pdp.pieceLive(dataSetId, 0));
        assertTrue(pdp.pieceLive(dataSetId, 1));
        assertEq(pdp.getNextPieceId(dataSetId), 2);
        uint256 jobId = postJob();
        assertEq(jobId, 1);
    }

    // Without the authorizer, FWSS refuses pieces signed by the provider: outputs need the client's authorization.
    function test_withoutAuthorizer_providerCannotAddOutputs() public {
        postJob();
        addPieces(PROVIDER_PK, piece("search-index.txt"), Errors.InvalidSignature.selector);
    }

    // The full job on real FOC contracts: the provider adds the output to the client's data set (approved by
    // ComputeService as authorizer), commits it, and is paid through Filecoin Pay (J1).
    function test_J1_outputViaAuthorizer_thenPaid() public {
        attachAuthorizer();
        uint256 jobId = postJob();
        uint256 outId = addPieces(PROVIDER_PK, piece("search-index.txt"), OK);
        assertTrue(pdp.pieceLive(dataSetId, outId), "output stored as a new piece of the client's data set");

        uint256 before = funds(provider);
        vm.prank(provider);
        cs.commitOutputs(jobId, one(outId));
        assertEq(funds(provider) - before, P_PRICE - (P_PRICE + 199) / 200, "provider paid p net of network fee");
        assertEq(cs.openJobs(dataSetId, client, provider), 0, "window closed");
    }

    // After the job is paid, the provider can no longer add pieces to the client's data set.
    function test_windowClosesAfterCommit() public {
        attachAuthorizer();
        uint256 jobId = postJob();
        uint256 outId = addPieces(PROVIDER_PK, piece("search-index.txt"), OK);
        vm.prank(provider);
        cs.commitOutputs(jobId, one(outId));
        addPieces(PROVIDER_PK, piece("sneaky.bin"), Errors.Unauthorized.selector);
    }

    // ...and after the job expires.
    function test_windowClosesAfterExpire() public {
        attachAuthorizer();
        uint256 jobId = postJob();
        vm.roll(vm.getBlockNumber() + 101);
        cs.expire(jobId);
        addPieces(PROVIDER_PK, piece("late.txt"), Errors.Unauthorized.selector);
    }

    // With no open job, the provider cannot add pieces even with the authorizer attached.
    function test_noJob_providerCannotAdd() public {
        attachAuthorizer();
        addPieces(PROVIDER_PK, piece("unasked.txt"), Errors.Unauthorized.selector);
    }

    // The client's own uploads keep working with the authorizer attached.
    function test_clientStillAddsWithAuthorizer() public {
        attachAuthorizer();
        uint256 id = addPieces(CLIENT_PK, piece("my-new-file.txt"), OK);
        assertTrue(pdp.pieceLive(dataSetId, id));
    }

    // A job opened by someone else on this data set does not open a window: the count is per data set payer.
    function test_otherClientsJobDoesNotOpenWindow() public {
        attachAuthorizer();
        address mallory = address(0xBAD);
        usdfc.mint(mallory, 10 ether);
        vm.startPrank(mallory);
        usdfc.approve(address(payments), 10 ether);
        payments.deposit(usdfc, mallory, 10 ether);
        payments.setOperatorApproval(usdfc, address(cs), true, 1 ether, 10 ether, 10000);
        cs.postJob(provider, IMAGE, dataSetId, inputs(), P_PRICE, vm.getBlockNumber() + 100);
        vm.stopPrank();
        addPieces(PROVIDER_PK, piece("injected.txt"), Errors.Unauthorized.selector);
    }

    // Pieces that existed before the job cannot be claimed as outputs (fix from stage A), on real PDP.
    function test_oldPieceIsNotAnOutput() public {
        attachAuthorizer();
        uint256 jobId = postJob();
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(ComputeService.OutputNotNew.selector, 1));
        cs.commitOutputs(jobId, one(1));
    }

    // The client's session keys (e.g. filecoin-pin's login) keep working with the authorizer attached,
    // and stop working once revoked.
    function test_clientSessionKeyStillWorks() public {
        attachAuthorizer();
        uint256 sessionPk = 0x5E55;
        bytes32[] memory perms = new bytes32[](1);
        perms[0] = cs.ADD_PIECES_TYPEHASH();
        vm.prank(client);
        skr.login(vm.addr(sessionPk), block.timestamp + 1 days, perms, "test");
        uint256 id = addPieces(sessionPk, piece("uploaded-with-session-key.txt"), OK);
        assertTrue(pdp.pieceLive(dataSetId, id));

        vm.prank(client);
        skr.revoke(vm.addr(sessionPk), perms, "test");
        addPieces(sessionPk, piece("after-revoke.txt"), Errors.Unauthorized.selector);
    }
}
