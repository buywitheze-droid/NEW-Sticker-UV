import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE, args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const errors = [], timings = [];
let preparations = 0;
page.on('pageerror', e => errors.push(e.message));
page.on('console', message => {
  if (message.text().includes('Applied alpha blur radius')) preparations++;
});
async function settled() {
  // Let React's 100ms debounce start before waiting for completion.
  await page.waitForTimeout(250);
  await page.waitForFunction(() => ![...document.querySelectorAll('p')]
    .some(p => p.textContent?.includes('Processing...')), null, { timeout: 90000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.designer-preview-frame canvas')].some(c => {
    if (!c.getClientRects().length || c.width < 100) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i] > 185 && d[i + 1] < 85 && d[i + 2] > 185 && d[i + 3] > 150) n++;
    return n > 100;
  }), null, { timeout: 90000 });
}
async function download(name) {
  const event = page.waitForEvent('download', { timeout: 90000 });
  await page.getByRole('button', { name, exact: true }).first().click();
  const file = await event;
  const pdf = await PDFDocument.load(await readFile(await file.path()));
  assert.ok(pdf.getPageCount() > 0);
  return pdf.getPage(0).getSize();
}
try {
  await page.goto(process.env.TEST_BASE_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`);
  await page.locator('input[type=file]').first().setInputFiles('attached_assets/HootzDecalFinal_1791307163714.png');
  await page.getByTestId('designer-controls').waitFor({ timeout: 30000 });
  const contour = page.getByRole('button', { name: 'Contour', exact: true });
  if (!await contour.isVisible()) await page.getByRole('button', { name: 'Outline Type', exact: true }).click();
  await contour.click();
  const margin = page.getByRole('combobox', { name: 'Contour Margin', exact: true });
  if (!await margin.isVisible()) await contour.click();
  await settled();
  const before = preparations;
  for (const label of ['Small — 0.02″', 'Medium — 0.04″', 'Large — 0.07″', 'Extra Large — 0.14″', 'Huge — 0.25″']) {
    await margin.click();
    assert.equal(await page.getByRole('option').count(), 6);
    const start = Date.now();
    await page.getByRole('option', { name: label, exact: true }).click();
    await settled();
    timings.push({ label, ms: Date.now() - start });
    assert.equal(preparations, before, `${label}: must reuse artwork preparation`);
    const standard = await download('Download PDF');
    const artboard = await download('Single Artboard Download');
    assert.ok(standard.width > 0 && artboard.width > 0);
  }
  const style = page.getByTestId('select-corner-style');
  for (const choice of ['sharp', 'rounded', 'balanced']) {
    await style.click();
    await page.getByTestId(`corner-style-${choice}`).click();
    await settled();
    assert.equal(preparations, before, 'corner edits must reuse preparation');
  }
  await page.screenshot({ path: '/tmp/prepared-contour-hootz.png' });
  await page.getByRole('button', { name: 'Add to Gang Sheet', exact: true }).click();
  await page.getByRole('button', { name: /View Gangsheet/ }).click();
  await page.getByRole('region', { name: 'Gang sheet layers' }).waitFor();
  await download('Download design 1 PDF');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ timings, preparations, downloads: 11, errors }, null, 2));
} finally { await browser.close(); }
