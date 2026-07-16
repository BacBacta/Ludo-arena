// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {LudoEscrow, IERC20} from "../src/LudoEscrow.sol";

/// @dev Standard bool-returning ERC20 (baseline).
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

/// @dev USDT-style: transfer/transferFrom return NOTHING (no bool). Real Tether.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
    function transferFrom(address f, address t, uint256 a) external {
        require(allowance[f][msg.sender] >= a && balanceOf[f] >= a, "bal");
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a;
    }
    function transfer(address t, uint256 a) external {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a; balanceOf[t] += a;
    }
}

/// @dev Fee-on-transfer: credits recipient `amount - fee`, so the escrow receives
///      LESS than `stake` while it books the full `stake`.
contract FeeToken is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public feeBps = 100; // 1%
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] < a || balanceOf[f] < a) return false;
        allowance[f][msg.sender] -= a; balanceOf[f] -= a;
        balanceOf[t] += a - (a * feeBps) / 10000; return true;
    }
    function transfer(address t, uint256 a) external returns (bool) {
        if (balanceOf[msg.sender] < a) return false;
        balanceOf[msg.sender] -= a; balanceOf[t] += a - (a * feeBps) / 10000; return true;
    }
}

/// @dev Token that BLACKLISTS one recipient (like USDC/USDT freeze): transfer TO
///      the blacklisted address reverts. Models a griefing/frozen winner or player.
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

/// @dev Reentrant token: on payout it tries to re-enter settle() to double-pay.
contract ReentrantToken is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    LudoEscrow public esc; bytes32 public gid; address public win; bytes public sig;
    bool armed;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
    function arm(LudoEscrow e, bytes32 g, address w, bytes calldata s_) external { esc = e; gid = g; win = w; sig = s_; armed = true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] < a || balanceOf[f] < a) return false;
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
    function transfer(address t, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[t] += a;
        if (armed) { armed = false; // re-enter once
            try esc.settle(gid, win, sig) { } catch { } // CEI must make this a no-op
        }
        return true;
    }
}

contract AdversarialTest is Test {
    LudoEscrow esc;
    uint256 arbiterPk = 0xA11CE;
    address arbiter;
    address treasury = address(0xBEEF);
    address alice = address(0xA);
    address bob = address(0xB);
    bytes32 gameId = keccak256("g");

    event Settled(bytes32 indexed gameId, address indexed winner, uint256 payout, uint256 rake);
    event Joined(bytes32 indexed gameId, address indexed player, address token, uint96 stake);

    function setUp() public {
        arbiter = vm.addr(arbiterPk);
        esc = new LudoEscrow(arbiter, treasury, 900);
    }
    function _sign(bytes32 id, address w) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, esc.settlementDigest(id, w));
        return abi.encodePacked(r, s, v);
    }
    function _fund(address tok) internal {
        vm.prank(treasury); esc.setTokenAllowed(tok, true); // owner allowlists the stablecoin
        GoodToken(tok).mint(alice, 10e18); GoodToken(tok).mint(bob, 10e18);
        vm.prank(alice); GoodToken(tok).approve(address(esc), type(uint256).max);
        vm.prank(bob); GoodToken(tok).approve(address(esc), type(uint256).max);
    }

    // ---------- constructor guards (analysis said: untested) ----------
    function testCtorRejectsZeroArbiter() public {
        vm.expectRevert(bytes("zero addr"));
        new LudoEscrow(address(0), treasury, 900);
    }
    function testCtorRejectsZeroTreasury() public {
        vm.expectRevert(bytes("zero addr"));
        new LudoEscrow(arbiter, address(0), 900);
    }
    function testCtorRejectsRakeTooHigh() public {
        vm.expectRevert(bytes("rake > max"));
        new LudoEscrow(arbiter, treasury, 1001);
    }

    // ---------- event payloads (server credits winnings by listening to these) ----------
    function testJoinedAndSettledEventsExact() public {
        GoodToken g = new GoodToken(); _fund(address(g));
        vm.expectEmit(true, true, false, true, address(esc));
        emit Joined(gameId, alice, address(g), 1e18);
        vm.prank(alice); esc.join(gameId, address(g), 1e18);
        vm.prank(bob); esc.join(gameId, address(g), 1e18);
        vm.expectEmit(true, true, false, true, address(esc));
        emit Settled(gameId, alice, 1.82e18, 0.18e18);
        esc.settle(gameId, alice, _sign(gameId, alice));
    }

    // ---------- FIX VERIFIED: USDT-style no-return token now WORKS (SafeERC20) ----------
    function testNoReturnToken_NowWorks() public {
        NoReturnToken t = new NoReturnToken();
        vm.prank(treasury); esc.setTokenAllowed(address(t), true);
        t.mint(alice, 10e18); t.mint(bob, 10e18);
        vm.prank(alice); t.approve(address(esc), type(uint256).max);
        vm.prank(bob); t.approve(address(esc), type(uint256).max);
        // SafeERC20 tolerates the missing bool return → join + settle succeed.
        vm.prank(alice); esc.join(gameId, address(t), 1e18);
        vm.prank(bob); esc.join(gameId, address(t), 1e18);
        esc.settle(gameId, alice, _sign(gameId, alice));
        assertEq(t.balanceOf(alice), 10e18 - 1e18 + 1.82e18); // paid despite no bool return
        assertEq(t.balanceOf(treasury), 0.18e18);
    }

    // ---------- FIX VERIFIED: fee-on-transfer token is kept OUT by the allowlist ----------
    function testFeeToken_RejectedByAllowlist() public {
        FeeToken f = new FeeToken(); // deliberately NOT allowlisted
        f.mint(alice, 10e18);
        vm.prank(alice); f.approve(address(esc), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(LudoEscrow.TokenNotAllowed.selector);
        esc.join(gameId, address(f), 1e18); // can never enter the escrow → no stranded funds
    }

    // ---------- FIX VERIFIED: rake is snapshotted at deposit ----------
    function testRakeSnapshot_LockedAtDeposit() public {
        GoodToken g = new GoodToken(); _fund(address(g));
        vm.prank(alice); esc.join(gameId, address(g), 1e18); // snapshot rake = 900 (9%)
        vm.prank(bob); esc.join(gameId, address(g), 1e18);
        vm.prank(treasury); esc.setRakeBps(1000); // owner cranks to 10% AFTER staking
        esc.settle(gameId, alice, _sign(gameId, alice));
        // settle used the SNAPSHOT (9%), not the new 10% → winner got the promised payout
        assertEq(g.balanceOf(alice), 10e18 - 1e18 + 1.82e18);
        assertEq(g.balanceOf(treasury), 0.18e18); // 9%, not 10%
    }

    // ---------- reentrancy: CEI must make a re-entrant settle a no-op (no double pay) ----------
    function testReentrantToken_NoDoublePay() public {
        ReentrantToken r = new ReentrantToken();
        vm.prank(treasury); esc.setTokenAllowed(address(r), true);
        r.mint(alice, 10e18); r.mint(bob, 10e18);
        vm.prank(alice); r.approve(address(esc), type(uint256).max);
        vm.prank(bob); r.approve(address(esc), type(uint256).max);
        vm.prank(alice); esc.join(gameId, address(r), 1e18);
        vm.prank(bob); esc.join(gameId, address(r), 1e18);
        bytes memory sig = _sign(gameId, alice);
        r.arm(esc, gameId, alice, sig); // transfer() will try to re-enter settle once
        esc.settle(gameId, alice, sig);
        // winner paid EXACTLY once (payout 1.82e18); reentrancy blocked by CEI.
        assertEq(r.balanceOf(alice), 10e18 - 1e18 + 1.82e18);
        assertEq(r.balanceOf(address(esc)), 0); // escrow fully drained, no residue
    }

    // ---------- C3 (R-ESCROW-1) FIX: pull-payment ports to the 1v1 escrow ----------
    // Before the fix, settle/_refundBoth/refundExpired all pushed via a reverting
    // transfer, so ONE blacklisted/frozen recipient locked the WHOLE pot forever
    // (settle, voidGame AND refundActive all reverted — no escape valve). Now a
    // push the token refuses is credited to `withdrawable` and pulled via withdraw().

    /// A blacklisted WINNER can't block settlement: the payout is credited and
    /// withdrawn later; the rake still reaches the treasury (mirrors LudoEscrowN).
    function testSettle_BlacklistedWinnerIsCredited() public {
        BlacklistToken tok = new BlacklistToken();
        vm.prank(treasury); esc.setTokenAllowed(address(tok), true);
        tok.mint(alice, 10e18); tok.mint(bob, 10e18);
        vm.prank(alice); tok.approve(address(esc), type(uint256).max);
        vm.prank(bob); tok.approve(address(esc), type(uint256).max);
        vm.prank(alice); esc.join(gameId, address(tok), 1e18);
        vm.prank(bob); esc.join(gameId, address(tok), 1e18);

        tok.setBlocked(alice); // the winner is unpayable at settle time
        esc.settle(gameId, alice, _sign(gameId, alice)); // MUST NOT revert

        uint256 pot = 2e18;
        uint256 rake = (pot * 900) / 10_000;
        uint256 payout = pot - rake;
        assertEq(esc.withdrawable(address(tok), alice), payout); // credited, not lost
        assertEq(tok.balanceOf(treasury), rake); // rake still delivered
        assertEq(tok.balanceOf(address(esc)), payout); // only the winner's payout stays

        tok.setBlocked(address(0));
        vm.prank(alice); esc.withdraw(address(tok));
        assertEq(tok.balanceOf(alice), 9e18 + payout);
        assertEq(tok.balanceOf(address(esc)), 0);
    }

    /// A blacklisted player must NOT block the OTHER player's refund on voidGame.
    function testVoidGame_OneBadPlayerDoesNotBlockOther() public {
        BlacklistToken tok = new BlacklistToken();
        vm.prank(treasury); esc.setTokenAllowed(address(tok), true);
        tok.mint(alice, 10e18); tok.mint(bob, 10e18);
        vm.prank(alice); tok.approve(address(esc), type(uint256).max);
        vm.prank(bob); tok.approve(address(esc), type(uint256).max);
        vm.prank(alice); esc.join(gameId, address(tok), 1e18);
        vm.prank(bob); esc.join(gameId, address(tok), 1e18);

        tok.setBlocked(bob); // bob becomes unpayable
        vm.prank(arbiter); esc.voidGame(gameId); // MUST NOT revert

        assertEq(tok.balanceOf(alice), 10e18); // alice refunded immediately (push)
        assertEq(tok.balanceOf(bob), 9e18); // bob not paid...
        assertEq(esc.withdrawable(address(tok), bob), 1e18); // ...but credited
        assertEq(tok.balanceOf(address(esc)), 1e18); // only bob's stake stays

        tok.setBlocked(address(0));
        vm.prank(bob); esc.withdraw(address(tok));
        assertEq(tok.balanceOf(bob), 10e18);
        assertEq(tok.balanceOf(address(esc)), 0);
    }

    /// A blacklisted lone staker is credited on refundExpired, never blocked.
    function testRefundExpired_BlacklistedLoneStakerCredited() public {
        BlacklistToken tok = new BlacklistToken();
        vm.prank(treasury); esc.setTokenAllowed(address(tok), true);
        tok.mint(alice, 10e18);
        vm.prank(alice); tok.approve(address(esc), type(uint256).max);
        vm.prank(alice); esc.join(gameId, address(tok), 1e18); // WaitingOpponent

        tok.setBlocked(alice);
        vm.warp(block.timestamp + esc.JOIN_TIMEOUT() + 1);
        esc.refundExpired(gameId); // MUST NOT revert

        assertEq(esc.withdrawable(address(tok), alice), 1e18); // credited
        assertEq(tok.balanceOf(address(esc)), 1e18);
        tok.setBlocked(address(0));
        vm.prank(alice); esc.withdraw(address(tok));
        assertEq(tok.balanceOf(alice), 10e18);
    }

    /// withdraw() with nothing owed reverts cleanly (no silent no-op).
    function testWithdrawNothingReverts() public {
        BlacklistToken tok = new BlacklistToken();
        vm.prank(alice);
        vm.expectRevert(LudoEscrow.NothingToWithdraw.selector);
        esc.withdraw(address(tok));
    }

    // ---------- fuzz: payout + rake == pot for any stake & rake ----------
    function testFuzz_PayoutPlusRakeEqualsPot(uint96 stake, uint16 rakeBps) public {
        stake = uint96(bound(uint256(stake), 1, 1e30));
        rakeBps = uint16(bound(uint256(rakeBps), 0, 1000));
        LudoEscrow e = new LudoEscrow(arbiter, treasury, rakeBps);
        GoodToken g = new GoodToken();
        vm.prank(treasury); e.setTokenAllowed(address(g), true);
        g.mint(alice, uint256(stake)); g.mint(bob, uint256(stake));
        vm.prank(alice); g.approve(address(e), type(uint256).max);
        vm.prank(bob); g.approve(address(e), type(uint256).max);
        vm.prank(alice); e.join(gameId, address(g), stake);
        vm.prank(bob); e.join(gameId, address(g), stake);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(arbiterPk, e.settlementDigest(gameId, alice));
        e.settle(gameId, alice, abi.encodePacked(rr, s, v));
        uint256 pot = uint256(stake) * 2;
        uint256 rake = (pot * rakeBps) / 10000;
        uint256 payout = pot - rake;
        assertEq(g.balanceOf(alice), uint256(stake) + payout - uint256(stake)); // net = payout - own stake... check absolute
        assertEq(g.balanceOf(treasury), rake);
        assertEq(g.balanceOf(address(e)), 0); // contract fully drained (no dust)
        assertEq(payout + rake, pot);        // invariant
    }
}
