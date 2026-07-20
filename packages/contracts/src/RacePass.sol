// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title RacePass — Ludo Arena event entry pass (Race Week)
/// @notice One FREE, SOULBOUND ERC-721 per address. Minting the pass is the
///         on-chain entry to a Race Week event: the server watches Minted to
///         unlock the player's subsidised-stake quota, quests (Zealy) verify
///         ownership on-chain, and the leaderboard is gated on holding one.
/// @dev Soulbound by design — the pass is an ANTI-SYBIL identity anchor
///      (1 per wallet, and MiniPay wallets map to phone numbers), so transfers
///      and approvals revert: a farmed pass cannot be sold or moved. The
///      ERC-721 read surface (ownerOf/balanceOf/tokenURI/supportsInterface +
///      the standard Transfer mint event) is kept so wallets and explorers
///      display it normally. The owner opens/closes the mint window per event.
contract RacePass {
    string public constant name = "Ludo Arena Race Pass";
    string public constant symbol = "LUDORACE";

    address public owner; // opens/closes mint windows, sets art (→ multisig)
    bool public mintOpen; // the event window; closed on deploy until armed
    uint256 public totalSupply; // sequential ids start at 1

    mapping(uint256 => address) private holderOf; // tokenId → holder
    mapping(address => uint256) public passOf; // holder → tokenId (0 = none)
    string private uri; // one artwork for every pass (event identity, not rarity)

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId); // ERC-721 mint event
    event Minted(address indexed holder, uint256 indexed tokenId); // server/quest hook
    event MintOpenSet(bool open);
    event TokenURISet(string uri);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error MintClosed();
    error AlreadyMinted();
    error Soulbound();
    error NonexistentToken();

    constructor(string memory _uri) {
        owner = msg.sender;
        uri = _uri;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Mint YOUR pass — free, once per address, only while the event
    ///         window is open. Emits the standard Transfer (explorers) and
    ///         Minted (server quota unlock / quest verification).
    function mint() external returns (uint256 tokenId) {
        if (!mintOpen) revert MintClosed();
        if (passOf[msg.sender] != 0) revert AlreadyMinted();
        tokenId = ++totalSupply;
        holderOf[tokenId] = msg.sender;
        passOf[msg.sender] = tokenId;
        emit Transfer(address(0), msg.sender, tokenId);
        emit Minted(msg.sender, tokenId);
    }

    // ---- ERC-721 read surface ----

    function ownerOf(uint256 tokenId) external view returns (address holder) {
        holder = holderOf[tokenId];
        if (holder == address(0)) revert NonexistentToken();
    }

    /// @dev 0 or 1 by construction (one soulbound pass per address).
    function balanceOf(address holder) external view returns (uint256) {
        return passOf[holder] == 0 ? 0 : 1;
    }

    /// @dev Every pass shares the event artwork — identity, not rarity.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (holderOf[tokenId] == address(0)) revert NonexistentToken();
        return uri;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f // ERC-721 Metadata
            || interfaceId == 0x01ffc9a7; // ERC-165
    }

    // ---- Soulbound: the whole ERC-721 write surface reverts ----

    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }

    function getApproved(uint256) external pure returns (address) {
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    // ---- Admin ----

    /// @notice Open/close the event mint window.
    function setMintOpen(bool open) external onlyOwner {
        mintOpen = open;
        emit MintOpenSet(open);
    }

    /// @notice Point every pass at the event artwork (IPFS/HTTPS metadata JSON).
    function setTokenURI(string calldata _uri) external onlyOwner {
        uri = _uri;
        emit TokenURISet(_uri);
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }
}
