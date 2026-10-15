/* global document */ // used inside page.evaluate callbacks, which run in the browser
// Checks the production build as an installed browser sees it: the service worker installs, the
// app shell loads offline, and the manifest is valid. Uses an installed Microsoft Edge or Chrome
// (no browser download). Usage: npm run build && npx vite preview --port 4173, then
//   node scripts/check-pwa.mjs [http://localhost:4173]
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:4173';
const channel = process.env.PWA_BROWSER ?? 'msedge';

const browser = await chromium.launch({ channel, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

await page.goto(url, { waitUntil: 'networkidle' });
const swState = await page.evaluate(async () => {
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((r) => setTimeout(() => r(null), 15000)),
  ]);
  return reg?.active?.state ?? 'not active';
});
check('Service worker installs and activates', swState === 'activated', swState);

const manifest = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
check(
  'Manifest is installable (name, standalone, 192 + 512 icons)',
  Boolean(
    manifest.name &&
    manifest.display === 'standalone' &&
    manifest.icons?.some((i) => i.sizes === '192x192') &&
    manifest.icons?.some((i) => i.sizes === '512x512'),
  ),
);
const apple = await page.evaluate(() => ({
  touchIcon: Boolean(document.querySelector('link[rel="apple-touch-icon"]')),
  capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
  viewport: document.querySelector('meta[name="viewport"]')?.content ?? '',
}));
check(
  'iOS home-screen tags (touch icon, standalone, safe-area viewport)',
  apple.touchIcon && apple.capable === 'yes' && apple.viewport.includes('viewport-fit=cover'),
);

// Reload with the network off: the app shell must come from the service worker.
await page.reload({ waitUntil: 'networkidle' });
await context.setOffline(true);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const offlineText = await page.evaluate(() => document.body.innerText.slice(0, 200));
check(
  'App shell loads while offline',
  /Sign in|Dashboard|Welcome|Loading/i.test(offlineText),
  offlineText.replace(/\s+/g, ' ').slice(0, 80),
);
await context.setOffline(false);

// Optional: signed in and offline (set PWA_TEST_EMAIL / PWA_TEST_PASSWORD for a test account).
if (process.env.PWA_TEST_EMAIL && process.env.PWA_TEST_PASSWORD) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.fill('#auth-email', process.env.PWA_TEST_EMAIL);
  await page.fill('#auth-password', process.env.PWA_TEST_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('.sync-pill', { timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelector('.sync-pill')?.textContent === 'Synced',
    null,
    { timeout: 20000 },
  );
  const onlineAmount = await page.textContent('.hero-amount').catch(() => null);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1', { timeout: 15000 });
  await page.waitForTimeout(2000);
  const offline = await page.evaluate(() => ({
    h1: document.querySelector('h1')?.textContent,
    amount: document.querySelector('.hero-amount')?.textContent ?? null,
    sync: document.querySelector('.sync-pill')?.textContent ?? null,
  }));
  check(
    'Signed in: dashboard and local data load while offline',
    offline.h1 === 'Dashboard' && offline.amount === onlineAmount,
    `${offline.amount ?? 'no amount'}; status "${offline.sync}"`,
  );
  await context.setOffline(false);
}

const csp = errors.filter((e) => /Content Security Policy/i.test(e));
check('No Content-Security-Policy violations', csp.length === 0, csp.join(' | '));

await browser.close();
for (const r of results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
