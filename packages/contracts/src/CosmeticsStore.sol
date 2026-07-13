// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title CosmeticsStore — cUSD purchases of Ludo Arena cosmetics (backlog rec 6)
/// @notice Non-rake revenue: players buy dice skins / board themes with cUSD paid
///         STRAIGHT to the treasury. Cosmetics are infinite (no inventory) so a
///         purchase just emits Purchased(buyer, itemId), which the server watches
///         to grant ownership off-chain. The owner curates the catalogue + prices.
/// @dev Funds never rest here — buy() pulls straight to the treasury. itemId is
///      keccak256(bytes(cosmeticId)), computed identically off-chain.
contract CosmeticsStore {
    address public immutable treasury; // receives all cosmetic revenue
    address public owner; // curates catalogue + prices (→ multisig)
    address public token; // the stablecoin accepted (cUSD)

    // itemId → price in token base units. 0 = not for sale.
    mapping(bytes32 => uint256) public priceOf;

    event Purchased(address indexed buyer, bytes32 indexed itemId, uint256 price);
    event PriceSet(bytes32 indexed itemId, uint256 price);
    event TokenSet(address token);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotForSale();
    error TransferFailed();
    error LengthMismatch();

    constructor(address _treasury, address _token) {
        require(_treasury != address(0), "zero addr");
        treasury = _treasury;
        token = _token;
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Buy a cosmetic: pulls its cUSD price straight to the treasury and
    ///         emits Purchased for the server to grant ownership. Reverts if the
    ///         item isn't listed (price 0).
    function buy(bytes32 itemId) external {
        uint256 price = priceOf[itemId];
        if (price == 0) revert NotForSale();
        if (!IERC20(token).transferFrom(msg.sender, treasury, price)) revert TransferFailed();
        emit Purchased(msg.sender, itemId, price);
    }

    /// @notice List / re-price / delist (price 0) a single cosmetic.
    function setPrice(bytes32 itemId, uint256 price) external onlyOwner {
        priceOf[itemId] = price;
        emit PriceSet(itemId, price);
    }

    /// @notice Batch catalogue update (index-aligned).
    function setPrices(bytes32[] calldata itemIds, uint256[] calldata prices) external onlyOwner {
        if (itemIds.length != prices.length) revert LengthMismatch();
        for (uint256 i = 0; i < itemIds.length; i++) {
            priceOf[itemIds[i]] = prices[i];
            emit PriceSet(itemIds[i], prices[i]);
        }
    }

    /// @notice Switch the accepted stablecoin (e.g. testnet TestUSD → mainnet cUSD).
    function setToken(address _token) external onlyOwner {
        token = _token;
        emit TokenSet(_token);
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }
}
