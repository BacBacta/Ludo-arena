// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {LudoEscrow, IERC20} from "../src/LudoEscrow.sol";
import {LudoEscrowN} from "../src/LudoEscrowN.sol";

contract GoodToken is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] < a || balanceOf[f] < a) return false;
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
    function transfer(address t, uint256 a) external returns (bool) {
        if (balanceOf[msg.sender] < a) return false;
        balanceOf[msg.sender] -= a; balanceOf[t] += a; return true;
    }
}

/// Fuzz the two authorization invariants the audit brief calls out:
///  - ONLY the arbiter's signature can trigger a payout.
///  - A player can only ever withdraw their OWN credited funds.
contract FuzzAuthorizationTest is Test {
    LudoEscrow esc;
    LudoEscrowN escN;
    GoodToken tok;
    uint256 arbiterPk = 0xA11CE;
    address arbiter;
    address treasury = address(0xBEEF);
    address alice = address(0xA);
    address bob = address(0xB);
    bytes32 gid = keccak256("g");

    function setUp() public {
        arbiter = vm.addr(arbiterPk);
        esc = new LudoEscrow(arbiter, treasury, 900);
        escN = new LudoEscrowN(arbiter, treasury, 900);
        tok = new GoodToken();
        vm.prank(treasury); esc.setTokenAllowed(address(tok), true);
        vm.prank(treasury); escN.setTokenAllowed(address(tok), true);
    }

    function _fund2p() internal {
        tok.mint(alice, 10e18); tok.mint(bob, 10e18);
        vm.prank(alice); tok.approve(address(esc), type(uint256).max);
        vm.prank(bob); tok.approve(address(esc), type(uint256).max);
        vm.prank(alice); esc.join(gid, address(tok), 1e18, bytes32(0));
        vm.prank(bob); esc.join(gid, address(tok), 1e18, bytes32(0));
    }

    /// Any signer that is NOT the arbiter fails to settle — no payout is possible
    /// without the authorized server key (the sole authorization the contract trusts).
    function testFuzz_onlyArbiterSignatureSettles(uint256 wrongPk) public {
        wrongPk = bound(wrongPk, 1, type(uint128).max);
        vm.assume(vm.addr(wrongPk) != arbiter);
        _fund2p();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, esc.settlementDigest(gid, alice));
        vm.expectRevert(LudoEscrow.BadSignature.selector);
        esc.settle(gid, alice, "", "", "", abi.encodePacked(r, s, v));
        // the pot is untouched: both stakes still escrowed
        assertEq(tok.balanceOf(address(esc)), 2e18);
    }

    /// The arbiter can only ever name a DEPOSITOR as winner — a signature over any
    /// other address reverts NotAPlayer, so funds can never be diverted to a stranger.
    function testFuzz_arbiterCannotPayANonDepositor(address stranger) public {
        vm.assume(stranger != alice && stranger != bob);
        _fund2p();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, esc.settlementDigest(gid, stranger));
        vm.expectRevert(LudoEscrow.NotAPlayer.selector);
        esc.settle(gid, stranger, "", "", "", abi.encodePacked(r, s, v));
    }

    /// withdraw() pays the CALLER their own credit and nothing more — one account's
    /// credit can never be drained by another. Uses LudoEscrowN's pay-or-credit via a
    /// token that blocks one recipient so a credit actually accrues.
    function testFuzz_withdrawOnlyOwnCredit(uint256 callerSeed) public {
        // Build a 2-seat game, block the winner so their payout is CREDITED.
        BlockToken bt = new BlockToken();
        vm.prank(treasury); escN.setTokenAllowed(address(bt), true);
        bt.mint(alice, 10e18); bt.mint(bob, 10e18);
        vm.prank(alice); bt.approve(address(escN), type(uint256).max);
        vm.prank(bob); bt.approve(address(escN), type(uint256).max);
        vm.prank(alice); escN.join(gid, address(bt), 1e18, 2, bytes32(0));
        vm.prank(bob); escN.join(gid, address(bt), 1e18, 2, bytes32(0));
        bt.setBlocked(alice); // alice (winner) can't receive → credited
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, escN.settlementDigest(gid, alice));
        escN.settle(gid, alice, "", new string[](0), abi.encodePacked(r, s, v));

        uint256 pot = 2e18;
        uint256 payout = pot - (pot * 900) / 10_000;
        assertEq(escN.withdrawable(address(bt), alice), payout);

        // A DIFFERENT caller (never blocked, never credited) gets nothing.
        address[3] memory others = [bob, treasury, address(0xDEAD)];
        address caller = others[callerSeed % 3];
        vm.prank(caller);
        vm.expectRevert(LudoEscrowN.NothingToWithdraw.selector);
        escN.withdraw(address(bt));

        // alice pulls exactly her own credit once she can receive again.
        bt.setBlocked(address(0));
        vm.prank(alice); escN.withdraw(address(bt));
        assertEq(escN.withdrawable(address(bt), alice), 0);
    }
}

/// Token that blocks transfers TO one address (to force a pay-or-credit).
contract BlockToken is IERC20 {
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
        require(t != blocked, "blocked");
        if (balanceOf[msg.sender] < a) return false;
        balanceOf[msg.sender] -= a; balanceOf[t] += a; return true;
    }
}
