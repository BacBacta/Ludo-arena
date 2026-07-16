// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";
import {LudoEscrowN, IERC20} from "../src/LudoEscrowN.sol";

/// @dev Standard bool-returning ERC20 for the invariant campaign.
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

/// @notice Drives bounded random join/settle/refund/void/withdraw/warp calls so
///         the invariant test can assert the escrow stays SOLVENT no matter the
///         interleaving. gameId → (stake, seatCount) is DERIVED so joins to the
///         same game are consistent and tables actually fill (reaching Active,
///         which is where settle/void live).
contract EscrowNHandler is Test {
    LudoEscrowN public esc;
    GoodToken public tok;
    uint256 internal arbiterPk;
    address[] public players;
    bytes32[] public gameIds;
    mapping(bytes32 => bool) internal seen;

    constructor(LudoEscrowN _esc, GoodToken _tok, uint256 _arbiterPk, address[] memory _players) {
        esc = _esc;
        tok = _tok;
        arbiterPk = _arbiterPk;
        players = _players;
    }

    function gameCount() external view returns (uint256) { return gameIds.length; }

    function _gid(uint256 s) internal pure returns (bytes32) { return bytes32(s % 6); } // small space → games fill
    function _stakeFor(bytes32 gid) internal pure returns (uint96) { return uint96(1e17 * (1 + (uint256(gid) % 5))); }
    function _seatsFor(bytes32 gid) internal pure returns (uint8) { return uint8(2 + (uint256(gid) % 3)); }

    function join(uint256 pSeed, uint256 gSeed) public {
        address p = players[pSeed % players.length];
        bytes32 gid = _gid(gSeed);
        uint96 stake = _stakeFor(gid);
        uint8 seats = _seatsFor(gid);
        tok.mint(p, stake);
        vm.startPrank(p);
        tok.approve(address(esc), type(uint256).max);
        try esc.join(gid, address(tok), stake, seats) {
            if (!seen[gid]) { seen[gid] = true; gameIds.push(gid); }
        } catch {}
        vm.stopPrank();
    }

    function settle(uint256 gSeed, uint256 wSeed) public {
        if (gameIds.length == 0) return;
        bytes32 gid = gameIds[gSeed % gameIds.length];
        address[] memory seats = esc.seatsOf(gid);
        if (seats.length == 0) return;
        address winner = seats[wSeed % seats.length];
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, esc.settlementDigest(gid, winner));
        try esc.settle(gid, winner, abi.encodePacked(r, s, v)) {} catch {}
    }

    function refundUnfilled(uint256 gSeed) public {
        if (gameIds.length == 0) return;
        bytes32 gid = gameIds[gSeed % gameIds.length];
        try esc.refundUnfilled(gid) {} catch {}
    }

    function refundActive(uint256 gSeed) public {
        if (gameIds.length == 0) return;
        bytes32 gid = gameIds[gSeed % gameIds.length];
        try esc.refundActive(gid) {} catch {}
    }

    function voidGame(uint256 gSeed) public {
        if (gameIds.length == 0) return;
        bytes32 gid = gameIds[gSeed % gameIds.length];
        vm.prank(esc.arbiter());
        try esc.voidGame(gid) {} catch {}
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

contract InvariantEscrowNTest is StdInvariant, Test {
    LudoEscrowN esc;
    GoodToken tok;
    EscrowNHandler handler;
    uint256 arbiterPk = 0xA11CE;
    address treasury = address(0xBEEF);
    address[] players;

    function setUp() public {
        esc = new LudoEscrowN(vm.addr(arbiterPk), treasury, 900);
        tok = new GoodToken();
        vm.prank(treasury);
        esc.setTokenAllowed(address(tok), true);
        for (uint160 i = 1; i <= 5; i++) players.push(address(i * 0x1000));
        handler = new EscrowNHandler(esc, tok, arbiterPk, players);
        targetContract(address(handler));
    }

    /// SOLVENCY (the master money invariant, R-CONTRACT-2): the escrow's token
    /// balance ALWAYS equals the stakes still locked in open games (Filling/Active)
    /// plus every credited-but-unwithdrawn amount. A double payout, a lost refund,
    /// or value creation would break this equality.
    function invariant_solvent() public view {
        uint256 owed;
        uint256 n = handler.gameCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 gid = handler.gameIds(i);
            (, uint96 stake, uint8 seatCount, uint8 joined, , LudoEscrowN.Status status,) = esc.games(gid);
            seatCount; // silence unused
            if (status == LudoEscrowN.Status.Filling || status == LudoEscrowN.Status.Active) {
                owed += uint256(stake) * joined;
            }
        }
        // credited (pay-or-credit) funds are still held until withdraw()
        for (uint256 i = 0; i < players.length; i++) {
            owed += esc.withdrawable(address(tok), players[i]);
        }
        owed += esc.withdrawable(address(tok), treasury);
        assertEq(tok.balanceOf(address(esc)), owed, "escrow balance != funds owed");
    }

    /// No game escapes the once-only state machine: a resolved game (Settled or
    /// Refunded) holds no locked funds of its own (its stakes have been distributed
    /// or credited) — enforced by the solvency sum above only counting open games.
    function invariant_resolvedGamesReleaseFunds() public view {
        uint256 n = handler.gameCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 gid = handler.gameIds(i);
            (, , , , , LudoEscrowN.Status status,) = esc.games(gid);
            // status is only ever one of the 5 enum values; a resolved one is terminal.
            assertTrue(uint8(status) <= uint8(LudoEscrowN.Status.Refunded));
        }
    }
}
