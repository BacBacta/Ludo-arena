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
    // Governable within a HARD ceiling (MAX_RAKE_BPS): promos / fee trims without
    // a redeploy, but never above 10%. Keep off-chain RAKE_BPS in step; both 900.
    uint256 public rakeBps; // e.g. 900 = 9%
    address public owner; // governance: setRakeBps / transferOwnership

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
        uint16 rakeBps; // rake SNAPSHOT at creation — settle can't be re-priced mid-game
    }

    mapping(bytes32 => Game) public games;
    mapping(bytes32 => address[]) internal _seats; // depositors, in join order
    mapping(bytes32 => mapping(address => bool)) internal _isSeated;
    /// @notice Only allowlisted stablecoins may be staked (no fee-on-transfer/hostile).
    mapping(address => bool) public allowedToken;
    /// @notice Pull-payment credits (C3 fix): funds a PUSH could not deliver — e.g.
    ///         a stablecoin (USDT/USDC) that blacklists/freezes one recipient — are
    ///         recorded here instead of reverting the whole call. This is what stops
    ///         a single unpayable seat from locking a refund/settlement for EVERYONE
    ///         else. The credited party pulls it via withdraw() once it can receive.
    mapping(address => mapping(address => uint256)) public withdrawable; // token => account => amount

    // ---------- Events ----------
    event Joined(bytes32 indexed gameId, address indexed player, address token, uint96 stake, uint8 joined, uint8 seatCount);
    event Settled(bytes32 indexed gameId, address indexed winner, uint256 payout, uint256 rake);
    event Refunded(bytes32 indexed gameId);
    /// @notice A push transfer could not be delivered; `amount` is now withdrawable by `account`.
    event Credited(bytes32 indexed gameId, address indexed account, address token, uint256 amount);
    event Withdrawn(address indexed account, address token, uint256 amount);
    event RakeChanged(uint256 oldBps, uint256 newBps);
    event OwnershipTransferred(address indexed from, address indexed to);
    event TokenAllowed(address indexed token, bool allowed);

    error BadStatus();
    error BadStake();
    error BadSeatCount();
    error AlreadyJoined();
    error NotExpired();
    error BadSignature();
    error NotAPlayer();
    error TransferFailed();
    error NotArbiter();
    error NotOwner();
    error LengthMismatch();
    error TokenNotAllowed();
    error NothingToWithdraw();

    constructor(address _arbiter, address _treasury, uint256 _rakeBps) {
        require(_rakeBps <= MAX_RAKE_BPS, "rake > max");
        require(_arbiter != address(0) && _treasury != address(0), "zero addr");
        arbiter = _arbiter;
        treasury = _treasury;
        rakeBps = _rakeBps;
        owner = _treasury; // governance defaults to the rake beneficiary (→ multisig)
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Governance: adjust the rake within [0, MAX_RAKE_BPS], audit-logged.
    function setRakeBps(uint256 newBps) external onlyOwner {
        require(newBps <= MAX_RAKE_BPS, "rake > max");
        emit RakeChanged(rakeBps, newBps);
        rakeBps = newBps;
    }

    /// @notice Hand governance (rake control) to a new address — e.g. a multisig.
    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /// @notice Allowlist (or remove) a stablecoin that may be staked.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    /// @dev SafeERC20: tolerates non-bool-returning tokens (canonical USDT).
    function _safeTransfer(address token, address to, uint256 value) internal {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, value));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
    function _safeTransferFrom(address token, address from, address to, uint256 value) internal {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    /// @dev Non-reverting transfer: returns false instead of reverting, so ONE
    ///      unpayable recipient can't abort a whole batch. Safe here because only
    ///      vetted, allowlisted stablecoins are ever the token — no ERC777 hooks,
    ///      no reentrancy/gas-griefing surface.
    function _tryTransfer(address token, address to, uint256 value) internal returns (bool) {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, value));
        return success && (data.length == 0 || abi.decode(data, (bool)));
    }

    /// @dev Push `value` to `to`; if the token refuses it (blacklist / frozen
    ///      account), record a withdrawable credit instead of reverting — the
    ///      C3 fix that keeps one bad recipient from locking everyone's funds.
    function _payOrCredit(bytes32 gameId, address token, address to, uint256 value) internal {
        if (value == 0) return;
        if (!_tryTransfer(token, to, value)) {
            withdrawable[token][to] += value;
            emit Credited(gameId, to, token, value);
        }
    }

    /// @notice Join (or create) game `gameId` by locking one seat's stake. The
    ///         first call sets token + stake + seatCount; later joiners must match.
    ///         When `seatCount` seats are filled the game goes Active.
    function join(bytes32 gameId, address token, uint96 stake, uint8 seatCount) external {
        if (stake == 0) revert BadStake();
        Game storage g = games[gameId];

        if (g.status == Status.None) {
            if (seatCount < MIN_SEATS || seatCount > MAX_SEATS) revert BadSeatCount();
            if (!allowedToken[token]) revert TokenNotAllowed();
            g.token = token;
            g.stake = stake;
            g.seatCount = seatCount;
            g.createdAt = uint40(block.timestamp);
            g.status = Status.Filling;
            g.rakeBps = uint16(rakeBps); // snapshot the fee at creation
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

        _safeTransferFrom(token, msg.sender, address(this), stake);
        emit Joined(gameId, msg.sender, token, stake, g.joined, g.seatCount);
    }

    /// @notice Settle the game. `sig` = the arbiter's ECDSA signature over
    ///         keccak256(abi.encode(chainid, this, gameId, winner)). The winner
    ///         must be one of the depositors.
    function settle(bytes32 gameId, address winner, bytes calldata sig) external {
        _settle(gameId, winner, sig);
    }

    /// @notice Settle many games in one transaction, amortising the base tx cost
    ///         across the batch. Index-aligned; atomic (any bad entry reverts all).
    function settleBatch(bytes32[] calldata gameIds, address[] calldata winners, bytes[] calldata sigs) external {
        if (gameIds.length != winners.length || gameIds.length != sigs.length) revert LengthMismatch();
        for (uint256 i = 0; i < gameIds.length; i++) {
            _settle(gameIds[i], winners[i], sigs[i]);
        }
    }

    function _settle(bytes32 gameId, address winner, bytes calldata sig) internal {
        Game storage g = games[gameId];
        if (g.status != Status.Active) revert BadStatus();
        if (!_isSeated[gameId][winner]) revert NotAPlayer();
        if (_recover(settlementDigest(gameId, winner), sig) != arbiter) revert BadSignature();

        g.status = Status.Settled;
        uint256 pot = uint256(g.stake) * g.seatCount;
        uint256 rake = (pot * g.rakeBps) / 10_000; // snapshotted at creation
        uint256 payout = pot - rake;

        // Pay-or-credit both legs: a blacklisted winner (or treasury) is credited
        // for later withdrawal rather than blocking settlement (same C3 posture).
        _payOrCredit(gameId, g.token, winner, payout);
        _payOrCredit(gameId, g.token, treasury, rake);
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
        // Pay-or-credit each seat: one blacklisted/frozen depositor is credited for
        // withdrawal and never blocks the refunds of the others (C3). Status is
        // already Refunded (CEI), so this can't be re-entered to double-refund.
        for (uint256 i = 0; i < s.length; i++) {
            _payOrCredit(gameId, token, s[i], stake);
        }
        emit Refunded(gameId);
    }

    /// @notice Pull a credit that a push transfer could not deliver (see
    ///         `withdrawable`). CEI: the balance is zeroed before the transfer, so
    ///         a still-failing transfer reverts the whole call and preserves it.
    function withdraw(address token) external {
        uint256 amount = withdrawable[token][msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        withdrawable[token][msg.sender] = 0;
        _safeTransfer(token, msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
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
