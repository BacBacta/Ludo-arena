/**
 * Audit harness runner — executes every probe sequentially against the local
 * stack and prints one consolidated verdict. See e2e/README.md for setup.
 *
 * Exit code 0 = every suite green.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ['wire-regression.mjs', 10 * 60_000],
  ['wire-identity.mjs', 6 * 60_000],
  ['wire-gates.mjs', 3 * 60_000],
  ['wire-4p.mjs', 7 * 60_000],
  ['ui-2p.mjs', 9 * 60_000],
  ['ui-dice.mjs', 6 * 60_000],
  ['ui-4p.mjs', 4 * 60_000],
  ['ui-practice.mjs', 6 * 60_000],
  ['ui-wallet.mjs', 4 * 60_000], // Phase 3: mocked MiniPay + mobile viewport
  ['ui-mobile.mjs', 5 * 60_000], // Phase 3: full journey on Android 360x800
];

const run = (file, timeout) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(here, file)], { stdio: 'inherit', env: process.env });
  const killer = setTimeout(() => { child.kill('SIGKILL'); resolve(124); }, timeout);
  child.on('exit', (code) => { clearTimeout(killer); resolve(code ?? 1); });
});

const results = [];
for (const [file, timeout] of SUITES) {
  console.log(`\n════════════════ ${file} ════════════════`);
  const code = await run(file, timeout);
  results.push([file, code]);
}

console.log('\n════════════════ SUMMARY ════════════════');
for (const [file, code] of results) {
  console.log(`${code === 0 ? '✅' : code === 124 ? '⏱️  TIMEOUT' : '❌'} ${file}`);
}
const bad = results.filter(([, c]) => c !== 0);
console.log(bad.length ? `\n${bad.length}/${results.length} suites failing` : `\nall ${results.length} suites green`);
process.exit(bad.length ? 1 : 0);
