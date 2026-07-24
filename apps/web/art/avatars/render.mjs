/**
 * Renders the ludo_* SVG masters to the SHIPPED assets:
 *   apps/web/public/avatars/av_<id>.png  (512×512, transparent corners)
 * so avatarSrc()'s `av_<id>.png` pipeline needs no change and the files behave
 * exactly like the existing Fluent PNGs (alpha background).
 *
 * Uses headless Chromium (CHROME env, else the Playwright install path).
 * Run after generate.mjs: node apps/web/art/avatars/render.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ART = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ART, '..', '..', 'public', 'avatars');
const CHROME = process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (!existsSync(CHROME)) throw new Error(`Chromium not found at ${CHROME} — set CHROME env`);

const masters = readdirSync(ART).filter((f) => f.startsWith('ludo_') && f.endsWith('.svg'));
for (const f of masters) {
  const id = f.replace(/\.svg$/, '');
  const out = join(PUBLIC, `av_${id}.png`);
  const tmp = join(ART, `.render_${id}.png`);
  execFileSync(CHROME, [
    '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--default-background-color=00000000', // transparent corners, like the Fluent set
    '--force-device-scale-factor=1', '--window-size=512,512',
    `--screenshot=${tmp}`, `file://${join(ART, f)}`,
  ], { stdio: 'ignore' });
  copyFileSync(tmp, out);
  execFileSync('rm', ['-f', tmp]);
  console.log(`[avatars] ${f} -> public/avatars/av_${id}.png`);
}
console.log(`[avatars] rendered ${masters.length} PNGs`);
