// First run of the funnel in a REAL browser: upload -> grid -> editor ->
// cart, driven with Playwright against a production build. This exercises
// exactly the pieces no Node test can: the bundled worker, OffscreenCanvas
// rendering, createImageBitmap decode, pointer-driven drag through the
// editor store, and the React bindings over the tested stores.
//
//   npm run build && npm run start &
//   npx tsx scripts/browser-pass.mts [screenshot-dir]
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright-core';
import { createCanvas } from '@napi-rs/canvas';

const BASE = process.env.PASS_BASE_URL ?? 'http://localhost:3000';
const SHOT_DIR = process.argv[2] ?? 'browser-pass-shots';

// CHROMIUM_PATH wins; otherwise playwright-core's own resolution; otherwise
// scan the browser cache for ANY chromium revision. The last case matters in
// containers that pre-provision a cache built for a different playwright-core
// minor — executablePath() then names a revision that isn't on disk while a
// perfectly good neighbour is.
function resolveChromium(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const resolved = chromium.executablePath();
  if (existsSync(resolved)) return resolved;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    for (const dir of readdirSync(root)) {
      if (!dir.startsWith('chromium-')) continue;
      for (const candidate of [
        `${root}/${dir}/chrome-linux/chrome`,
        `${root}/${dir}/chrome-linux64/chrome`,
      ]) {
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return resolved; // let launch() report the real not-found error
}
const EXECUTABLE = resolveChromium();

mkdirSync(SHOT_DIR, { recursive: true });

let step = 0;
async function shot(page: Page, name: string): Promise<void> {
  step++;
  await page.screenshot({ path: `${SHOT_DIR}/${String(step).padStart(2, '0')}-${name}.png` });
}

let checks = 0;
function ok(label: string, cond: boolean, detail = ''): void {
  if (!cond) throw new Error(`FAIL: ${label} ${detail}`);
  checks++;
  console.log(`  ok  ${label}`);
}

// A photographic test image: gradient + subject blob, 2400x1800 (~4.3MP).
function makeTestPhoto(): Buffer {
  const c = createCanvas(2400, 1800);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 2400, 1800);
  g.addColorStop(0, '#2c5f8a');
  g.addColorStop(1, '#e8a33d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2400, 1800);
  ctx.fillStyle = '#d94f3d';
  ctx.beginPath();
  ctx.arc(1200, 900, 500, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 160px sans-serif';
  ctx.fillText('TEST', 950, 960);
  return c.toBuffer('image/jpeg', 90);
}

const photoPath = `${SHOT_DIR}/test-photo.jpg`;
writeFileSync(photoPath, makeTestPhoto());

// Count canvas elements whose pixels are actually painted (non-blank).
async function paintedCanvases(page: Page): Promise<{ painted: number; total: number }> {
  return page.evaluate(() => {
    const canvases = [...document.querySelectorAll('canvas')];
    let painted = 0;
    for (const c of canvases) {
      const ctx = c.getContext('2d');
      if (!ctx || c.width === 0) continue;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4 * 97) {
        if (d[i]! > 0) {
          painted++;
          break;
        }
      }
    }
    return { painted, total: canvases.length };
  });
}

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

const consoleErrors: string[] = [];
// Expected demo-mode noise: template art 404s until placeholder art exists,
// and upload/sign 503 without Supabase. Everything else is a real error.
const EXPECTED = /Failed to load resource.*status of (404|503)/;
page.on('console', (msg) => {
  if (msg.type() === 'error' && !EXPECTED.test(msg.text())) consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));

try {
  // --- 1. Landing --------------------------------------------------------
  await page.goto(BASE, { waitUntil: 'networkidle' });
  ok('landing renders', (await page.textContent('h1'))!.includes('Upload one photo'));
  await shot(page, 'landing');

  // --- 2. Upload ----------------------------------------------------------
  await page.goto(`${BASE}/upload`, { waitUntil: 'networkidle' });
  ok('upload page renders', (await page.textContent('h1'))!.includes('Drop in a photo'));
  await shot(page, 'upload');

  await page.setInputFiles('input[type="file"]', photoPath);
  await page.waitForURL('**/studio', { timeout: 15_000 });
  ok('photo decode navigates to /studio', true);

  // --- 3. The grid: 11 worker-rendered tiles ------------------------------
  await page.waitForSelector('canvas', { timeout: 20_000 });
  // Give the worker time to stream all tiles.
  await page.waitForFunction(
    () => document.querySelectorAll('canvas').length >= 11,
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1500); // let the last bitmaps paint
  const grid = await paintedCanvases(page);
  ok('grid has 11 product tiles', grid.total >= 11, `saw ${grid.total}`);
  ok('every tile has painted pixels', grid.painted >= 11, `painted ${grid.painted}/${grid.total}`);
  const badges = await page.textContent('body');
  ok('quality badges rendered', badges!.includes('crisp print'));
  await shot(page, 'studio-grid');

  // --- 4. The editor -------------------------------------------------------
  await page.click('a[href="/customize/mug"]');
  await page.waitForURL('**/customize/mug');
  await page.waitForSelector('canvas');
  await page.waitForTimeout(1200);
  let editor = await paintedCanvases(page);
  ok('editor preview painted', editor.painted >= 1);
  await shot(page, 'editor-initial');

  // Drag on the preview: pointer down -> move -> up. This walks the
  // preview()/commit() path in the real store.
  const canvasBox = (await page.locator('canvas').first().boundingBox())!;
  const cx = canvasBox.x + canvasBox.width / 2;
  const cy = canvasBox.y + canvasBox.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(cx + i * 8, cy + i * 3);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
  ok('drag completed without page errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  // Undo must light up after the committed drag.
  const undoDisabled = await page.locator('button:has-text("Undo")').isDisabled();
  ok('drag committed one undo step', !undoDisabled);
  await shot(page, 'editor-after-drag');

  // Rotate (a discrete apply), then undo twice — back to the start state.
  await page.click('button:has-text("Rotate")');
  await page.waitForTimeout(400);
  await page.click('button:has-text("Undo")');
  await page.click('button:has-text("Undo")');
  await page.waitForTimeout(400);
  ok('undo x2 leaves redo available', !(await page.locator('button:has-text("Redo")').isDisabled()));
  await shot(page, 'editor-after-undo');

  // --- 5. Add to cart, twice (the duplicate-SKU case, in the real UI) -----
  // Navigation stays CLIENT-SIDE throughout: the photo lives in an in-memory
  // store, and a hard reload correctly bounces the editor back to /upload.
  await page.click('button:has-text("Add to cart")');
  await page.waitForURL('**/cart');
  await page.goBack(); // SPA back to /customize/mug, store intact
  await page.waitForSelector('button:has-text("Add to cart")', { timeout: 15_000 });
  await page.click('button:has-text("Add to cart")');
  await page.waitForURL('**/cart');
  await page.waitForTimeout(800);

  const cartText = (await page.textContent('body'))!;
  ok('two same-SKU lines exist separately', (cartText.match(/MUG-11-WHT/g) ?? []).length >= 2);
  ok('cart shows the bundle savings line', cartText.includes('Bundle savings'));
  ok('cart computed a total', cartText.includes('Total'));
  await shot(page, 'cart-two-mugs');

  // The mug pair bundle: 2x 1499 = 2998 subtotal, 15% bundle = -450.
  ok('subtotal is the DB price x2', cartText.includes('$29.98'));
  ok('bundle discount is exactly 15% of the pair', cartText.includes('$4.50'));

  // --- 6. Checkout stops honestly in demo mode ----------------------------
  await page.click('button:has-text("Checkout")');
  await page.waitForTimeout(1500);
  const afterCheckout = (await page.textContent('body'))!;
  ok(
    'demo checkout blocks with an actionable message (no Supabase configured)',
    /uploading|failed to upload/i.test(afterCheckout),
  );
  await shot(page, 'cart-checkout-blocked');

  // --- 7. Auth pages render and degrade honestly in demo mode --------------
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  ok('login page renders its form', (await page.textContent('h1'))!.includes('Sign in'));
  await page.fill('input[type="email"]', 'demo@example.com');
  await page.fill('input[type="password"]', 'password123');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(600);
  ok(
    'demo-mode sign-in explains itself instead of crashing',
    (await page.textContent('body'))!.includes('not available on this demo deployment'),
  );
  await shot(page, 'login-demo');

  // --- 8. Admin dashboard explains itself in demo mode ---------------------
  await page.goto(`${BASE}/admin/orders`, { waitUntil: 'networkidle' });
  const adminText = (await page.textContent('body'))!;
  ok(
    'admin orders page renders its unconfigured state without crashing',
    adminText.includes('Orders') && /aren't configured|Sign in/i.test(adminText),
  );
  await shot(page, 'admin-orders');

  // --- Console hygiene ------------------------------------------------------
  ok(
    'no unexpected console errors across the whole pass',
    consoleErrors.length === 0,
    consoleErrors.join(' | '),
  );

  console.log(`\n${checks} browser checks passed. Screenshots in ${SHOT_DIR}/`);
} finally {
  await browser.close();
}
