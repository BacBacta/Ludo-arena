/**
 * Renders the ludo_* SVG masters to the SHIPPED assets:
 *   apps/web/public/avatars/av_<id>.webp  (512×512, transparent corners)
 * matching avatarSrc()'s `av_<id>.webp` pipeline and the rest of the avatar set.
 *
 * WebP, not PNG: MiniPay's submission rules require SVG or WebP for shipped
 * images, and the format is what the PageSpeed floor actually measures (the set
 * went 1.37 MB → 0.24 MB on conversion). Chromium's --screenshot only writes
 * PNG, so we render to a temp PNG and convert. If the converter is missing this
 * script FAILS rather than emitting a .png: a silent PNG here would be invisible
 * until avatarSrc() 404s on it in production.
 *
 * Uses headless Chromium (CHROME env, else the Playwright install path) and
 * `cwebp` (libwebp — `apt-get install webp` / `brew install webp`).
 * Run after generate.mjs: node apps/web/art/avatars/render.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ART = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ART, '..', '..', 'public', 'avatars');
const CHROME = process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (!existsSync(CHROME)) throw new Error(`Chromium not found at ${CHROME} — set CHROME env`);
try {
  execFileSync('cwebp', ['-version'], { stdio: 'ignore' });
} catch {
  throw new Error('cwebp not found — install libwebp (apt-get install webp / brew install webp). Refusing to emit .png: avatarSrc() loads .webp.');
}

const masters = readdirSync(ART).filter((f) => f.startsWith('ludo_') && f.endsWith('.svg'));
for (const f of masters) {
  const id = f.replace(/\.svg$/, '');
  const out = join(PUBLIC, `av_${id}.webp`);
  const tmp = join(ART, `.render_${id}.png`);
  execFileSync(CHROME, [
    '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--default-background-color=00000000', // transparent corners, like the Fluent set
    '--force-device-scale-factor=1', '--window-size=512,512',
    `--screenshot=${tmp}`, `file://${join(ART, f)}`,
  ], { stdio: 'ignore' });
  // -q 82 matches the quality the shipped set was converted at; -alpha_q 100
  // keeps the transparent corners crisp (the whole point of the alpha render).
  execFileSync('cwebp', ['-quiet', '-q', '82', '-alpha_q', '100', tmp, '-o', out], { stdio: 'ignore' });
  rmSync(tmp, { force: true });
  console.log(`[avatars] ${f} -> public/avatars/av_${id}.webp`);
}
console.log(`[avatars] rendered ${masters.length} WebPs`);
