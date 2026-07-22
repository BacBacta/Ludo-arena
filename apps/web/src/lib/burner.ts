/**
 * Burner wallet (B1 — non-MiniPay launch). Outside MiniPay a player has no wallet
 * that can pay gas in cUSD, and a brand-new external wallet (MetaMask/WalletConnect)
 * has no native CELO to transact at all. So instead of borrowing the player's
 * wallet, the app MINTS one: a locally-generated EOA whose key lives in the
 * browser. Because WE now control transaction construction, every tx it sends can
 * set Celo's `feeCurrency` (gas paid in cUSD — see escrow.ts / minipay.ts), funded
 * by the faucet's cUSD grant. Net result: the player needs NO CELO, ever, and no
 * wallet install — one tap and they're in.
 *
 * Custody: the key sits in localStorage. That is XSS-exposed and non-recoverable
 * across devices — acceptable ONLY because this wallet holds trivial event funds
 * (a 1¢ stake budget). It is NOT for real balances; never route non-event money
 * through it. (The upgrade path is an embedded-wallet provider with passkey
 * recovery — same feeCurrency flow, better custody — see B2.)
 */
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { activeChain } from './chains';
import type { Wallet } from './minipay';

const KEY = 'ludo:burner:pk:v1';

/** A private key looks like 0x + 64 hex chars — reject anything else so a
 *  corrupted/space-padded localStorage value can't crash privateKeyToAccount. */
function isValidKey(v: string | null): v is Hex {
  return !!v && /^0x[0-9a-fA-F]{64}$/.test(v);
}

function readStoredKey(): Hex | null {
  try {
    const v = localStorage.getItem(KEY);
    return isValidKey(v) ? v : null;
  } catch {
    return null; // storage unavailable (private mode / SSR) — caller falls back
  }
}

/** The persisted burner key, minting + storing one on first use. Throws only if
 *  localStorage is entirely unavailable AND we can't hold a key (private mode). */
export function loadOrCreateBurnerKey(): Hex {
  const existing = readStoredKey();
  if (existing) return existing;
  const pk = generatePrivateKey();
  try {
    localStorage.setItem(KEY, pk);
  } catch {
    /* ephemeral: the key lives only for this tab session if storage is blocked */
  }
  return pk;
}

/** True once a burner has been created (so the UI can tell "returning" from
 *  "first visit" without instantiating clients). */
export function hasBurner(): boolean {
  return readStoredKey() !== null;
}

/** The burner's address without building any client — null if none exists yet.
 *  Cheap enough for render paths (derives the address from the stored key). */
export function burnerAddress(): Address | null {
  const pk = readStoredKey();
  return pk ? privateKeyToAccount(pk).address : null;
}

/** Build a Wallet (same shape as the injected/WalletConnect path) backed by the
 *  local burner account on the active chain. The account signs locally, so there
 *  is no popup for SIWE or txs — and tx construction is ours, which is what lets
 *  the caller attach `feeCurrency` (gas in cUSD). */
export function getBurnerWallet(): Wallet {
  const account = privateKeyToAccount(loadOrCreateBurnerKey());
  const walletClient = createWalletClient({ account, chain: activeChain, transport: http() });
  // Celo mines ~1s blocks; viem's default 4s receipt polling quadruples the
  // wait on every approve/join — the bulk of the paired-players' staking lag.
  const publicClient = createPublicClient({ chain: activeChain, transport: http(), pollingInterval: 1_000 });
  return {
    // Celo chains add custom formatters, so the inferred client types diverge
    // from viem's plain Wallet/PublicClient; flatten at this boundary (same as
    // connectWalletWith in minipay.ts).
    walletClient: walletClient as unknown as WalletClient,
    publicClient: publicClient as unknown as PublicClient,
    address: account.address,
    // The whole point of the burner: we build the tx, so it pays gas in cUSD
    // (Celo feeCurrency) and the player never needs native CELO.
    payGasInStable: true,
  };
}

/** Boot-time restore: the persisted burner as a ready Wallet, or null when none
 *  exists. NEVER mints — a first-time visitor must stay burner-less until they
 *  actually join the event (joinRaceWeek is the only minting path). Without this
 *  restore a page reload left the app wallet-less: the staked queue then entered
 *  DEMO mode (walletBacked=false) and could never pair with a wallet-backed
 *  opponent — the "matchmaking spins forever" incident. */
export function restoreBurnerWallet(): Wallet | null {
  return hasBurner() ? getBurnerWallet() : null;
}

/** Wipe the burner (e.g. a "start over" affordance). Rarely needed — the same
 *  wallet is meant to persist for the whole event so the Pass + grant follow it. */
export function clearBurner(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
