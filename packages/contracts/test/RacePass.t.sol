// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {RacePass} from "../src/RacePass.sol";

contract RacePassTest is Test {
    RacePass pass;
    address alice = address(0xA);
    address bob = address(0xB);

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Minted(address indexed holder, uint256 indexed tokenId);

    function setUp() public {
        pass = new RacePass("ipfs://race-week-1.json"); // owner = this test contract
        pass.setMintOpen(true);
    }

    // ---- mint ----

    function testMintOncePerAddress() public {
        vm.prank(alice);
        uint256 id = pass.mint();
        assertEq(id, 1);
        assertEq(pass.ownerOf(1), alice);
        assertEq(pass.balanceOf(alice), 1);
        assertEq(pass.passOf(alice), 1);
        assertEq(pass.totalSupply(), 1);

        vm.prank(alice);
        vm.expectRevert(RacePass.AlreadyMinted.selector);
        pass.mint();
    }

    function testSequentialIdsAcrossHolders() public {
        vm.prank(alice);
        pass.mint();
        vm.prank(bob);
        uint256 id2 = pass.mint();
        assertEq(id2, 2);
        assertEq(pass.ownerOf(2), bob);
        assertEq(pass.totalSupply(), 2);
    }

    function testMintClosedReverts() public {
        pass.setMintOpen(false);
        vm.prank(alice);
        vm.expectRevert(RacePass.MintClosed.selector);
        pass.mint();
    }

    function testMintEmitsTransferAndMinted() public {
        vm.expectEmit(true, true, true, true);
        emit Transfer(address(0), alice, 1);
        vm.expectEmit(true, true, false, true);
        emit Minted(alice, 1);
        vm.prank(alice);
        pass.mint();
    }

    // ---- soulbound ----

    function testTransfersRevert() public {
        vm.prank(alice);
        pass.mint();
        vm.startPrank(alice);
        vm.expectRevert(RacePass.Soulbound.selector);
        pass.transferFrom(alice, bob, 1);
        vm.expectRevert(RacePass.Soulbound.selector);
        pass.safeTransferFrom(alice, bob, 1);
        vm.expectRevert(RacePass.Soulbound.selector);
        pass.safeTransferFrom(alice, bob, 1, "");
        vm.expectRevert(RacePass.Soulbound.selector);
        pass.approve(bob, 1);
        vm.expectRevert(RacePass.Soulbound.selector);
        pass.setApprovalForAll(bob, true);
        vm.stopPrank();
        // read surface stays inert
        assertEq(pass.getApproved(1), address(0));
        assertFalse(pass.isApprovedForAll(alice, bob));
    }

    // ---- ERC-721 read surface ----

    function testOwnerOfUnknownReverts() public {
        vm.expectRevert(RacePass.NonexistentToken.selector);
        pass.ownerOf(99);
    }

    function testTokenURI() public {
        vm.prank(alice);
        pass.mint();
        assertEq(pass.tokenURI(1), "ipfs://race-week-1.json");
        pass.setTokenURI("ipfs://race-week-1-final.json");
        assertEq(pass.tokenURI(1), "ipfs://race-week-1-final.json");
        vm.expectRevert(RacePass.NonexistentToken.selector);
        pass.tokenURI(2);
    }

    function testSupportsInterface() public view {
        assertTrue(pass.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(pass.supportsInterface(0x5b5e139f)); // metadata
        assertTrue(pass.supportsInterface(0x01ffc9a7)); // ERC-165
        assertFalse(pass.supportsInterface(0xffffffff));
    }

    // ---- admin ----

    function testOnlyOwnerGates() public {
        vm.startPrank(alice);
        vm.expectRevert(RacePass.NotOwner.selector);
        pass.setMintOpen(false);
        vm.expectRevert(RacePass.NotOwner.selector);
        pass.setTokenURI("x");
        vm.expectRevert(RacePass.NotOwner.selector);
        pass.transferOwnership(alice);
        vm.stopPrank();
    }

    function testOwnershipTransfer() public {
        pass.transferOwnership(bob);
        assertEq(pass.owner(), bob);
        vm.expectRevert(RacePass.NotOwner.selector);
        pass.setMintOpen(false); // old owner locked out
        vm.prank(bob);
        pass.setMintOpen(false); // new owner works
        assertFalse(pass.mintOpen());
    }

    // ---- fuzz: any address mints exactly once, ids stay dense ----

    function testFuzzMintUnique(address a, address b) public {
        vm.assume(a != address(0) && b != address(0) && a != b);
        vm.prank(a);
        pass.mint();
        vm.prank(b);
        pass.mint();
        assertEq(pass.totalSupply(), 2);
        assertEq(pass.balanceOf(a), 1);
        assertEq(pass.balanceOf(b), 1);
        vm.prank(a);
        vm.expectRevert(RacePass.AlreadyMinted.selector);
        pass.mint();
    }
}
