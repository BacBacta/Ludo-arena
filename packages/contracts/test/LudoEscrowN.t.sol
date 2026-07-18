// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {LudoEscrowN, IERC20} from "../src/LudoEscrowN.sol";

contract MockERC20 is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

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

contract LudoEscrowNTest is Test {
    LudoEscrowN esc;
    MockERC20 cusd;
    uint256 arbiterPk = 0xA11CE;
    address arbiter;
    address treasury = address(0xBEEF);
    address alice = address(0xA);
    address bob = address(0xB);
    address carol = address(0xC);
    address dave = address(0xD);
    bytes32 gameId = keccak256("game-1");
    uint96 constant STAKE = 1e18;

    function setUp() public {
        arbiter = vm.addr(arbiterPk);
        esc = new LudoEscrowN(arbiter, treasury, 900);
        cusd = new MockERC20();
        vm.prank(treasury); esc.setTokenAllowed(address(cusd), true); // owner allowlists the stablecoin
        address[4] memory ps = [alice, bob, carol, dave];
        for (uint256 i = 0; i < ps.length; i++) {
            cusd.mint(ps[i], 10e18);
            vm.prank(ps[i]);
            cusd.approve(address(esc), type(uint256).max);
        }
    }

    function _sign(bytes32 id, address winner) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, esc.settlementDigest(id, winner));
        return abi.encodePacked(r, s, v);
    }

    function _joinFour() internal {
        vm.prank(alice); esc.join(gameId, address(cusd), STAKE, 4, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(cusd), STAKE, 4, bytes32(0));
        vm.prank(carol); esc.join(gameId, address(cusd), STAKE, 4, bytes32(0));
        vm.prank(dave); esc.join(gameId, address(cusd), STAKE, 4, bytes32(0));
    }

    // ---- happy path ----

    function testFourPlayerFullFlow() public {
        _joinFour();
        (,,, uint8 joined,, LudoEscrowN.Status status,,) = esc.games(gameId);
        assertEq(joined, 4);
        assertEq(uint256(status), uint256(LudoEscrowN.Status.Active));

        esc.settle(gameId, carol, "", new string[](0), _sign(gameId, carol));

        // pot 4e18, rake 9% = 0.36e18, payout 3.64e18
        assertEq(cusd.balanceOf(carol), 10e18 - 1e18 + 3.64e18);
        assertEq(cusd.balanceOf(treasury), 0.36e18);
        // losers each down exactly one stake
        assertEq(cusd.balanceOf(alice), 9e18);
        assertEq(cusd.balanceOf(bob), 9e18);
        assertEq(cusd.balanceOf(dave), 9e18);
    }

    function testPotEqualsPayoutPlusRake() public {
        _joinFour();
        uint256 before = cusd.balanceOf(address(esc));
        assertEq(before, 4e18);
        esc.settle(gameId, alice, "", new string[](0), _sign(gameId, alice));
        // escrow fully drained: payout + rake == pot
        assertEq(cusd.balanceOf(address(esc)), 0);
    }

    function testSeatsOfReturnsDepositors() public {
        _joinFour();
        address[] memory seats = esc.seatsOf(gameId);
        assertEq(seats.length, 4);
        assertEq(seats[0], alice);
        assertEq(seats[3], dave);
    }

    function testTwoAndThreeSeatGamesWork() public {
        bytes32 g2 = keccak256("g2");
        vm.prank(alice); esc.join(g2, address(cusd), STAKE, 2, bytes32(0));
        vm.prank(bob); esc.join(g2, address(cusd), STAKE, 2, bytes32(0));
        esc.settle(g2, bob, "", new string[](0), _sign(g2, bob));
        assertEq(cusd.balanceOf(bob), 10e18 - 1e18 + 1.82e18);

        bytes32 g3 = keccak256("g3");
        vm.prank(alice); esc.join(g3, address(cusd), STAKE, 3, bytes32(0));
        vm.prank(bob); esc.join(g3, address(cusd), STAKE, 3, bytes32(0));
        vm.prank(carol); esc.join(g3, address(cusd), STAKE, 3, bytes32(0));
        esc.settle(g3, alice, "", new string[](0), _sign(g3, alice));
        // g3: pot 3e18, rake 0.27e18. Treasury accumulates g2 (0.18) + g3 (0.27).
        assertEq(cusd.balanceOf(treasury), 0.18e18 + 0.27e18);
    }

    // ---- guards ----

    function testCannotSettleBeforeActive() public {
        vm.prank(alice); esc.join(gameId, address(cusd), STAKE, 4, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(cusd), STAKE, 4, bytes32(0));
        // sig computed first: forge's expectRevert applies to the very next call.
        bytes memory sig = _sign(gameId, alice);
        vm.expectRevert(LudoEscrowN.BadStatus.selector);
        esc.settle(gameId, alice, "", new string[](0), sig);
    }

    function testCannotSettleTwice() public {
        _joinFour();
        esc.settle(gameId, alice, "", new string[](0), _sign(gameId, alice));
        bytes memory sig = _sign(gameId, alice);
        vm.expectRevert(LudoEscrowN.BadStatus.selector);
        esc.settle(gameId, alice, "", new string[](0), sig);
    }

    function testWinnerMustBeADepositor() public {
        _joinFour();
        bytes memory sig = _sign(gameId, address(0xDEAD));
        vm.expectRevert(LudoEscrowN.NotAPlayer.selector);
        esc.settle(gameId, address(0xDEAD), "", new string[](0), sig);
    }

    function testBadSignatureRejected() public {
        _joinFour();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, esc.settlementDigest(gameId, alice));
        vm.expectRevert(LudoEscrowN.BadSignature.selector);
        esc.settle(gameId, alice, "", new string[](0), abi.encodePacked(r, s, v));
    }

    function testHighSSignatureRejected() public {
        _joinFour();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, esc.settlementDigest(gameId, alice));
        // flip s to the high half of the curve → malleable, must be rejected
        uint256 N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        vm.expectRevert(LudoEscrowN.BadSignature.selector);
        esc.settle(gameId, alice, "", new string[](0), abi.encodePacked(r, highS, flippedV));
    }

    function testBadSeatCountRejected() public {
        vm.prank(alice);
        vm.expectRevert(LudoEscrowN.BadSeatCount.selector);
        esc.join(gameId, address(cusd), STAKE, 5, bytes32(0)); // > MAX_SEATS
        vm.prank(alice);
        vm.expectRevert(LudoEscrowN.BadSeatCount.selector);
        esc.join(gameId, address(cusd), STAKE, 1, bytes32(0)); // < MIN_SEATS
    }

    function testMismatchedParamsRejected() public {
        vm.prank(alice); esc.join(gameId, address(cusd), STAKE, 4, bytes32(0));
        vm.prank(bob);
        vm.expectRevert(LudoEscrowN.BadStake.selector);
        esc.join(gameId, address(cusd), 2e18, 4, bytes32(0)); // wrong stake
        vm.prank(bob);
        vm.expectRevert(LudoEscrowN.BadStake.selector);
        esc.join(gameId, address(cusd), STAKE, 3, bytes32(0)); // wrong seatCount
    }

    function testCannotJoinTwice() public {
        vm.prank(alice); esc.join(gameId, address(cusd), STAKE, 4, bytes32(0));
        vm.prank(alice);
        vm.expectRevert(LudoEscrowN.AlreadyJoined.selector);
        esc.join(gameId, address(cusd), STAKE, 4, bytes32(0));
    }

    function testCannotJoinActiveGame() public {
        _joinFour();
        vm.prank(alice);
        vm.expectRevert(LudoEscrowN.BadStatus.selector);
        esc.join(gameId, address(cusd), STAKE, 4, bytes32(0));
    }

    // ---- refunds ----

    function testRefundUnfilled() public {
        vm.prank(alice); esc.join(gameId, address(cusd), STAKE, 4, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(cusd), STAKE, 4, bytes32(0));
        vm.expectRevert(LudoEscrowN.NotExpired.selector);
        esc.refundUnfilled(gameId);
        vm.warp(block.timestamp + 121);
        esc.refundUnfilled(gameId);
        assertEq(cusd.balanceOf(alice), 10e18);
        assertEq(cusd.balanceOf(bob), 10e18);
    }

    function testCannotRefundUnfilledOnceActive() public {
        _joinFour();
        vm.warp(block.timestamp + 121);
        vm.expectRevert(LudoEscrowN.BadStatus.selector);
        esc.refundUnfilled(gameId);
    }

    function testVoidGameByArbiterRefundsAll() public {
        _joinFour();
        vm.prank(arbiter);
        esc.voidGame(gameId);
        assertEq(cusd.balanceOf(alice), 10e18);
        assertEq(cusd.balanceOf(bob), 10e18);
        assertEq(cusd.balanceOf(carol), 10e18);
        assertEq(cusd.balanceOf(dave), 10e18);
        assertEq(cusd.balanceOf(address(esc)), 0);
    }

    function testVoidGameOnlyArbiter() public {
        _joinFour();
        vm.prank(alice);
        vm.expectRevert(LudoEscrowN.NotArbiter.selector);
        esc.voidGame(gameId);
    }

    function testRefundActiveAfterTimeout() public {
        _joinFour();
        vm.expectRevert(LudoEscrowN.NotExpired.selector);
        esc.refundActive(gameId);
        vm.warp(block.timestamp + 24 hours + 1);
        esc.refundActive(gameId); // permissionless
        assertEq(cusd.balanceOf(address(esc)), 0);
        assertEq(cusd.balanceOf(dave), 10e18);
    }

    // ---- governable rake (rec 3) ----

    function testOwnerDefaultsToTreasury() public view {
        assertEq(esc.owner(), treasury);
    }

    function testSetRakeBpsZeroPromo() public {
        vm.prank(treasury); esc.setRakeBps(0);
        _joinFour();
        esc.settle(gameId, carol, "", new string[](0), _sign(gameId, carol));
        // full 4e18 pot to the winner, no rake
        assertEq(cusd.balanceOf(carol), 10e18 - 1e18 + 4e18);
        assertEq(cusd.balanceOf(treasury), 0);
    }

    function testSetRakeBpsOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(LudoEscrowN.NotOwner.selector);
        esc.setRakeBps(100);
    }

    function testSetRakeBpsCapEnforced() public {
        vm.prank(treasury);
        vm.expectRevert(bytes("rake > max"));
        esc.setRakeBps(1001);
    }

    function testTransferOwnership() public {
        vm.prank(treasury); esc.transferOwnership(alice);
        assertEq(esc.owner(), alice);
        vm.prank(alice); esc.setRakeBps(100);
        assertEq(esc.rakeBps(), 100);
    }

    // ---- batch settlement (rec 5) ----

    function testSettleBatchSettlesAll() public {
        bytes32 ga = keccak256("ba");
        bytes32 gb = keccak256("bb");
        vm.prank(alice); esc.join(ga, address(cusd), STAKE, 2, bytes32(0));
        vm.prank(bob); esc.join(ga, address(cusd), STAKE, 2, bytes32(0));
        vm.prank(carol); esc.join(gb, address(cusd), STAKE, 2, bytes32(0));
        vm.prank(dave); esc.join(gb, address(cusd), STAKE, 2, bytes32(0));

        bytes32[] memory ids = new bytes32[](2);
        address[] memory winners = new address[](2);
        bytes[] memory sigs = new bytes[](2);
        ids[0] = ga; winners[0] = alice; sigs[0] = _sign(ga, alice);
        ids[1] = gb; winners[1] = carol; sigs[1] = _sign(gb, carol);
        esc.settleBatch(ids, winners, sigs);

        // each 2-seat pot 2e18, rake 0.18e18, payout 1.82e18
        assertEq(cusd.balanceOf(alice), 10e18 - 1e18 + 1.82e18);
        assertEq(cusd.balanceOf(carol), 10e18 - 1e18 + 1.82e18);
        assertEq(cusd.balanceOf(treasury), 0.36e18);
    }

    function testSettleBatchLengthMismatchReverts() public {
        bytes32[] memory ids = new bytes32[](2);
        address[] memory winners = new address[](2);
        bytes[] memory sigs = new bytes[](1);
        vm.expectRevert(LudoEscrowN.LengthMismatch.selector);
        esc.settleBatch(ids, winners, sigs);
    }
}
