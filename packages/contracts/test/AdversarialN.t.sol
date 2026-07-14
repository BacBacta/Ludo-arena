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

    /// FINDING probe: one blacklisted seat DoSes the refund of ALL four seats.
    /// `_refundAll` transfers to every depositor in a loop and reverts on the first
    /// failure — so a single seat the token refuses to pay locks EVERYONE's stake.
    function testRefundAll_OneBadSeatLocksEveryone() public {
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
        // arbiter voids the game → should refund all four
        tok.setBlocked(players[2]); // seat #3 becomes unpayable (blacklist / griefing)
        vm.prank(arbiter);
        // C3 STILL OPEN (needs claim-per-seat, deferred): the blacklisted transfer now
        // reverts through SafeERC20 as TransferFailed — but the DoS is unchanged.
        vm.expectRevert(LudoEscrowN.TransferFailed.selector);
        esc.voidGame(gameId); // whole refund reverts → ALL 4 stakes stuck in the escrow
        // confirm the funds are still trapped (nobody got refunded)
        assertEq(tok.balanceOf(address(esc)), 4e18);
        for (uint256 i = 0; i < 4; i++) assertEq(tok.balanceOf(players[i]), 9e18);
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
