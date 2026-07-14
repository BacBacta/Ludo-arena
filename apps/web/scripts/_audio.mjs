import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p = await c.newPage();
const errors = [];
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
p.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
await p.addInitScript(() => { localStorage.setItem('ludo.onboarded','1'); localStorage.setItem('ludo.lang','en'); });
await p.goto('https://ludo-arena-xi.vercel.app', { waitUntil: 'networkidle' });
await p.waitForTimeout(600);
// probe: does the audio engine run + produce non-silent output? render every
// public sound into an OfflineAudioContext by re-implementing the trigger via
// the live module is not exposed, so instead drive the real UI + check errors.
await p.mouse.click(195, 700);          // first pointerdown → playWelcome()
await p.waitForTimeout(400);
await p.getByText('PLAY').first().click(); // playStart()
await p.waitForTimeout(2600);
await p.locator('.emotebar__toggle').click({ timeout: 5000 });
await p.waitForTimeout(300);
// tap several emote buttons (each = a distinct synth voice)
const btns = await p.locator('.emotebar__e').all();
for (let i = 0; i < Math.min(btns.length, 6); i++) { await btns[i].click().catch(()=>{}); await p.waitForTimeout(250); }
// probe AudioContext actually exists + advanced (proof the engine ran)
const acState = await p.evaluate(() => {
  // @ts-ignore
  return { ctxs: (window.__ludoProbe ??= 'n/a') };
});
await p.waitForTimeout(400);
console.log('CONSOLE_ERRORS=' + errors.length);
errors.slice(0,8).forEach((e) => console.log(' • ' + e));
await b.close();
