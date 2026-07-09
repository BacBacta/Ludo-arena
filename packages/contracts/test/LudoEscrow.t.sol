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
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18);
        vm.prank(bob); esc.join(gameId, address(cusd), 1e18);

        esc.settle(gameId, alice, _sign(gameId, alice));

        // pot 2e18, rake 9 % = 0.18e18, payout 1.82e18
        assertEq(cusd.balanceOf(alice), 10e18 - 1e18 + 1.82e18);
        assertEq(cusd.balanceOf(treasury), 0.18e18);
    }

    function testCannotSettleTwice() public {
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18);
        vm.prank(bob); esc.join(gameId, address(cusd), 1e18);
        esc.settle(gameId, alice, _sign(gameId, alice));
        vm.expectRevert(LudoEscrow.BadStatus.selector);
        esc.settle(gameId, alice, _sign(gameId, alice));
    }

    function testBadSignatureRejected() public {
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18);
        vm.prank(bob); esc.join(gameId, address(cusd), 1e18);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, esc.settlementDigest(gameId, alice));
        vm.expectRevert(LudoEscrow.BadSignature.selector);
        esc.settle(gameId, alice, abi.encodePacked(r, s, v));
    }

    function testWinnerMustBePlayer() public {
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18);
        vm.prank(bob); esc.join(gameId, address(cusd), 1e18);
        vm.expectRevert(LudoEscrow.NotAPlayer.selector);
        esc.settle(gameId, address(0xDEAD), _sign(gameId, address(0xDEAD)));
    }

    function testRefundExpired() public {
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18);
        vm.expectRevert(LudoEscrow.NotExpired.selector);
        esc.refundExpired(gameId);
        vm.warp(block.timestamp + 121);
        esc.refundExpired(gameId);
        assertEq(cusd.balanceOf(alice), 10e18);
    }

    function testStakeMustMatch() public {
        vm.prank(alice); esc.join(gameId, address(cusd), 1e18);
        vm.prank(bob);
        vm.expectRevert(LudoEscrow.BadStake.selector);
        esc.join(gameId, address(cusd), 2e18);
    }
}
