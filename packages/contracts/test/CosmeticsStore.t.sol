// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {CosmeticsStore, IERC20} from "../src/CosmeticsStore.sol";

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
}

contract CosmeticsStoreTest is Test {
    CosmeticsStore store;
    MockERC20 cusd;
    address treasury = address(0xBEEF);
    address alice = address(0xA);
    bytes32 constant OBSIDIAN = keccak256("obsidian");

    event Purchased(address indexed buyer, bytes32 indexed itemId, uint256 price);

    function setUp() public {
        cusd = new MockERC20();
        store = new CosmeticsStore(treasury, address(cusd)); // owner = this test contract
        cusd.mint(alice, 100e18);
        vm.prank(alice); cusd.approve(address(store), type(uint256).max);
        store.setPrice(OBSIDIAN, 1e18); // $1 cUSD
    }

    function testOwnerIsDeployer() public view {
        assertEq(store.owner(), address(this));
        assertEq(store.treasury(), treasury);
    }

    function testBuyPaysTreasuryAndEmits() public {
        vm.expectEmit(true, true, false, true);
        emit Purchased(alice, OBSIDIAN, 1e18);
        vm.prank(alice); store.buy(OBSIDIAN);
        assertEq(cusd.balanceOf(treasury), 1e18);
        assertEq(cusd.balanceOf(alice), 99e18);
    }

    function testFundsNeverRestInStore() public {
        vm.prank(alice); store.buy(OBSIDIAN);
        assertEq(cusd.balanceOf(address(store)), 0); // pulled straight to treasury
    }

    function testBuyUnlistedReverts() public {
        vm.prank(alice);
        vm.expectRevert(CosmeticsStore.NotForSale.selector);
        store.buy(keccak256("not-a-thing"));
    }

    function testDelistBlocksBuy() public {
        store.setPrice(OBSIDIAN, 0); // delist
        vm.prank(alice);
        vm.expectRevert(CosmeticsStore.NotForSale.selector);
        store.buy(OBSIDIAN);
    }

    function testSetPriceOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(CosmeticsStore.NotOwner.selector);
        store.setPrice(OBSIDIAN, 5e18);
    }

    function testSetPricesBatch() public {
        bytes32[] memory ids = new bytes32[](2);
        uint256[] memory prices = new uint256[](2);
        ids[0] = keccak256("aurora"); ids[1] = keccak256("board-jade");
        prices[0] = 2e18; prices[1] = 1.5e18;
        store.setPrices(ids, prices);
        assertEq(store.priceOf(keccak256("aurora")), 2e18);
        assertEq(store.priceOf(keccak256("board-jade")), 1.5e18);
    }

    function testSetPricesLengthMismatchReverts() public {
        bytes32[] memory ids = new bytes32[](2);
        uint256[] memory prices = new uint256[](1);
        vm.expectRevert(CosmeticsStore.LengthMismatch.selector);
        store.setPrices(ids, prices);
    }

    function testTransferOwnership() public {
        store.transferOwnership(alice);
        assertEq(store.owner(), alice);
        // old owner can't curate anymore
        vm.expectRevert(CosmeticsStore.NotOwner.selector);
        store.setPrice(OBSIDIAN, 7e18);
        // new owner can
        vm.prank(alice); store.setPrice(OBSIDIAN, 7e18);
        assertEq(store.priceOf(OBSIDIAN), 7e18);
    }
}
