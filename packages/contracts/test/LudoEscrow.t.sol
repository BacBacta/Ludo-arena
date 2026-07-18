// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {LudoEscrow, IERC20} from "../src/LudoEscrow.sol";

contract MockERC20 is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external { allowance[msg.sender][spender] = amount; }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] < amount || balanceOf[from] < amount) return false;
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balanceOf[msg.sender] < amount) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract LudoEscrowTest is Test {
    LudoEscrow esc;
    MockERC20 cusd;
    uint256 arbiterPk = 0xA11CE;
    address arbiter;
    address treasury = address(0xBEEF);
    address alice = address(0xA);
    address bob = address(0xB);
    bytes32 gameId = keccak256("game-1");

    function setUp() public {
        arbiter = vm.addr(arbiterPk);
        esc = new LudoEscrow(arbiter, treasury, 900);
        cusd = new MockERC20();
        vm.prank(treasury); esc.setTokenAllowed(address(cusd), true); // owner allowlists the stablecoin
        cusd.mint(alice, 10e18);
        cusd.mint(bob, 10e18);
        vm.prank(alice); cusd.approve(address(esc), type(uint256).max);
        vm.prank(bob); cusd.approve(address(esc), type(uint256).max);
    }

    function _sign(bytes32 id, address winner) internal view returns (bytes memory) {
        bytes32 digest = esc.settlementDigest(id, winner);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function testFullFlow() public {
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(cusd), 1e18, bytes32(0));

        esc.settle(gameId, alice, "", "", "", _sign(gameId, alice));

        // pot 2e18, rake 9 % = 0.18e18, payout 1.82e18
        assertEq(cusd.balanceOf(alice), 10e18 - 1e18 + 1.82e18);
        assertEq(cusd.balanceOf(treasury), 0.18e18);
    }

    function testCannotSettleTwice() public {
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        esc.settle(gameId, alice, "", "", "", _sign(gameId, alice));
        // sig computed first: forge's expectRevert applies to the very next call.
        bytes memory sig = _sign(gameId, alice);
        vm.expectRevert(LudoEscrow.BadStatus.selector);
        esc.settle(gameId, alice, "", "", "", sig);
    }

    function testBadSignatureRejected() public {
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, esc.settlementDigest(gameId, alice));
        vm.expectRevert(LudoEscrow.BadSignature.selector);
        esc.settle(gameId, alice, "", "", "", abi.encodePacked(r, s, v));
    }

    function testWinnerMustBePlayer() public {
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        bytes memory sig = _sign(gameId, address(0xDEAD));
        vm.expectRevert(LudoEscrow.NotAPlayer.selector);
        esc.settle(gameId, address(0xDEAD), "", "", "", sig);
    }

    function testRefundExpired() public {
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        vm.expectRevert(LudoEscrow.NotExpired.selector);
        esc.refundExpired(gameId);
        vm.warp(block.timestamp + 121);
        esc.refundExpired(gameId);
        assertEq(cusd.balanceOf(alice), 10e18);
    }

    function testStakeMustMatch() public {
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        vm.prank(bob);
        vm.expectRevert(LudoEscrow.BadStake.selector);
        esc.join(gameId, address(cusd), 2e18, bytes32(0));
    }

    // ---- rescue paths (stuck Active games) ----

    function testVoidGameRefundsBothPlayers() public {
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        vm.prank(arbiter); esc.voidGame(gameId);
        assertEq(cusd.balanceOf(alice), 10e18);
        assertEq(cusd.balanceOf(bob), 10e18);
        // cannot settle a voided game
        bytes memory sig = _sign(gameId, alice);
        vm.expectRevert(LudoEscrow.BadStatus.selector);
        esc.settle(gameId, alice, "", "", "", sig);
    }

    function testVoidGameOnlyArbiter() public {
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        vm.prank(alice);
        vm.expectRevert(LudoEscrow.NotArbiter.selector);
        esc.voidGame(gameId);
    }

    function testRefundActiveAfterTimeout() public {
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        vm.expectRevert(LudoEscrow.NotExpired.selector);
        esc.refundActive(gameId);
        vm.warp(block.timestamp + 24 hours + 1);
        esc.refundActive(gameId); // permissionless
        assertEq(cusd.balanceOf(alice), 10e18);
        assertEq(cusd.balanceOf(bob), 10e18);
    }

    function testMalleableSignatureRejected() public {
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, esc.settlementDigest(gameId, alice));
        // flip the canonical low-s sig into its high-s malleable twin; must reject
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(n - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        vm.expectRevert(LudoEscrow.BadSignature.selector);
        esc.settle(gameId, alice, "", "", "", abi.encodePacked(r, highS, flippedV));
    }

    // ---- governable rake (rec 3) ----

    function testOwnerDefaultsToTreasury() public view {
        assertEq(esc.owner(), treasury);
    }

    function testSetRakeBpsChangesPayout() public {
        vm.prank(treasury); esc.setRakeBps(0); // 0%-rake acquisition promo
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(cusd), 1e18, bytes32(0));
        esc.settle(gameId, alice, "", "", "", _sign(gameId, alice));
        // no rake: winner takes the full pot, treasury untouched
        assertEq(cusd.balanceOf(alice), 10e18 - 1e18 + 2e18);
        assertEq(cusd.balanceOf(treasury), 0);
    }

    function testSetRakeBpsOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(LudoEscrow.NotOwner.selector);
        esc.setRakeBps(100);
    }

    function testSetRakeBpsCapEnforced() public {
        vm.prank(treasury);
        vm.expectRevert(bytes("rake > max"));
        esc.setRakeBps(1001); // > MAX_RAKE_BPS (1000)
    }

    function testTransferOwnership() public {
        vm.prank(treasury); esc.transferOwnership(alice);
        assertEq(esc.owner(), alice);
        // old owner can no longer govern
        vm.prank(treasury);
        vm.expectRevert(LudoEscrow.NotOwner.selector);
        esc.setRakeBps(100);
        // new owner can
        vm.prank(alice); esc.setRakeBps(100);
        assertEq(esc.rakeBps(), 100);
    }

    // ---- batch settlement (rec 5) ----

    function testSettleBatchSettlesAll() public {
        bytes32 g1 = keccak256("b1");
        bytes32 g2 = keccak256("b2");
        vm.prank(alice); esc.join(g1, address(cusd), 1e18, bytes32(0));
        vm.prank(bob); esc.join(g1, address(cusd), 1e18, bytes32(0));
        vm.prank(alice); esc.join(g2, address(cusd), 1e18, bytes32(0));
        vm.prank(bob); esc.join(g2, address(cusd), 1e18, bytes32(0));

        bytes32[] memory ids = new bytes32[](2);
        address[] memory winners = new address[](2);
        bytes[] memory sigs = new bytes[](2);
        ids[0] = g1; winners[0] = alice; sigs[0] = _sign(g1, alice);
        ids[1] = g2; winners[1] = bob; sigs[1] = _sign(g2, bob);
        esc.settleBatch(ids, winners, sigs);

        // rake taken on both pots (0.18e18 each); each player won one of the two
        assertEq(cusd.balanceOf(treasury), 0.36e18);
        assertEq(cusd.balanceOf(alice), 10e18 - 2e18 + 1.82e18);
        assertEq(cusd.balanceOf(bob), 10e18 - 2e18 + 1.82e18);
    }

    function testSettleBatchLengthMismatchReverts() public {
        bytes32[] memory ids = new bytes32[](2);
        address[] memory winners = new address[](1);
        bytes[] memory sigs = new bytes[](2);
        vm.expectRevert(LudoEscrow.LengthMismatch.selector);
        esc.settleBatch(ids, winners, sigs);
    }

    function testSettleBatchAtomicOnBadEntry() public {
        bytes32 g1 = keccak256("b1");
        vm.prank(alice); esc.join(g1, address(cusd), 1e18, bytes32(0));
        vm.prank(bob); esc.join(g1, address(cusd), 1e18, bytes32(0));
        // second entry references an un-Active game → whole batch reverts, g1 unpaid
        bytes32[] memory ids = new bytes32[](2);
        address[] memory winners = new address[](2);
        bytes[] memory sigs = new bytes[](2);
        ids[0] = g1; winners[0] = alice; sigs[0] = _sign(g1, alice);
        ids[1] = keccak256("ghost"); winners[1] = alice; sigs[1] = _sign(keccak256("ghost"), alice);
        vm.expectRevert(LudoEscrow.BadStatus.selector);
        esc.settleBatch(ids, winners, sigs);
        // g1 remains Active and unpaid (atomic all-or-nothing)
        assertEq(cusd.balanceOf(treasury), 0);
    }
}
