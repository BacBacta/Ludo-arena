/**
 * Dev/QA cosmetic unlock: wallets in this allowlist get EVERY dice skin and
 * avatar frame unlocked in the pickers, so the owner can test all cosmetics
 * without grinding or buying. Scoped to specific addresses — real players are
 * unaffected. Cosmetics are client-authoritative (no economic value), so a
 * client-side allowlist is consistent with the existing trust model.
 */
const DEV_UNLOCK_WALLETS = new Set<string>([
  '0x3154835deaf9df60a7acaf45955236e73ad84502',
]);

export function devUnlockCosmetics(wallet: string | null | undefined): boolean {
  return !!wallet && DEV_UNLOCK_WALLETS.has(wallet.toLowerCase());
}
