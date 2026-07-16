// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";
import {LudoEscrow, IERC20} from "../src/LudoEscrow.sol";

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

/// @notice Bounded random driver for the 1v1 escrow. gameId → stake is derived so
///         the two joins to a game agree and it reaches Active (where settle lives).
contract EscrowHandler is Test {
    LudoEscrow public esc;
    GoodToken public tok;
    uint256 internal arbiterPk;
    address[] public players;
    bytes32[] public gameIds;
    mapping(bytes32 => bool) internal seen;

    constructor(LudoEscrow _esc, GoodToken _tok, uint256 _arbiterPk, address[] memory _players) {
        esc = _esc;
        tok = _tok;
        arbiterPk = _arbiterPk;
        players = _players;
    }

    function gameCount() external view returns (uint256) { return gameIds.length; }

    function _gid(uint256 s) internal pure returns (bytes32) { return bytes32(s % 6); }
    function _stakeFor(bytes32 gid) internal pure returns (uint96) { return uint96(1e17 * (1 + (uint256(gid) % 5))); }

    function join(uint256 pSeed, uint256 gSeed) public {
        address p = players[pSeed % players.length];
        bytes32 gid = _gid(gSeed);
        uint96 stake = _stakeFor(gid);
        tok.mint(p, stake);
        vm.startPrank(p);
        tok.approve(address(esc), type(uint256).max);
        try esc.join(gid, address(tok), stake) {
            if (!seen[gid]) { seen[gid] = true; gameIds.push(gid); }
        } catch {}
        vm.stopPrank();
    }

    function settle(uint256 gSeed, uint256 wSeed) public {
        if (gameIds.length == 0) return;
        bytes32 gid = gameIds[gSeed % gameIds.length];
        (, , address a, address b, , ,) = esc.games(gid);
        address winner = (wSeed % 2 == 0) ? a : b;
        if (winner == address(0)) return;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, esc.settlementDigest(gid, winner));
        try esc.settle(gid, winner, abi.encodePacked(r, s, v)) {} catch {}
    }

    function refundExpired(uint256 gSeed) public {
        if (gameIds.length == 0) return;
        try esc.refundExpired(gameIds[gSeed % gameIds.length]) {} catch {}
    }

    function refundActive(uint256 gSeed) public {
        if (gameIds.length == 0) return;
        try esc.refundActive(gameIds[gSeed % gameIds.length]) {} catch {}
    }

    function voidGame(uint256 gSeed) public {
        if (gameIds.length == 0) return;
        vm.prank(esc.arbiter());
        try esc.voidGame(gameIds[gSeed % gameIds.length]) {} catch {}
    }

    function withdraw(uint256 pSeed) public {
        address p = players[pSeed % players.length];
        vm.prank(p);
        try esc.withdraw(address(tok)) {} catch {}
    }

    function warp(uint256 dt) public {
        vm.warp(block.timestamp + bound(dt, 0, 2 days));
    }
}

contract InvariantEscrowTest is StdInvariant, Test {
    LudoEscrow esc;
    GoodToken tok;
    EscrowHandler handler;
    uint256 arbiterPk = 0xA11CE;
    address treasury = address(0xBEEF);
    address[] players;

    function setUp() public {
        esc = new LudoEscrow(vm.addr(arbiterPk), treasury, 900);
        tok = new GoodToken();
        vm.prank(treasury);
        esc.setTokenAllowed(address(tok), true);
        for (uint160 i = 1; i <= 5; i++) players.push(address(i * 0x1000));
        handler = new EscrowHandler(esc, tok, arbiterPk, players);
        targetContract(address(handler));
    }

    /// SOLVENCY (R-CONTRACT-2): the 1v1 escrow's balance always equals the stakes
    /// locked in open games (WaitingOpponent = 1 stake, Active = 2) plus every
    /// credited-but-unwithdrawn amount. Double payout / lost refund / minting break it.
    function invariant_solvent() public view {
        uint256 owed;
        uint256 n = handler.gameCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 gid = handler.gameIds(i);
            (, uint96 stake, , , , LudoEscrow.Status status,) = esc.games(gid);
            if (status == LudoEscrow.Status.WaitingOpponent) owed += uint256(stake);
            else if (status == LudoEscrow.Status.Active) owed += uint256(stake) * 2;
        }
        for (uint256 i = 0; i < players.length; i++) owed += esc.withdrawable(address(tok), players[i]);
        owed += esc.withdrawable(address(tok), treasury);
        assertEq(tok.balanceOf(address(esc)), owed, "escrow balance != funds owed");
    }
}
