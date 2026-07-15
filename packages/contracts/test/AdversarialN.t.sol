// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {LudoEscrowN, IERC20} from "../src/LudoEscrowN.sol";

/// @dev Token that BLACKLISTS one recipient (like USDC's blocklist): transfer TO
///      the blacklisted address reverts. Models a single griefing/blacklisted seat.
contract BlacklistToken is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public blocked;
    function setBlocked(address a) external { blocked = a; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] < a || balanceOf[f] < a) return false;
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
    function transfer(address t, uint256 a) external returns (bool) {
        require(t != blocked, "blacklisted");
        if (balanceOf[msg.sender] < a) return false;
        balanceOf[msg.sender] -= a; balanceOf[t] += a; return true;
    }
}

contract AdversarialNTest is Test {
    LudoEscrowN esc;
    uint256 arbiterPk = 0xA11CE;
    address arbiter;
    address treasury = address(0xBEEF);
    bytes32 gameId = keccak256("t4");
    address[4] players = [address(0xA1), address(0xA2), address(0xA3), address(0xA4)];

    function setUp() public {
        arbiter = vm.addr(arbiterPk);
        esc = new LudoEscrowN(arbiter, treasury, 900);
    }
    function _sign(bytes32 id, address w) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, esc.settlementDigest(id, w));
        return abi.encodePacked(r, s, v);
    }

    /// C3 FIXED: one blacklisted seat must NOT block the refund of the others.
    /// `_refundAll` now pays each seat via pay-or-credit — a transfer the token
    /// refuses is credited for withdrawal instead of reverting the whole call.
    function testRefundAll_OneBadSeatDoesNotBlockOthers() public {
        BlacklistToken tok = new BlacklistToken();
        vm.prank(treasury); esc.setTokenAllowed(address(tok), true);
        for (uint256 i = 0; i < 4; i++) {
            tok.mint(players[i], 10e18);
            vm.prank(players[i]); tok.approve(address(esc), type(uint256).max);
        }
        // fill a 4-seat table
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(players[i]); esc.join(gameId, address(tok), 1e18, 4);
        }
        tok.setBlocked(players[2]); // seat #3 becomes unpayable (blacklist / griefing)

        vm.prank(arbiter);
        esc.voidGame(gameId); // MUST NOT revert — the other three are refunded now

        // the three payable seats got their stake back immediately (push)
        assertEq(tok.balanceOf(players[0]), 10e18);
        assertEq(tok.balanceOf(players[1]), 10e18);
        assertEq(tok.balanceOf(players[3]), 10e18);
        // the blacklisted seat was NOT paid, but is CREDITED; its stake stays escrowed
        assertEq(tok.balanceOf(players[2]), 9e18);
        assertEq(esc.withdrawable(address(tok), players[2]), 1e18);
        assertEq(tok.balanceOf(address(esc)), 1e18);

        // once the recipient can receive again, it pulls its own credit
        tok.setBlocked(address(0));
        vm.prank(players[2]); esc.withdraw(address(tok));
        assertEq(tok.balanceOf(players[2]), 10e18);
        assertEq(esc.withdrawable(address(tok), players[2]), 0);
        assertEq(tok.balanceOf(address(esc)), 0);
    }

    /// A blacklisted WINNER can't block settlement either — the payout is credited
    /// and withdrawn later; the rake still reaches the treasury.
    function testSettle_BlacklistedWinnerIsCredited() public {
        BlacklistToken tok = new BlacklistToken();
        vm.prank(treasury); esc.setTokenAllowed(address(tok), true);
        for (uint256 i = 0; i < 4; i++) {
            tok.mint(players[i], 10e18);
            vm.prank(players[i]); tok.approve(address(esc), type(uint256).max);
            vm.prank(players[i]); esc.join(gameId, address(tok), 1e18, 4);
        }
        tok.setBlocked(players[0]); // the winner is unpayable at settle time
        esc.settle(gameId, players[0], _sign(gameId, players[0]));

        uint256 pot = 4e18;
        uint256 rake = (pot * 900) / 10_000;
        uint256 payout = pot - rake;
        assertEq(esc.withdrawable(address(tok), players[0]), payout); // credited, not lost
        assertEq(tok.balanceOf(treasury), rake); // rake still delivered
        assertEq(tok.balanceOf(address(esc)), payout); // only the winner's payout stays

        tok.setBlocked(address(0));
        vm.prank(players[0]); esc.withdraw(address(tok));
        assertEq(tok.balanceOf(players[0]), 9e18 + payout);
        assertEq(tok.balanceOf(address(esc)), 0);
    }

    /// withdraw() with nothing owed reverts cleanly (no silent no-op).
    function testWithdrawNothingReverts() public {
        BlacklistToken tok = new BlacklistToken();
        vm.prank(players[0]);
        vm.expectRevert(LudoEscrowN.NothingToWithdraw.selector);
        esc.withdraw(address(tok));
    }

    /// Sanity: normal 4-player winner-take-all pays pot - rake to the single winner.
    function testWinnerTakesPotMinusRake() public {
        BlacklistToken tok = new BlacklistToken();
        vm.prank(treasury); esc.setTokenAllowed(address(tok), true);
        for (uint256 i = 0; i < 4; i++) {
            tok.mint(players[i], 10e18);
            vm.prank(players[i]); tok.approve(address(esc), type(uint256).max);
            vm.prank(players[i]); esc.join(gameId, address(tok), 1e18, 4);
        }
        esc.settle(gameId, players[0], _sign(gameId, players[0]));
        // pot 4e18, rake 9% = 0.36e18, winner gets 3.64e18
        assertEq(tok.balanceOf(players[0]), 9e18 + 3.64e18);
        assertEq(tok.balanceOf(treasury), 0.36e18);
        assertEq(tok.balanceOf(address(esc)), 0);
    }

    /// A 5th distinct address cannot squeeze into a full 4-seat table.
    function testCannotOverfillTable() public {
        BlacklistToken tok = new BlacklistToken();
        vm.prank(treasury); esc.setTokenAllowed(address(tok), true);
        for (uint256 i = 0; i < 4; i++) {
            tok.mint(players[i], 10e18);
            vm.prank(players[i]); tok.approve(address(esc), type(uint256).max);
            vm.prank(players[i]); esc.join(gameId, address(tok), 1e18, 4);
        }
        address intruder = address(0xE5);
        tok.mint(intruder, 10e18);
        vm.prank(intruder); tok.approve(address(esc), type(uint256).max);
        vm.prank(intruder);
        vm.expectRevert(LudoEscrowN.BadStatus.selector); // table already Active
        esc.join(gameId, address(tok), 1e18, 4);
    }
}
