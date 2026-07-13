// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title LudoEscrowN — N-player stake escrow for Ludo Arena (2..MAX_SEATS)
/// @notice Generalises the 1v1 LudoEscrow to N seats: every seat locks the same
///         stake; the arbiter (server key) signs the SINGLE winner, who receives
///         pot − rake. The arbiter can only ever pay a depositor — it can never
///         divert the funds. Same safety posture as LudoEscrow.
/// @dev Invariants: payout + rake == pot (pot = stake * seatCount); a gameId
///      settles/refunds only once; rake capped at MAX_RAKE_BPS (immutable).
contract LudoEscrowN {
    // ---------- Config ----------
    uint256 public constant MAX_RAKE_BPS = 1_000; // 10% max, immutable
    uint256 public constant JOIN_TIMEOUT = 120; // seconds to fill before refundUnfilled
    uint256 public constant ACTIVE_TIMEOUT = 24 hours; // lost-key safety valve
    uint8 public constant MIN_SEATS = 2;
    uint8 public constant MAX_SEATS = 4;

    address public immutable arbiter; // server key that signs results
    address public immutable treasury; // receives the rake
    uint256 public immutable rakeBps; // e.g. 900 = 9%

    // ---------- State ----------
    enum Status {
        None,
        Filling,
        Active,
        Settled,
        Refunded
    }

    struct Game {
        address token; // stablecoin (cUSD/USDC/USDT)
        uint96 stake; // stake per seat
        uint8 seatCount; // seats required to go Active (2..MAX_SEATS)
        uint8 joined; // seats filled so far
        uint40 createdAt;
        Status status;
    }

    mapping(bytes32 => Game) public games;
    mapping(bytes32 => address[]) internal _seats; // depositors, in join order
    mapping(bytes32 => mapping(address => bool)) internal _isSeated;

    // ---------- Events ----------
    event Joined(bytes32 indexed gameId, address indexed player, address token, uint96 stake, uint8 joined, uint8 seatCount);
    event Settled(bytes32 indexed gameId, address indexed winner, uint256 payout, uint256 rake);
    event Refunded(bytes32 indexed gameId);

    error BadStatus();
    error BadStake();
    error BadSeatCount();
    error AlreadyJoined();
    error NotExpired();
    error BadSignature();
    error NotAPlayer();
    error TransferFailed();
    error NotArbiter();

    constructor(address _arbiter, address _treasury, uint256 _rakeBps) {
        require(_rakeBps <= MAX_RAKE_BPS, "rake > max");
        require(_arbiter != address(0) && _treasury != address(0), "zero addr");
        arbiter = _arbiter;
        treasury = _treasury;
        rakeBps = _rakeBps;
    }

    /// @notice Join (or create) game `gameId` by locking one seat's stake. The
    ///         first call sets token + stake + seatCount; later joiners must match.
    ///         When `seatCount` seats are filled the game goes Active.
    function join(bytes32 gameId, address token, uint96 stake, uint8 seatCount) external {
        if (stake == 0) revert BadStake();
        Game storage g = games[gameId];

        if (g.status == Status.None) {
            if (seatCount < MIN_SEATS || seatCount > MAX_SEATS) revert BadSeatCount();
            g.token = token;
            g.stake = stake;
            g.seatCount = seatCount;
            g.createdAt = uint40(block.timestamp);
            g.status = Status.Filling;
        } else if (g.status == Status.Filling) {
            if (token != g.token || stake != g.stake || seatCount != g.seatCount) revert BadStake();
            if (_isSeated[gameId][msg.sender]) revert AlreadyJoined();
        } else {
            revert BadStatus();
        }

        // Effects before interaction (CEI): record the seat, then pull the stake.
        _seats[gameId].push(msg.sender);
        _isSeated[gameId][msg.sender] = true;
        g.joined += 1;
        if (g.joined == g.seatCount) g.status = Status.Active;

        if (!IERC20(token).transferFrom(msg.sender, address(this), stake)) revert TransferFailed();
        emit Joined(gameId, msg.sender, token, stake, g.joined, g.seatCount);
    }

    /// @notice Settle the game. `sig` = the arbiter's ECDSA signature over
    ///         keccak256(abi.encode(chainid, this, gameId, winner)). The winner
    ///         must be one of the depositors.
    function settle(bytes32 gameId, address winner, bytes calldata sig) external {
        Game storage g = games[gameId];
        if (g.status != Status.Active) revert BadStatus();
        if (!_isSeated[gameId][winner]) revert NotAPlayer();
        if (_recover(settlementDigest(gameId, winner), sig) != arbiter) revert BadSignature();

        g.status = Status.Settled;
        uint256 pot = uint256(g.stake) * g.seatCount;
        uint256 rake = (pot * rakeBps) / 10_000;
        uint256 payout = pot - rake;

        if (!IERC20(g.token).transfer(winner, payout)) revert TransferFailed();
        if (rake > 0 && !IERC20(g.token).transfer(treasury, rake)) revert TransferFailed();
        emit Settled(gameId, winner, payout, rake);
    }

    /// @notice Refund every depositor if the table never filled within JOIN_TIMEOUT.
    function refundUnfilled(bytes32 gameId) external {
        Game storage g = games[gameId];
        if (g.status != Status.Filling) revert BadStatus();
        if (block.timestamp < g.createdAt + JOIN_TIMEOUT) revert NotExpired();
        _refundAll(gameId);
    }

    /// @notice Arbiter-driven void of an Active game: returns each stake to its
    ///         depositor. Like settle(), the arbiter can only return funds to the
    ///         players — never divert them.
    function voidGame(bytes32 gameId) external {
        if (msg.sender != arbiter) revert NotArbiter();
        Game storage g = games[gameId];
        if (g.status != Status.Active) revert BadStatus();
        _refundAll(gameId);
    }

    /// @notice Permissionless safety valve: an Active game never settled within
    ///         ACTIVE_TIMEOUT can be refunded to its depositors by anyone. Guards
    ///         against a lost arbiter key locking funds forever.
    function refundActive(bytes32 gameId) external {
        Game storage g = games[gameId];
        if (g.status != Status.Active) revert BadStatus();
        if (block.timestamp < g.createdAt + ACTIVE_TIMEOUT) revert NotExpired();
        _refundAll(gameId);
    }

    function _refundAll(bytes32 gameId) internal {
        Game storage g = games[gameId];
        g.status = Status.Refunded;
        address[] storage s = _seats[gameId];
        uint96 stake = g.stake;
        address token = g.token;
        for (uint256 i = 0; i < s.length; i++) {
            if (!IERC20(token).transfer(s[i], stake)) revert TransferFailed();
        }
        emit Refunded(gameId);
    }

    /// @notice The depositors of a game, in join order (seat index).
    function seatsOf(bytes32 gameId) external view returns (address[] memory) {
        return _seats[gameId];
    }

    // ---------- Signatures ----------

    function settlementDigest(bytes32 gameId, address winner) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32", keccak256(abi.encode(block.chainid, address(this), gameId, winner))
            )
        );
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        // Reject non-canonical (malleable) signatures: high-s half and non-{27,28} v.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
