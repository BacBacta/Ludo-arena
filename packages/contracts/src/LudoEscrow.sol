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
    uint256 public constant ACTIVE_TIMEOUT = 24 hours; // safety valve: reclaim an
    // Active game that the arbiter never settled (e.g. lost key). Normal games
    // settle in seconds, so this can only trigger on a genuinely stuck escrow.

    address public immutable arbiter;   // server key that signs results
    address public immutable treasury;  // receives the rake
    // Governable within a HARD ceiling (MAX_RAKE_BPS). Kept mutable so the
    // operator can run a 0%-rake acquisition promo or trim the fee WITHOUT a
    // redeploy + escrow migration — while the ceiling guarantees it can never be
    // pushed above 10%. Off-chain display (shared RAKE_BPS) must be kept in step
    // when this changes; both ship at 900 so they agree by default.
    uint256 public rakeBps;             // e.g. 900 = 9%
    address public owner;               // governance: setRakeBps / transferOwnership

    // ---------- State ----------
    enum Status { None, WaitingOpponent, Active, Settled, Refunded }

    struct Game {
        address token;      // stablecoin (cUSD/USDC/USDT)
        uint96 stake;       // stake per player
        address playerA;
        address playerB;
        uint40 createdAt;
        Status status;
        uint16 rakeBps;     // rake SNAPSHOT at creation — settle can't be re-priced mid-game
    }

    mapping(bytes32 => Game) public games;
    /// @notice Only allowlisted stablecoins may be staked. Keeps out fee-on-transfer
    ///         / rebasing / hostile tokens that would break `pot == stake*2`.
    mapping(address => bool) public allowedToken;
    /// @notice Pull-payment credits (C3 fix): funds a PUSH could not deliver — e.g.
    ///         a stablecoin (USDT/USDC) that blacklists/freezes one recipient — are
    ///         recorded here instead of reverting the whole call. Without this, a
    ///         single unpayable winner/refundee would lock BOTH stakes forever (no
    ///         escape valve: settle, voidGame and refundActive all pushed). The
    ///         credited party pulls it via withdraw() once it can receive again.
    mapping(address => mapping(address => uint256)) public withdrawable; // token => account => amount

    // ---------- Events ----------
    event Joined(bytes32 indexed gameId, address indexed player, address token, uint96 stake);
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

    /// @notice Governance: adjust the rake within [0, MAX_RAKE_BPS]. Emits the
    ///         old→new bps so every change is auditable on-chain.
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

    /// @notice Allowlist (or remove) a stablecoin that may be staked. Only vetted
    ///         bool-or-void ERC20s with 1:1 transfers (cUSD/USDC/USDT) should be added.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    /// @dev SafeERC20: tolerates non-bool-returning tokens (canonical USDT) —
    ///      succeeds on empty returndata or an explicit `true`, reverts otherwise.
    function _safeTransfer(address token, address to, uint256 value) internal {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, value));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
    function _safeTransferFrom(address token, address from, address to, uint256 value) internal {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    /// @dev Non-reverting transfer: returns false instead of reverting, so ONE
    ///      unpayable recipient can't abort a settlement/refund. Safe because only
    ///      vetted, allowlisted stablecoins are ever the token — no ERC777 hooks,
    ///      no reentrancy/gas-griefing surface.
    function _tryTransfer(address token, address to, uint256 value) internal returns (bool) {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, value));
        return success && (data.length == 0 || abi.decode(data, (bool)));
    }

    /// @dev Push `value` to `to`; if the token refuses it (blacklist / frozen
    ///      account), record a withdrawable credit instead of reverting — the C3
    ///      fix that keeps one bad recipient from locking both stakes.
    function _payOrCredit(bytes32 gameId, address token, address to, uint256 value) internal {
        if (value == 0) return;
        if (!_tryTransfer(token, to, value)) {
            withdrawable[token][to] += value;
            emit Credited(gameId, to, token, value);
        }
    }

    /// @notice Joins (or creates) game `gameId` by locking one's stake.
    ///         The first call sets token + stake; the second must match.
    function join(bytes32 gameId, address token, uint96 stake) external {
        if (stake == 0) revert BadStake();
        Game storage g = games[gameId];

        if (g.status == Status.None) {
            if (!allowedToken[token]) revert TokenNotAllowed();
            g.token = token;
            g.stake = stake;
            g.playerA = msg.sender;
            g.createdAt = uint40(block.timestamp);
            g.status = Status.WaitingOpponent;
            g.rakeBps = uint16(rakeBps); // snapshot the fee at creation
        } else if (g.status == Status.WaitingOpponent) {
            if (msg.sender == g.playerA) revert AlreadyJoined();
            if (token != g.token || stake != g.stake) revert BadStake();
            g.playerB = msg.sender;
            g.status = Status.Active;
        } else {
            revert BadStatus();
        }

        _safeTransferFrom(token, msg.sender, address(this), stake);
        emit Joined(gameId, msg.sender, token, stake);
    }

    /// @notice Settles the game. `sig` = the arbiter's ECDSA signature over
    ///         keccak256(abi.encode(DOMAIN, gameId, winner)).
    function settle(bytes32 gameId, address winner, bytes calldata sig) external {
        _settle(gameId, winner, sig);
    }

    /// @notice Settle many games in one transaction, amortising the ~21k base tx
    ///         cost across the batch — the concrete margin relief for low-stake
    ///         pots where per-settlement gas rivals the rake. Index-aligned;
    ///         atomic (any bad entry reverts the whole batch).
    function settleBatch(bytes32[] calldata gameIds, address[] calldata winners, bytes[] calldata sigs) external {
        if (gameIds.length != winners.length || gameIds.length != sigs.length) revert LengthMismatch();
        for (uint256 i = 0; i < gameIds.length; i++) {
            _settle(gameIds[i], winners[i], sigs[i]);
        }
    }

    function _settle(bytes32 gameId, address winner, bytes calldata sig) internal {
        Game storage g = games[gameId];
        if (g.status != Status.Active) revert BadStatus();
        if (winner != g.playerA && winner != g.playerB) revert NotAPlayer();

        bytes32 digest = settlementDigest(gameId, winner);
        if (_recover(digest, sig) != arbiter) revert BadSignature();

        g.status = Status.Settled;
        uint256 pot = uint256(g.stake) * 2;
        uint256 rake = (pot * g.rakeBps) / 10_000; // snapshotted at creation
        uint256 payout = pot - rake;

        // Pay-or-credit both legs: a blacklisted winner (or treasury) is credited
        // for later withdrawal rather than reverting — one unpayable recipient can
        // no longer strand the pot (C3 posture, matching LudoEscrowN).
        _payOrCredit(gameId, g.token, winner, payout);
        _payOrCredit(gameId, g.token, treasury, rake);
        emit Settled(gameId, winner, payout, rake);
    }

    /// @notice Refunds playerA if nobody joined after JOIN_TIMEOUT.
    function refundExpired(bytes32 gameId) external {
        Game storage g = games[gameId];
        if (g.status != Status.WaitingOpponent) revert BadStatus();
        if (block.timestamp < g.createdAt + JOIN_TIMEOUT) revert NotExpired();
        g.status = Status.Refunded;
        // Pay-or-credit: a blacklisted lone staker is credited, never blocked.
        _payOrCredit(gameId, g.token, g.playerA, g.stake);
        emit Refunded(gameId);
    }

    /// @notice Arbiter-driven void of an Active game: returns each stake to its
    ///         depositor (e.g. the reported winner isn't a player, or a dispute).
    ///         Like settle(), the arbiter can only return funds to the two
    ///         players — never divert them.
    function voidGame(bytes32 gameId) external {
        if (msg.sender != arbiter) revert NotArbiter();
        _refundBoth(gameId);
    }

    /// @notice Permissionless safety valve: if an Active game was never settled
    ///         within ACTIVE_TIMEOUT, either player (or anyone) can return both
    ///         stakes to their depositors. Guards against a lost arbiter key
    ///         locking funds forever — the #1 fund-lock risk.
    function refundActive(bytes32 gameId) external {
        Game storage g = games[gameId];
        if (block.timestamp < g.createdAt + ACTIVE_TIMEOUT) revert NotExpired();
        _refundBoth(gameId);
    }

    function _refundBoth(bytes32 gameId) internal {
        Game storage g = games[gameId];
        if (g.status != Status.Active) revert BadStatus();
        g.status = Status.Refunded;
        // Pay-or-credit each player: one blacklisted/frozen depositor is credited
        // for withdrawal and never blocks the other's refund (C3). Status is
        // already Refunded (CEI), so this can't be re-entered to double-refund.
        _payOrCredit(gameId, g.token, g.playerA, g.stake);
        _payOrCredit(gameId, g.token, g.playerB, g.stake);
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
        // Reject non-canonical (malleable) signatures: high-s half and non-{27,28} v.
        // viem/@noble produce canonical low-s, v∈{27,28} sigs, so this is transparent
        // to the real arbiter and only blocks malformed input (OZ ECDSA hygiene).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
