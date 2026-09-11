// Run against a running dev server:
// PLAYWRIGHT_MODULE=<playwright/index.mjs> CHROMIUM_EXECUTABLE=<chromium> \
//   node tests/quality-preview-browser.mjs
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
  args: ['--no-sandbox'],
});
const baseURL = process.env.TEST_BASE_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`;
const artwork = createCanvas(700, 500);
const context = artwork.getContext('2d');
context.fillStyle = '#0099bb';
context.beginPath();
for (const [x, y] of [[350, 30], [650, 220], [500, 250], [660, 440], [40, 440], [200, 230]]) {
  context.lineTo(x, y);
}
context.closePath();
context.fill();
const file = { name: 'quality-regression.png', mimeType: 'image/png', buffer: artwork.toBuffer('image/png') };

try {
  for (const [name, viewport, contour] of [
    ['desktop', { width: 1280, height: 900 }, false],
    ['mobile', { width: 390, height: 844 }, false],
    ['desktop-contour', { width: 1280, height: 900 }, true],
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL);
    await page.locator('input[type=file]').setInputFiles(file);
    await page.getByRole('button', { name: 'Increase Quality', exact: true }).waitFor();
    if (contour) {
      await page.getByRole('button', { name: 'Contour', exact: true }).click();
      await page.waitForTimeout(1000);
      await page.getByText(/Processing\.\.\./).waitFor({ state: 'hidden', timeout: 90000 });
    }
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: 'Increase Quality', exact: true }).click();
    await page.getByText('Quality increased', { exact: true }).first().waitFor({ timeout: 30000 });
    await page.getByText(/Processing\.\.\./).waitFor({ state: 'hidden', timeout: 90000 });
    await page.waitForTimeout(2000);
    const samples = await page.evaluate(async () => {
      const canvas = [...document.querySelectorAll('canvas')].find(element => element.offsetWidth > 0);
      if (!canvas) throw new Error('Visible preview canvas not found');
      const result = [];
      for (let i = 0; i < 40; i++) {
        const rect = canvas.getBoundingClientRect();
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let hash = 0;
        for (let j = 0; j < pixels.length; j += 397) hash = (hash * 31 + pixels[j]) | 0;
        result.push({
          width: canvas.width, height: canvas.height,
          cssWidth: Math.round(rect.width), cssHeight: Math.round(rect.height),
          hash, processing: /Processing\.\.\./.test(document.body.innerText),
        });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return result;
    });
    assert.equal(new Set(samples.map(sample => JSON.stringify(sample))).size, 1,
      `${name}: preview keeps changing after upscale: ${JSON.stringify(samples)}`);
    assert.ok(samples[0].width > 200 && samples[0].cssHeight > 100, `${name}: collapsed preview`);
    assert.equal(samples[0].processing, false, `${name}: contour never settled`);
    assert.deepEqual(errors, [], `${name}: browser errors`);
    console.log(`${name}: Increase Quality succeeded; preview stable for 40 samples`, samples[0]);
    await page.close();
  }
} finally {
  await browser.close();
}