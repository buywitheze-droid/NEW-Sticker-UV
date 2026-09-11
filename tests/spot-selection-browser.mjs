// Run against a running dev server:
// PLAYWRIGHT_MODULE=/mnt/pid2/node_modules/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium \
//   node tests/spot-selection-browser.mjs
//
// This is intentionally a browser regression test. The artwork is large enough
// to exercise the upload/preview path, and contains disconnected components of
// several exact palette colours so the region worker has real work to do.
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || '/mnt/pid2/node_modules/playwright/index.mjs'
);
const executablePath = process.env.CHROMIUM_EXECUTABLE ||
  '/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium';
const baseURL = process.env.TEST_BASE_URL ||
  `https://${process.env.REPLIT_DEV_DOMAIN}`;

assert.ok(process.env.REPLIT_DEV_DOMAIN || process.env.TEST_BASE_URL,
  'Set REPLIT_DEV_DOMAIN or TEST_BASE_URL before running this browser test');

const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox'],
});

function makeArtwork(name, variant = 0) {
  const artwork = createCanvas(2400, 1600);
  const ctx = artwork.getContext('2d');
  ctx.clearRect(0, 0, 2400, 1600);

  // Every colour is used in at least two large, disconnected shapes. The
  // transparent gaps are intentional: they must remain gaps in regionMap.
  const shapes = variant === 0
    ? [
        ['#DC1E1E', () => { ctx.fillRect(110, 130, 410, 300); ctx.fillRect(1770, 150, 440, 300); }],
        ['#2864DC', () => { ctx.beginPath(); ctx.arc(760, 330, 210, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(1440, 330, 175, 0, Math.PI * 2); ctx.fill(); }],
        ['#32B450', () => { ctx.beginPath(); ctx.moveTo(160, 850); ctx.lineTo(570, 630); ctx.lineTo(720, 1110); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.moveTo(1710, 820); ctx.lineTo(2090, 650); ctx.lineTo(2220, 1100); ctx.closePath(); ctx.fill(); }],
        ['#8C3CB4', () => { ctx.fillRect(790, 720, 300, 360); ctx.fillRect(1240, 840, 330, 310); }],
        ['#F07814', () => { ctx.beginPath(); ctx.ellipse(410, 1320, 220, 125, 0, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.ellipse(1900, 1330, 240, 125, 0, 0, Math.PI * 2); ctx.fill(); }],
        ['#FAD232', () => { ctx.beginPath(); ctx.moveTo(870, 1330); ctx.lineTo(1050, 1190); ctx.lineTo(1220, 1340); ctx.lineTo(1050, 1480); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.moveTo(1320, 1330); ctx.lineTo(1480, 1190); ctx.lineTo(1660, 1340); ctx.lineTo(1490, 1480); ctx.closePath(); ctx.fill(); }],
      ]
    : [
        ['#DC1E1E', () => { ctx.fillRect(160, 220, 480, 270); ctx.fillRect(1710, 1040, 480, 280); }],
        ['#23BEE6', () => { ctx.beginPath(); ctx.arc(680, 1160, 205, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(1590, 410, 190, 0, Math.PI * 2); ctx.fill(); }],
        ['#8C3CB4', () => { ctx.fillRect(900, 170, 300, 370); ctx.fillRect(1080, 1060, 360, 310); }],
        ['#FAD232', () => { ctx.beginPath(); ctx.moveTo(220, 810); ctx.lineTo(480, 610); ctx.lineTo(690, 820); ctx.lineTo(450, 1010); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.moveTo(1770, 740); ctx.lineTo(2020, 570); ctx.lineTo(2200, 810); ctx.lineTo(1980, 1000); ctx.closePath(); ctx.fill(); }],
      ];

  for (const [colour, draw] of shapes) {
    ctx.fillStyle = colour;
    draw();
  }

  return {
    name,
    mimeType: 'image/png',
    buffer: artwork.toBuffer('image/png'),
  };
}

const artwork = makeArtwork('spot-selection-regression.png');
const freshArtwork = makeArtwork('spot-selection-fresh.png', 1);

function timeoutPromise(label, timeoutMs = 15000) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  });
}

async function waitForPromise(promise, label, timeoutMs = 15000) {
  await Promise.race([promise, timeoutPromise(label, timeoutMs)]);
}

async function openSpotColors(page) {
  await page.getByRole('button', { name: 'Spot White and Gloss', exact: true }).click();
  await page.locator('[data-color-index]').first().waitFor({ timeout: 30000 });
  await page.locator('button[title^="Apply White to all shapes"]').first().waitFor({
    timeout: 30000,
  });
}

async function selectWhiteAndGloss(page) {
  const card = page.locator('[data-color-index]').first();
  await card.locator('button[title^="Apply White to all shapes"]').click();
  await card.locator('button[title^="Apply Gloss to all shapes"]').click();
  await assertSelected(card, 'palette selection');
  return card;
}

async function assertSelected(card, phase) {
  assert.equal(
    await card.locator('button[title="Remove White from all shapes"]').count(),
    1,
    `${phase}: White selection was lost`,
  );
  assert.equal(
    await card.locator('button[title="Remove Gloss from all shapes"]').count(),
    1,
    `${phase}: Gloss selection was lost`,
  );
}

async function scrollWheelResize(page, card) {
  const colorList = page.locator('div.max-h-\\[400px\\].overflow-y-auto').first();
  await colorList.hover();
  await page.mouse.wheel(0, 420);
  await page.waitForTimeout(150);
  await assertSelected(card, 'after palette-list wheel');

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(100);
  await assertSelected(card, 'after document scroll');

  await page.setViewportSize({ width: 980, height: 720 });
  await page.waitForTimeout(150);
  await assertSelected(card, 'after viewport resize');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(150);
  await assertSelected(card, 'after viewport restore');

  // Exercise the actual size editor rather than only changing the viewport.
  await page.getByText('Size', { exact: true }).first().click();
  const width = page.locator('input[title^="Width"]').first();
  await width.click();
  await width.fill('8.40');
  await width.press('Enter');
  await page.waitForTimeout(900);
  await assertSelected(card, 'after artwork resize');
}

async function runDelayedQrScenario() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let releaseQR;
  let resolveQRSeen;
  let resolveQRComplete;
  const qrSeen = new Promise(resolve => { resolveQRSeen = resolve; });
  const qrComplete = new Promise(resolve => { resolveQRComplete = resolve; });
  let qrCalls = 0;

  await page.route(/\/api\/detect-qr(?:\?|$)/, async route => {
    qrCalls++;
    resolveQRSeen();
    if (qrCalls === 1) {
      await new Promise(resolve => { releaseQR = resolve; });
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ qrCodes: [] }),
    });
    if (qrCalls === 1) resolveQRComplete();
  });

  try {
    await page.goto(baseURL);
    await page.locator('input[type=file]').setInputFiles(artwork);
    await page.getByRole('button', { name: 'Increase Quality', exact: true }).waitFor();
    await openSpotColors(page);
    const card = await selectWhiteAndGloss(page);

    // The server response is deliberately still pending while the user
    // scrolls and resizes. No QR scanner request reaches the real server.
    await waitForPromise(qrSeen, 'held /api/detect-qr request');
    await scrollWheelResize(page, card);
    assert.equal(qrCalls, 1, 'QR route should be hit once for this artwork');
    releaseQR();
    await waitForPromise(qrComplete, 'empty QR response');
    await page.waitForTimeout(500);
    await assertSelected(card, 'after delayed empty QR metadata');
    console.log('delayed QR response: selections survived scroll, wheel, resize, and empty metadata');
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function runDelayedRegionScenario() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let releaseRegion;
  let resolveRegionSeen;
  let resolveRegionContinued;
  const regionSeen = new Promise(resolve => { resolveRegionSeen = resolve; });
  const regionContinued = new Promise(resolve => { resolveRegionContinued = resolve; });
  let regionRequests = 0;

  await page.route(/region-worker\.ts(?:\?|$)/, async route => {
    regionRequests++;
    resolveRegionSeen();
    // Keep the module request pending only until the palette is editable.
    // This is well below the application's eight-second worker timeout.
    await new Promise(resolve => { releaseRegion = resolve; });
    await route.continue();
    resolveRegionContinued();
  });

  // Avoid the expensive server-side QR detector in this scenario as well.
  await page.route(/\/api\/detect-qr(?:\?|$)/, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ qrCodes: [] }),
    });
  });

  try {
    await page.goto(baseURL);
    await page.locator('input[type=file]').setInputFiles(artwork);
    await page.getByRole('button', { name: 'Increase Quality', exact: true }).waitFor();
    await openSpotColors(page);
    const card = await selectWhiteAndGloss(page);

    // Palette extraction is delivered before region enrichment. Thus this is
    // the exact late-worker window that used to overwrite spot assignments.
    await waitForPromise(regionSeen, 'held region-worker.ts resource');
    await assertSelected(card, 'before delayed region delivery');
    await scrollWheelResize(page, card);
    assert.ok(regionRequests >= 1, 'region-worker.ts should be requested');

    releaseRegion();
    await waitForPromise(regionContinued, 'region-worker.ts continuation');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-color-index]')]
      .some(element => /\(\d+ shapes\)/.test(element.textContent || '')), null, { timeout: 30000 });
    await page.waitForTimeout(500);
    await assertSelected(card, 'after delayed region delivery');

    // Expand the selected palette colour when region enrichment exposes it.
    const shapeToggle = card.locator('button[title$="shapes"]').first();
    if (await shapeToggle.count()) {
      await shapeToggle.click();
      assert.ok(
        await card.locator('button[title="Remove White"]').count() >= 2,
        'White should remain selected on each detected region',
      );
      assert.ok(
        await card.locator('button[title="Remove Gloss"]').count() >= 2,
        'Gloss should remain selected on each detected region',
      );
    }

    await page.screenshot({ path: '/tmp/spot-selection-after.png', fullPage: true });
    console.log('delayed region delivery: palette and per-region White/Gloss selections survived');

    // A genuinely new image must start with clean spot selections, rather than
    // inheriting flags from the prior image's editable palette.
    await page.locator('input[type=file]').setInputFiles(freshArtwork);
    await page.getByText('Detecting colors…', { exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
    await page.locator('[data-color-index]').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
    assert.equal(
      await page.locator('button[title="Remove White from all shapes"]').count(),
      0,
      'fresh artwork must not inherit White assignment',
    );
    assert.equal(
      await page.locator('button[title="Remove Gloss from all shapes"]').count(),
      0,
      'fresh artwork must not inherit Gloss assignment',
    );
    assert.ok(
      await page.locator('button[title^="Apply White to all shapes"]').count() > 0,
      'fresh artwork should expose an unassigned White control',
    );
    assert.ok(
      await page.locator('button[title^="Apply Gloss to all shapes"]').count() > 0,
      'fresh artwork should expose an unassigned Gloss control',
    );
    console.log('fresh artwork: prior White/Gloss flags reset');
  } catch (error) {
    await page.close();
    throw error;
  } finally {
    await page.close();
  }
}

try {
  const qrPage = await runDelayedQrScenario();
  await qrPage.screenshot({ path: '/tmp/spot-selection-after.png', fullPage: true });
  await qrPage.close();
  await runDelayedRegionScenario();
  console.log('spot-selection-browser: PASS');
} catch (error) {
  console.error('spot-selection-browser: FAIL');
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}