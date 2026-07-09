// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title LudoEscrow — stake escrow for Ludo Arena 1v1 games
/// @notice Locks both players' stakes, settles the winner upon the arbiter's
///         (server key) signature. The arbiter can only designate one of the
///         two players: it can never divert the funds.
/// @dev Invariants: payout + rake == pot; a gameId settles only once;
///      rake capped at MAX_RAKE_BPS (constant).
contract LudoEscrow {
    // ---------- Config ----------
    uint256 public constant MAX_RAKE_BPS = 1_000; // 10% max, immutable
    uint256 public constant JOIN_TIMEOUT = 120;   // seconds before refundExpired

    address public immutable arbiter;   // server key that signs results
    address public immutable treasury;  // receives the rake
    uint256 public immutable rakeBps;   // e.g. 900 = 9%

    // ---------- State ----------
    enum Status { None, WaitingOpponent, Active, Settled, Refunded }

    struct Game {
        address token;      // stablecoin (cUSD/USDC/USDT)
        uint96 stake;       // stake per player
        address playerA;
        address playerB;
        uint40 createdAt;
        Status status;
    }

    mapping(bytes32 => Game) public games;

    // ---------- Events ----------
    event Joined(bytes32 indexed gameId, address indexed player, address token, uint96 stake);
    event Settled(bytes32 indexed gameId, address indexed winner, uint256 payout, uint256 rake);
    event Refunded(bytes32 indexed gameId);

    error BadStatus();
    error BadStake();
    error AlreadyJoined();
    error NotExpired();
    error BadSignature();
    error NotAPlayer();
    error TransferFailed();

    constructor(address _arbiter, address _treasury, uint256 _rakeBps) {
        require(_rakeBps <= MAX_RAKE_BPS, "rake > max");
        require(_arbiter != address(0) && _treasury != address(0), "zero addr");
        arbiter = _arbiter;
        treasury = _treasury;
        rakeBps = _rakeBps;
    }

    /// @notice Joins (or creates) game `gameId` by locking one's stake.
    ///         The first call sets token + stake; the second must match.
    function join(bytes32 gameId, address token, uint96 stake) external {
        if (stake == 0) revert BadStake();
        Game storage g = games[gameId];

        if (g.status == Status.None) {
            g.token = token;
            g.stake = stake;
            g.playerA = msg.sender;
            g.createdAt = uint40(block.timestamp);
            g.status = Status.WaitingOpponent;
        } else if (g.status == Status.WaitingOpponent) {
            if (msg.sender == g.playerA) revert AlreadyJoined();
            if (token != g.token || stake != g.stake) revert BadStake();
            g.playerB = msg.sender;
            g.status = Status.Active;
        } else {
            revert BadStatus();
        }

        if (!IERC20(token).transferFrom(msg.sender, address(this), stake)) revert TransferFailed();
        emit Joined(gameId, msg.sender, token, stake);
    }

    /// @notice Settles the game. `sig` = the arbiter's ECDSA signature over
    ///         keccak256(abi.encode(DOMAIN, gameId, winner)).
    function settle(bytes32 gameId, address winner, bytes calldata sig) external {
        Game storage g = games[gameId];
        if (g.status != Status.Active) revert BadStatus();
        if (winner != g.playerA && winner != g.playerB) revert NotAPlayer();

        bytes32 digest = settlementDigest(gameId, winner);
        if (_recover(digest, sig) != arbiter) revert BadSignature();

        g.status = Status.Settled;
        uint256 pot = uint256(g.stake) * 2;
        uint256 rake = (pot * rakeBps) / 10_000;
        uint256 payout = pot - rake;

        if (!IERC20(g.token).transfer(winner, payout)) revert TransferFailed();
        if (rake > 0 && !IERC20(g.token).transfer(treasury, rake)) revert TransferFailed();
        emit Settled(gameId, winner, payout, rake);
    }

    /// @notice Refunds playerA if nobody joined after JOIN_TIMEOUT.
    function refundExpired(bytes32 gameId) external {
        Game storage g = games[gameId];
        if (g.status != Status.WaitingOpponent) revert BadStatus();
        if (block.timestamp < g.createdAt + JOIN_TIMEOUT) revert NotExpired();
        g.status = Status.Refunded;
        if (!IERC20(g.token).transfer(g.playerA, g.stake)) revert TransferFailed();
        emit Refunded(gameId);
    }

    // ---------- Signatures ----------

    function settlementDigest(bytes32 gameId, address winner) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(abi.encode(block.chainid, address(this), gameId, winner))
            )
        );
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        return ecrecover(digest, v, r, s);
    }
}
