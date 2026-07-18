// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {LudoEscrow, IERC20} from "../src/LudoEscrow.sol";
import {LudoEscrowN} from "../src/LudoEscrowN.sol";

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

/// Degressive per-tier rake: (token, exact stake) overrides the global rakeBps,
/// snapshotted per game at creation; 0 = unset → global fallback.
contract TierRakeTest is Test {
    LudoEscrow esc;
    MockERC20 usdt;
    uint256 arbiterPk = 0xA11CE;
    address arbiter;
    address treasury = address(0xBEEF);
    address alice = address(0xA);
    address bob = address(0xB);
    bytes32 gameId = keccak256("tier-game");

    // USDT-style 6 decimals: the shared-protocol tiers in raw amounts.
    uint96 constant STAKE_25C = 250_000;
    uint96 constant STAKE_1D = 1_000_000;
    uint96 constant STAKE_5D = 5_000_000;

    function setUp() public {
        arbiter = vm.addr(arbiterPk);
        esc = new LudoEscrow(arbiter, treasury, 900);
        usdt = new MockERC20();
        vm.prank(treasury); esc.setTokenAllowed(address(usdt), true);
        usdt.mint(alice, 100e6);
        usdt.mint(bob, 100e6);
        vm.prank(alice); usdt.approve(address(esc), type(uint256).max);
        vm.prank(bob); usdt.approve(address(esc), type(uint256).max);
    }

    function _sign(bytes32 id, address winner) internal view returns (bytes memory) {
        bytes32 digest = esc.settlementDigest(id, winner);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function testTierRakeSnapshotAndSettle() public {
        // 6% on the $5 tier; pot $10 → rake $0.60, payout $9.40
        vm.prank(treasury); esc.setTierRakeBps(address(usdt), STAKE_5D, 600);
        vm.prank(alice); esc.join(gameId, address(usdt), STAKE_5D, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(usdt), STAKE_5D, bytes32(0));
        esc.settle(gameId, alice, "", "", "", _sign(gameId, alice));
        assertEq(usdt.balanceOf(alice), 100e6 - 5e6 + 9_400_000);
        assertEq(usdt.balanceOf(treasury), 600_000);
    }

    function testUnsetTierFallsBackToGlobal() public {
        // No tier entry for $1 → global 9%: pot $2 → rake $0.18, payout $1.82
        vm.prank(alice); esc.join(gameId, address(usdt), STAKE_1D, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(usdt), STAKE_1D, bytes32(0));
        esc.settle(gameId, alice, "", "", "", _sign(gameId, alice));
        assertEq(usdt.balanceOf(alice), 100e6 - 1e6 + 1_820_000);
        assertEq(usdt.balanceOf(treasury), 180_000);
    }

    function testSnapshotSurvivesLaterTierChange() public {
        // 10% at creation; owner re-prices mid-game; the game keeps its snapshot.
        vm.prank(treasury); esc.setTierRakeBps(address(usdt), STAKE_25C, 1000);
        vm.prank(alice); esc.join(gameId, address(usdt), STAKE_25C, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(usdt), STAKE_25C, bytes32(0));
        vm.prank(treasury); esc.setTierRakeBps(address(usdt), STAKE_25C, 100);
        esc.settle(gameId, alice, "", "", "", _sign(gameId, alice));
        // pot 500000, 10% rake = 50000, payout 450000
        assertEq(usdt.balanceOf(treasury), 50_000);
    }

    function testTierRakeCappedAtMax() public {
        vm.prank(treasury);
        vm.expectRevert("rake > max");
        esc.setTierRakeBps(address(usdt), STAKE_25C, 1001);
    }

    function testTierRakeOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(LudoEscrow.NotOwner.selector);
        esc.setTierRakeBps(address(usdt), STAKE_25C, 600);
    }

    function testTierRakeIsPerToken() public {
        // A tier set on ANOTHER token must not leak onto this one (decimals differ
        // across tokens, so the same raw amount is a different cash tier).
        MockERC20 other = new MockERC20();
        vm.prank(treasury); esc.setTierRakeBps(address(other), STAKE_5D, 600);
        vm.prank(alice); esc.join(gameId, address(usdt), STAKE_5D, bytes32(0));
        vm.prank(bob); esc.join(gameId, address(usdt), STAKE_5D, bytes32(0));
        esc.settle(gameId, alice, "", "", "", _sign(gameId, alice));
        // falls back to global 9%: pot $10 → rake $0.90
        assertEq(usdt.balanceOf(treasury), 900_000);
    }

    function testTierRakeOnEscrowN() public {
        // Same mechanics on the 4-player escrow: 6% of a 4×$5 pot = $1.20.
        LudoEscrowN escN = new LudoEscrowN(arbiter, treasury, 900);
        vm.prank(treasury); escN.setTokenAllowed(address(usdt), true);
        vm.prank(treasury); escN.setTierRakeBps(address(usdt), STAKE_5D, 600);
        address[4] memory seats = [address(0x1A), address(0x2B), address(0x3C), address(0x4D)];
        for (uint256 i = 0; i < 4; i++) {
            usdt.mint(seats[i], 10e6);
            vm.prank(seats[i]); usdt.approve(address(escN), type(uint256).max);
            vm.prank(seats[i]); escN.join(gameId, address(usdt), STAKE_5D, 4, bytes32(0));
        }
        bytes32 digest = escN.settlementDigest(gameId, seats[0]);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, digest);
        escN.settle(gameId, seats[0], "", new string[](0), abi.encodePacked(r, s, v));
        assertEq(usdt.balanceOf(treasury), 1_200_000); // 6% of 20e6
        assertEq(usdt.balanceOf(seats[0]), 10e6 - 5e6 + 18_800_000);
    }
}
