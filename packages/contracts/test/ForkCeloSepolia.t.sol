// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {LudoEscrow} from "../src/LudoEscrow.sol";

interface IMockUSDT {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// Integration on a FORK of Celo Sepolia against the REAL deployed MockUSDT
/// (6-decimal USDT stand-in) — proves the current escrow bytecode handles real
/// on-chain token semantics + amounts end-to-end. Self-skips when CELO_SEPOLIA_RPC
/// is not set (so CI without an RPC stays green); run with:
///   CELO_SEPOLIA_RPC=https://forno.celo-sepolia.celo-testnet.org forge test --match-contract Fork
contract ForkCeloSepoliaTest is Test {
    // celo-sepolia deployment (packages/contracts/deployments.json).
    address constant MOCK_USDT = 0x862F0b37B4eb6d121E7D3d51C02c5e58461E5897;

    LudoEscrow esc;
    IMockUSDT usdt;
    uint256 arbiterPk = 0xA11CE;
    address arbiter;
    address treasury = address(0xBEEF);
    address alice = address(0xA11);
    address bob = address(0xB0B);
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("CELO_SEPOLIA_RPC", string(""));
        if (bytes(rpc).length == 0) return; // no RPC → self-skip
        vm.createSelectFork(rpc);
        forked = true;
        arbiter = vm.addr(arbiterPk);
        esc = new LudoEscrow(arbiter, treasury, 900);
        usdt = IMockUSDT(MOCK_USDT);
        vm.prank(treasury);
        esc.setTokenAllowed(MOCK_USDT, true);
    }

    function testFork_realUSDT_joinAndSettle() public {
        if (!forked) {
            emit log("SKIP testFork_realUSDT_joinAndSettle: CELO_SEPOLIA_RPC not set");
            return;
        }
        // Real token, real decimals.
        assertEq(usdt.decimals(), 6, "MockUSDT should be 6-decimal");
        uint96 stake = 1_000_000; // 1.000000 USDT

        usdt.mint(alice, stake);
        usdt.mint(bob, stake);
        vm.prank(alice); usdt.approve(address(esc), type(uint256).max);
        vm.prank(bob); usdt.approve(address(esc), type(uint256).max);

        bytes32 gid = keccak256("fork-game");
        vm.prank(alice); esc.join(gid, MOCK_USDT, stake);
        vm.prank(bob); esc.join(gid, MOCK_USDT, stake);
        assertEq(usdt.balanceOf(address(esc)), uint256(stake) * 2, "both stakes escrowed");

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, esc.settlementDigest(gid, alice));
        esc.settle(gid, alice, abi.encodePacked(r, s, v));

        uint256 pot = uint256(stake) * 2; // 2.000000
        uint256 rake = (pot * 900) / 10_000; // 9% = 0.180000
        uint256 payout = pot - rake; // 1.820000
        assertEq(usdt.balanceOf(alice), payout, "winner paid pot - rake (6-dec)");
        assertEq(usdt.balanceOf(treasury), rake, "treasury got the rake");
        assertEq(usdt.balanceOf(address(esc)), 0, "escrow fully drained");
    }

    function testFork_realUSDT_refundExpired() public {
        if (!forked) {
            emit log("SKIP testFork_realUSDT_refundExpired: CELO_SEPOLIA_RPC not set");
            return;
        }
        uint96 stake = 250_000; // 0.25 USDT
        usdt.mint(alice, stake);
        vm.prank(alice); usdt.approve(address(esc), type(uint256).max);
        bytes32 gid = keccak256("fork-refund");
        vm.prank(alice); esc.join(gid, MOCK_USDT, stake); // WaitingOpponent

        vm.warp(block.timestamp + esc.JOIN_TIMEOUT() + 1);
        esc.refundExpired(gid);
        assertEq(usdt.balanceOf(alice), stake, "lone staker fully refunded");
        assertEq(usdt.balanceOf(address(esc)), 0, "escrow drained");
    }
}
