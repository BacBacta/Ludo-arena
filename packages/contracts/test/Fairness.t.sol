// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {LudoEscrow, IERC20} from "../src/LudoEscrow.sol";
import {LudoEscrowN} from "../src/LudoEscrowN.sol";

contract MockToken is IERC20 {
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

/// On-chain provably-fair anchor (option 1): the dice commit is recorded at join
/// (before play) and the seed is revealed in an event at settlement, so anyone can
/// verify sha256(serverSeed) == the commit and recompute the dice.
contract FairnessTest is Test {
    // A real 32-byte server seed (hex STRING, as the server sends it) and its
    // sha256 — computed OFF-CHAIN by the server's sha256Hex(serverSeed). The test
    // asserts the on-chain sha256(bytes(serverSeed)) equals it, proving a verifier
    // gets the same result on either side (the encoding the whole scheme rests on).
    string constant SEED = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a";
    bytes32 constant COMMIT = 0x9f88f3eac39f5cf80372734100c124522dbdaf59753cc9002a240c413e65e0d8;

    uint256 arbiterPk = 0xA11CE;
    address arbiter;
    address treasury = address(0xBEEF);
    address alice = address(0xA);
    address bob = address(0xB);
    address carol = address(0xC);
    address dan = address(0xD);

    function setUp() public {
        arbiter = vm.addr(arbiterPk);
    }

    function test_offchain_and_onchain_sha256_agree() public pure {
        // The core encoding guarantee: the server's off-chain sha256Hex(serverSeed)
        // (hardcoded as COMMIT) equals Solidity's sha256(bytes(serverSeed)). A
        // verifier reading the revealed seed on-chain recomputes the same commit.
        assertEq(sha256(bytes(SEED)), COMMIT, "off-chain and on-chain SHA-256 disagree");
    }

    // ----- 1v1 -----
    function _esc() internal returns (LudoEscrow esc, MockToken tok) {
        esc = new LudoEscrow(arbiter, treasury, 900);
        tok = new MockToken();
        vm.prank(treasury); esc.setTokenAllowed(address(tok), true);
        for (uint160 i = 0; i < 2; i++) {
            address p = i == 0 ? alice : bob;
            tok.mint(p, 10e18);
            vm.prank(p); tok.approve(address(esc), type(uint256).max);
        }
    }

    function test_1v1_join_records_commit_before_play() public {
        (LudoEscrow esc, MockToken tok) = _esc();
        bytes32 g = keccak256("g1");
        vm.prank(alice); esc.join(g, address(tok), 1e18, COMMIT);
        (, , , , , , , bytes32 stored) = esc.games(g);
        assertEq(stored, COMMIT, "commit not recorded at join");
    }

    function test_1v1_second_joiner_must_match_commit() public {
        (LudoEscrow esc, MockToken tok) = _esc();
        bytes32 g = keccak256("g2");
        vm.prank(alice); esc.join(g, address(tok), 1e18, COMMIT);
        vm.prank(bob);
        vm.expectRevert(LudoEscrow.CommitMismatch.selector);
        esc.join(g, address(tok), 1e18, keccak256("different")); // wrong commit → rejected
    }

    function test_1v1_settle_reveals_the_seed_on_chain() public {
        (LudoEscrow esc, MockToken tok) = _esc();
        bytes32 g = keccak256("g3");
        vm.prank(alice); esc.join(g, address(tok), 1e18, COMMIT);
        vm.prank(bob); esc.join(g, address(tok), 1e18, COMMIT);
        bytes32 digest = esc.settlementDigest(g, alice);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, digest);
        vm.expectEmit(true, false, false, true, address(esc));
        emit LudoEscrow.FairnessRevealed(g, SEED, "entropyA", "entropyB");
        esc.settle(g, alice, SEED, "entropyA", "entropyB", abi.encodePacked(r, s, v));
        // and the revealed seed matches the commit recorded before play
        assertEq(sha256(bytes(SEED)), COMMIT);
    }

    // ----- 4-player -----
    function _escN() internal returns (LudoEscrowN esc, MockToken tok) {
        esc = new LudoEscrowN(arbiter, treasury, 900);
        tok = new MockToken();
        vm.prank(treasury); esc.setTokenAllowed(address(tok), true);
        address[4] memory ps = [alice, bob, carol, dan];
        for (uint256 i = 0; i < 4; i++) {
            tok.mint(ps[i], 10e18);
            vm.prank(ps[i]); tok.approve(address(esc), type(uint256).max);
        }
    }

    function test_4p_join_records_commit_and_seats_must_match() public {
        (LudoEscrowN esc, MockToken tok) = _escN();
        bytes32 g = keccak256("gn1");
        vm.prank(alice); esc.join(g, address(tok), 1e18, 4, COMMIT);
        (, , , , , , , bytes32 stored) = esc.games(g);
        assertEq(stored, COMMIT, "4p commit not recorded");
        // a later seat with a different commit is rejected
        vm.prank(bob);
        vm.expectRevert(LudoEscrowN.CommitMismatch.selector);
        esc.join(g, address(tok), 1e18, 4, keccak256("other"));
    }

    function test_4p_settle_reveals_seed_and_seat_seeds() public {
        (LudoEscrowN esc, MockToken tok) = _escN();
        bytes32 g = keccak256("gn2");
        address[4] memory ps = [alice, bob, carol, dan];
        for (uint256 i = 0; i < 4; i++) { vm.prank(ps[i]); esc.join(g, address(tok), 1e18, 4, COMMIT); }
        string[] memory seatSeeds = new string[](4);
        seatSeeds[0] = "s0"; seatSeeds[1] = "s1"; seatSeeds[2] = "s2"; seatSeeds[3] = "s3";
        bytes32 digest = esc.settlementDigest(g, alice);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, digest);
        vm.expectEmit(true, false, false, true, address(esc));
        emit LudoEscrowN.FairnessRevealed(g, SEED, seatSeeds);
        esc.settle(g, alice, SEED, seatSeeds, abi.encodePacked(r, s, v));
    }
}
