// Run against a running dev server:
// PLAYWRIGHT_MODULE=/mnt/pid2/node_modules/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium \
//   node tests/qr-repair-studio-browser.mjs
//
// This is intentionally an end-to-end browser test. The normal scenario does
// not stub /api/detect-qr: QR detection is expected to stay local in the new
// worker. A separate, small status scenario supplies a synthetic worker only
// to exercise cancellation and a deadline error without waiting 20 seconds.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { PDFDocument } from "pdf-lib";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "/mnt/pid2/node_modules/playwright/index.mjs"
);
const executablePath = process.env.CHROMIUM_EXECUTABLE ||
  "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";
const baseURL = process.env.TEST_BASE_URL ||
  `https://${process.env.REPLIT_DEV_DOMAIN}`;

assert.ok(
  process.env.REPLIT_DEV_DOMAIN || process.env.TEST_BASE_URL,
  "Set REPLIT_DEV_DOMAIN or TEST_BASE_URL before running this browser test",
);

const PAYLOAD = "https://example.com/qr-repair-test?id=navy-cream";
const ART_WIDTH = 1200;
const ART_HEIGHT = 900;
const DARK = "#111827";
const LIGHT = "#fff7ed";

function makeFixture() {
  const artwork = createCanvas(ART_WIDTH, ART_HEIGHT);
  const context = artwork.getContext("2d");
  context.fillStyle = LIGHT;
  context.fillRect(0, 0, ART_WIDTH, ART_HEIGHT);

  // A little non-QR art makes the pixel-preservation assertion meaningful.
  context.fillStyle = "#d6c7b8";
  context.fillRect(0, 0, 64, ART_HEIGHT);
  context.fillRect(ART_WIDTH - 64, 0, 64, ART_HEIGHT);
  context.fillStyle = "#e8d8c8";
  context.fillRect(70, 70, 80, 80);
  context.fillRect(ART_WIDTH - 150, ART_HEIGHT - 150, 80, 80);

  const matrix = QRCode.create(PAYLOAD, { errorCorrectionLevel: "H" }).modules;
  const moduleSize = 8;
  const quietZone = 4;
  const qrSize = matrix.size * moduleSize;
  const totalSize = (matrix.size + quietZone * 2) * moduleSize;
  const regions = [
    { x: 100, y: 250 },
    { x: 740, y: 250 },
  ].map(({ x, y }) => ({
    x: x + quietZone * moduleSize,
    y: y + quietZone * moduleSize,
    width: qrSize,
    height: qrSize,
  }));

  for (const { x, y } of [{ x: 100, y: 250 }, { x: 740, y: 250 }]) {
    context.fillStyle = LIGHT;
    context.fillRect(x, y, totalSize, totalSize);
    context.fillStyle = DARK;
    for (let row = 0; row < matrix.size; row += 1) {
      for (let column = 0; column < matrix.size; column += 1) {
        if (matrix.get(column, row)) {
          context.fillRect(
            x + (column + quietZone) * moduleSize,
            y + (row + quietZone) * moduleSize,
            moduleSize,
            moduleSize,
          );
        }
      }
    }
  }

  return {
    name: "qr-repair-studio-navy-cream.png",
    mimeType: "image/png",
    buffer: artwork.toBuffer("image/png"),
    regions,
  };
}

const fixture = makeFixture();

function makeManualFixture() {
  const artwork = createCanvas(ART_WIDTH, ART_HEIGHT);
  const context = artwork.getContext("2d");
  context.fillStyle = LIGHT;
  context.fillRect(0, 0, ART_WIDTH, ART_HEIGHT);
  context.fillStyle = "#d6c7b8";
  context.fillRect(0, 0, 64, ART_HEIGHT);
  context.fillRect(ART_WIDTH - 64, 0, 64, ART_HEIGHT);
  // This is deliberately a solid, non-QR region. Manual recovery must create
  // a QR from user content instead of relying on detector metadata.
  context.fillStyle = DARK;
  context.fillRect(360, 240, 240, 480);
  context.fillStyle = LIGHT;
  context.fillRect(600, 240, 240, 480);
  context.fillStyle = "#e8d8c8";
  context.fillRect(80, 80, 90, 90);
  context.fillRect(ART_WIDTH - 170, ART_HEIGHT - 170, 90, 90);
  return {
    name: "qr-repair-studio-manual-blank.png",
    mimeType: "image/png",
    buffer: artwork.toBuffer("image/png"),
    region: { x: 360, y: 240, width: 480, height: 480 },
  };
}

const manualFixture = makeManualFixture();

function imageDataForCanvas(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return { data: new Uint8ClampedArray(image.data), width: canvas.width, height: canvas.height };
}

function pdfDictionaryNumber(dictionary, key) {
  const match = dictionary.match(new RegExp(`/${key}\\s+(\\d+)`));
  return match ? Number(match[1]) : undefined;
}

function pdfDictionaryReference(dictionary, key) {
  const match = dictionary.match(new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`));
  return match ? Number(match[1]) : undefined;
}

function unfilterPdfImage(raw, dictionary) {
  const filter = dictionary.match(/\/Filter\s+\/([A-Za-z0-9]+)/)?.[1];
  if (!filter) return Buffer.from(raw);
  if (filter === "FlateDecode") return Buffer.from(inflateSync(raw));
  if (filter === "ASCII85Decode") {
    throw new Error("ASCII85 PDF image streams are not supported by this focused test");
  }
  throw new Error(`Unsupported embedded PDF image filter: ${filter}`);
}

function unfilterPdfPredictor(raw, dictionary, width, channels) {
  const predictor = pdfDictionaryNumber(dictionary, "Predictor");
  const columns = pdfDictionaryNumber(dictionary, "Columns") || width;
  if (!predictor || predictor < 10) return raw;
  const rowBytes = columns * channels;
  const stride = rowBytes + 1;
  if (raw.length < stride || raw.length % stride !== 0) {
    throw new Error(`Invalid PNG-predictor image stream (${raw.length} bytes, ${stride} stride)`);
  }
  const result = Buffer.alloc((raw.length / stride) * rowBytes);
  let sourceOffset = 0;
  let targetOffset = 0;
  let previous = Buffer.alloc(rowBytes);
  for (; sourceOffset < raw.length; sourceOffset += stride, targetOffset += rowBytes) {
    const predictorType = raw[sourceOffset];
    const row = Buffer.from(raw.subarray(sourceOffset + 1, sourceOffset + stride));
    for (let index = 0; index < row.length; index += 1) {
      const left = index >= channels ? row[index - channels] : 0;
      const up = previous[index] || 0;
      const upperLeft = index >= channels ? previous[index - channels] || 0 : 0;
      if (predictorType === 1) row[index] = (row[index] + left) & 0xff;
      else if (predictorType === 2) row[index] = (row[index] + up) & 0xff;
      else if (predictorType === 3) row[index] = (row[index] + Math.floor((left + up) / 2)) & 0xff;
      else if (predictorType === 4) {
        const estimate = left + up - upperLeft;
        const pa = Math.abs(estimate - left);
        const pb = Math.abs(estimate - up);
        const pc = Math.abs(estimate - upperLeft);
        row[index] = (row[index] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft)) & 0xff;
      } else if (predictorType !== 0) {
        throw new Error(`Unsupported PNG predictor row ${predictorType}`);
      }
    }
    row.copy(result, targetOffset);
    previous = row;
  }
  return result;
}

function embeddedPdfImages(pdfBytes) {
  const bytes = Buffer.from(pdfBytes);
  const latin = bytes.toString("latin1");
  const objects = new Map();
  const objectPattern = /(\d+)\s+0\s+obj\b/g;
  let match;
  while ((match = objectPattern.exec(latin))) {
    const id = Number(match[1]);
    const dictionaryStart = latin.indexOf("<<", match.index);
    const dictionaryEnd = latin.indexOf(">>", dictionaryStart + 2);
    const streamStartToken = latin.indexOf("stream", dictionaryEnd + 2);
    const objectEnd = latin.indexOf("endobj", dictionaryEnd + 2);
    if (dictionaryStart < 0 || dictionaryEnd < 0 || objectEnd < 0) continue;
    const dictionary = latin.slice(dictionaryStart, dictionaryEnd + 2);
    if (!/\/Subtype\s*\/Image\b/.test(dictionary) || streamStartToken < 0 || streamStartToken > objectEnd) {
      continue;
    }
    let dataStart = streamStartToken + "stream".length;
    if (bytes[dataStart] === 0x0d) dataStart += bytes[dataStart + 1] === 0x0a ? 2 : 1;
    else if (bytes[dataStart] === 0x0a) dataStart += 1;
    const dataEnd = bytes.indexOf(Buffer.from("\nendstream"), dataStart);
    if (dataEnd < 0) continue;
    const length = pdfDictionaryNumber(dictionary, "Length");
    const raw = length && dataStart + length <= dataEnd
      ? bytes.subarray(dataStart, dataStart + length)
      : bytes.subarray(dataStart, dataEnd);
    objects.set(id, { id, dictionary, raw });
  }

  const decoded = [];
  for (const image of objects.values()) {
    const width = pdfDictionaryNumber(image.dictionary, "Width");
    const height = pdfDictionaryNumber(image.dictionary, "Height");
    const bits = pdfDictionaryNumber(image.dictionary, "BitsPerComponent") || 8;
    const colorSpace = image.dictionary.match(/\/ColorSpace\s+\/([A-Za-z0-9]+)/)?.[1];
    if (!width || !height || bits !== 8 || !colorSpace) continue;
    const channels = colorSpace === "DeviceRGB" ? 3 : colorSpace === "DeviceGray" ? 1 : 0;
    if (!channels) continue;
    const filtered = unfilterPdfImage(image.raw, image.dictionary);
    const raster = unfilterPdfPredictor(filtered, image.dictionary, width, channels);
    if (raster.length < width * height * channels) continue;
    const maskId = pdfDictionaryReference(image.dictionary, "SMask");
    const mask = maskId === undefined ? undefined : objects.get(maskId);
    let alpha;
    if (mask) {
      const maskFiltered = unfilterPdfImage(mask.raw, mask.dictionary);
      alpha = unfilterPdfPredictor(maskFiltered, mask.dictionary, width, 1);
    }
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      const source = index * channels;
      const target = index * 4;
      const gray = raster[source];
      rgba[target] = channels === 1 ? gray : raster[source];
      rgba[target + 1] = channels === 1 ? gray : raster[source + 1];
      rgba[target + 2] = channels === 1 ? gray : raster[source + 2];
      rgba[target + 3] = alpha ? alpha[index] : 255;
    }
    decoded.push({ width, height, data: rgba, objectId: image.id, maskId });
  }
  return decoded;
}

function decodeRaster(raster) {
  const { width, height, data } = raster;
  const found = new Set();
  const whole = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
  if (whole?.data) found.add(whole.data);

  // jsQR intentionally returns one code per call. Scan overlapping windows so
  // both equal-payload codes are independently decoded from the actual PNG.
  const windowWidth = Math.min(560, width);
  const windowHeight = Math.min(560, height);
  const xPositions = [...new Set([
    0,
    Math.max(0, Math.round(width * 0.28)),
    Math.max(0, Math.round(width * 0.53)),
    Math.max(0, width - windowWidth),
  ])];
  const yPositions = [...new Set([
    0,
    Math.max(0, Math.round(height * 0.25)),
    Math.max(0, height - windowHeight),
  ])];
  for (const x of xPositions) {
    for (const y of yPositions) {
      const cropWidth = Math.min(windowWidth, width - x);
      const cropHeight = Math.min(windowHeight, height - y);
      const cropData = new Uint8ClampedArray(cropWidth * cropHeight * 4);
      for (let row = 0; row < cropHeight; row += 1) {
        cropData.set(
          data.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + cropWidth) * 4),
          row * cropWidth * 4,
        );
      }
      const result = jsQR(cropData, cropWidth, cropHeight, { inversionAttempts: "attemptBoth" });
      if (result?.data) found.add(result.data);
    }
  }
  return {
    width,
    height,
    payloads: [...found],
    hasDarkNavy: [...data].some((value, index) => index % 4 === 0 && value === 17) &&
      [...data].some((value, index) => index % 4 === 1 && value === 24) &&
      [...data].some((value, index) => index % 4 === 2 && value === 39),
    hasCream: [...data].some((value, index) => index % 4 === 0 && value === 255) &&
      [...data].some((value, index) => index % 4 === 1 && value === 247) &&
      [...data].some((value, index) => index % 4 === 2 && value === 237),
    hasPureBlackOrWhite: data.some((value, index) => {
      if (index % 4 !== 0) return false;
      const green = data[index + 1];
      const blue = data[index + 2];
      return (value === 0 && green === 0 && blue === 0) ||
        (value === 255 && green === 255 && blue === 255);
    }),
  };
}

function rasterFingerprint(rasters) {
  const perRaster = rasters.map((raster) => {
    let hash = 2166136261;
    hash ^= raster.width;
    hash = Math.imul(hash, 16777619);
    hash ^= raster.height;
    hash = Math.imul(hash, 16777619);
    for (let index = 0; index < raster.data.length; index += 397) {
      hash ^= raster.data[index];
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }).sort((left, right) => left - right);
  let hash = 2166136261;
  for (const rasterHash of perRaster) {
    hash ^= rasterHash;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function decodeDownloadedPdf(buffer, label) {
  assert.equal(Buffer.from(buffer).subarray(0, 4).toString("ascii"), "%PDF", `${label}: export is not a PDF`);
  const pdf = await PDFDocument.load(buffer);
  assert.ok(pdf.getPages().length > 0, `${label}: PDF has no pages`);
  const images = embeddedPdfImages(buffer);
  assert.ok(images.length > 0, `${label}: PDF contains no RGB/Gray image streams`);
  const decoded = images.map(decodeRaster);
  const payloads = new Set(decoded.flatMap((result) => result.payloads));
  return {
    images,
    payloads: [...payloads],
    hasDarkNavy: decoded.some((result) => result.hasDarkNavy),
    hasCream: decoded.some((result) => result.hasCream),
    hasPureBlackOrWhite: decoded.some((result) => result.hasPureBlackOrWhite),
    pixelFingerprint: rasterFingerprint(images),
  };
}

async function downloadPrintPdf(page, label) {
  const pdfButton = page.getByRole("button", { name: "Download PDF", exact: true }).first();
  assert.equal(
    await pdfButton.count(),
    1,
    `${label}: the editor must expose its Download PDF action`,
  );
  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await pdfButton.click();
  // Implementations that reuse the no-cutline confirmation may defer the
  // actual download until this confirmation is accepted.
  const yes = page.getByRole("button", { name: "Yes", exact: true });
  if (await yes.count() && await yes.isVisible().catch(() => false)) {
    await yes.click();
  }
  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path, `${label}: Playwright did not expose a downloaded PDF path`);
  const bytes = await fs.readFile(path);
  return bytes;
}

async function waitForStableScan(page) {
  await page.getByRole("button", { name: /QR Repair Studio/ }).click();
  await page.waitForFunction(
    () => document.body.textContent.includes("Scan complete") ||
      document.body.textContent.includes("Scan error"),
    undefined,
    { timeout: 30_000 },
  );
  // Scan controls are intentionally behind the optional More tools disclosure
  // once scanning has settled. Open it only long enough to inspect the real
  // worker status, then return the modal to its simple default state.
  await setDisclosure(page, "More tools: scan again and diagnostics", true);
  if (await page.getByText(/Scan error/, { exact: false }).count()) {
    throw new Error(`QR scan failed: ${await page.locator('[aria-live="polite"]').last().innerText()}`);
  }
  const scanSummary = await page.getByText(/Found \d+ QR region/, { exact: false }).first().innerText();
  assert.match(scanSummary, /Found 2 QR regions\. Review before repairing\./,
    `detector returned an unexpected QR count: ${scanSummary}`);
  await setDisclosure(page, "More tools: scan again and diagnostics", false);
  await page.getByRole("heading", { name: "Choose a code", exact: true }).waitFor();
}

async function setDisclosure(page, summaryText, open) {
  const summary = page.locator("summary").filter({ hasText: summaryText }).first();
  assert.equal(await summary.count(), 1, `missing disclosure: ${summaryText}`);
  const details = summary.locator("xpath=..");
  const currentOpen = await details.evaluate((element) => element.open);
  if (currentOpen !== open) await summary.click();
  assert.equal(
    await details.evaluate((element) => element.open),
    open,
    `${summaryText} disclosure did not become ${open ? "open" : "closed"}`,
  );
  return details;
}

async function assertSimpleModal(page, viewportLabel) {
  const advanced = page.locator("summary").filter({
    hasText: "Advanced options: colors, logo and scan settings",
  }).first().locator("xpath=..");
  assert.equal(await advanced.count(), 1, `${viewportLabel}: Advanced disclosure is missing`);
  assert.equal(
    await advanced.evaluate((element) => element.open),
    false,
    `${viewportLabel}: Advanced options must be collapsed by default`,
  );

  const hiddenTechnicalControls = [
    page.getByLabel("Detected QR payload read-only"),
    page.getByLabel("Foreground color value"),
    page.getByLabel("Background color value"),
    page.getByRole("combobox", { name: "Error correction level" }),
    page.getByLabel("Quiet zone modules, from 4 to 8"),
    page.getByLabel("Manual region x in source pixels"),
    page.getByLabel("Manual region y in source pixels"),
    page.getByLabel("Manual region width in source pixels"),
    page.getByLabel("Manual region height in source pixels"),
  ];
  for (const control of hiddenTechnicalControls) {
    if (await control.count()) {
      assert.equal(
        await control.first().isVisible(),
        false,
        `${viewportLabel}: technical control unexpectedly visible before disclosure`,
      );
    }
  }

  // These assertions deliberately do not scroll any locator into view. The
  // compact flow must expose its before/after preview and primary actions in
  // both responsive layouts without requiring a technical-controls detour.
  for (const [name, control] of [
    ["Choose a code", page.getByRole("heading", { name: "Choose a code", exact: true })],
    ["Before & after", page.getByRole("heading", { name: "Before & after", exact: true })],
    ["Preview fix", page.getByRole("button", { name: "Preview fix and verify QR repair", exact: true })],
    ["Apply fix", page.getByRole("button", { name: "Apply verified QR repairs", exact: true })],
    ["Close", page.getByRole("button", { name: "Cancel QR repair studio", exact: true })],
  ]) {
    assert.equal(await control.count(), 1, `${viewportLabel}: missing ${name} control`);
    assert.equal(await control.isVisible(), true, `${viewportLabel}: ${name} is not visible without scrolling`);
  }
  assert.match(
    await page.getByRole("button", { name: "Preview fix and verify QR repair", exact: true }).innerText(),
    /Preview fix/,
    `${viewportLabel}: Preview fix visible label changed unexpectedly`,
  );
  assert.match(
    await page.getByRole("button", { name: "Apply verified QR repairs", exact: true }).innerText(),
    /Apply fix/,
    `${viewportLabel}: Apply fix visible label changed unexpectedly`,
  );
  assert.match(
    await page.getByRole("button", { name: "Cancel QR repair studio", exact: true }).innerText(),
    /Close/,
    `${viewportLabel}: Close visible label changed unexpectedly`,
  );
}

async function assertPayloadReadOnly(page, expected = PAYLOAD) {
  const payload = page.getByLabel("Detected QR payload read-only");
  assert.equal(await payload.count(), 1, "selected detected QR must expose one exact payload field");
  assert.equal(await payload.inputValue(), expected, "detected payload changed unexpectedly");
  assert.equal(await payload.isEditable(), false, "detected payload must be read-only");
}

async function verifySelected(page) {
  const verify = page.getByRole("button", { name: "Preview fix and verify QR repair", exact: true });
  await verify.click();
  await page.getByText(/^(Payload matches exactly|Matches the original exactly)$/, { exact: true })
    .waitFor({ timeout: 30_000 });
  await page.getByText(/^(Passes the final output scale check\.|Passed at the final print size\.)$/, { exact: true })
    .waitFor({ timeout: 30_000 });
}

async function runRepairScenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const serverQRRequests = [];
  page.on("request", (request) => {
    if (/\/api\/detect-qr(?:\?|$)/.test(request.url())) serverQRRequests.push(request.url());
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await page.goto(baseURL);
    await page.locator("input[type=file]").setInputFiles(fixture);
    await page.getByRole("button", { name: /QR Repair Studio/ }).waitFor({ timeout: 30_000 });
    await waitForStableScan(page);

    assert.deepEqual(serverQRRequests, [], "normal QR detection must remain local; no server scan request is allowed");
    assert.equal(await page.getByText("QR code 1", { exact: true }).count(), 1);
    assert.equal(await page.getByText("QR code 2", { exact: true }).count(), 1);
    await assertSimpleModal(page, "desktop");

    // Capture the real modal before any edit and verify the compact flow on
    // both viewport sizes without scrolling into the technical controls.
    await page.screenshot({ path: "/tmp/simple-qr-before.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await assertSimpleModal(page, "mobile");
    await page.screenshot({ path: "/tmp/simple-qr-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Cancel QR repair studio", exact: true }).click();

    const originalDownload = await downloadPrintPdf(page, "before repair");
    const originalDecoded = await decodeDownloadedPdf(originalDownload, "before repair");
    assert.ok(originalDecoded.payloads.includes(PAYLOAD), "original PNG did not decode the QR payload");
    assert.ok(originalDecoded.hasDarkNavy && originalDecoded.hasCream, "original PNG lost the fixture's colored QR pixels");
    await waitForStableScan(page);

    // The ordinary three-step path is usable with Advanced still collapsed:
    // choose the first code, preview the fix, then inspect its safety status.
    await verifySelected(page);

    // Color, ECC, and quiet-zone behavior remain covered, but are deliberately
    // exercised only after opening the technical options disclosure.
    await setDisclosure(page, "Advanced options: colors, logo and scan settings", true);
    await assertPayloadReadOnly(page);

    // Color edits need a fresh scan, not a false failure from a contrast rule.
    await page.getByLabel("Foreground color value").fill("#777777");
    await page.getByLabel("Background color value").fill("#ffffff");
    assert.equal(
      await page.getByRole("button", { name: "Apply verified QR repairs", exact: true }).isDisabled(),
      true,
      "edited colors must invalidate the old scan",
    );
    await verifySelected(page);
    await page.getByText("Low contrast — a print warning, not a failed scan.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Apply verified QR repairs", exact: true }).isDisabled(), false,
      "an exact, print-size readable code must not fail solely for contrast below 4.5");
    assert.equal(await page.getByLabel("Foreground color value").inputValue(), "#777777",
      "verification must never substitute the chosen color");

    // Exercise the safe suggestion, then intentionally match the sampled
    // source colors for the final repair.
    await page.getByRole("button", { name: "Suggest safe similar QR colors", exact: true }).click();
    const suggestedDark = await page.getByLabel("Foreground color value").inputValue();
    const suggestedLight = await page.getByLabel("Background color value").inputValue();
    assert.notEqual(suggestedDark.toLowerCase(), "#777777");
    assert.notEqual(suggestedLight.toLowerCase(), "#999999");
    await page.getByRole("button", { name: "Match original QR colors", exact: true }).click();
    assert.equal((await page.getByLabel("Foreground color value").inputValue()).toLowerCase(), DARK);
    assert.equal((await page.getByLabel("Background color value").inputValue()).toLowerCase(), LIGHT);

    // ECC and quiet zone are real controls, not decorative fields.
    await page.getByRole("combobox", { name: "Error correction level" }).click();
    await page.getByRole("option", { name: /H — 30% recovery/ }).click();
    await page.getByLabel("Quiet zone modules, from 4 to 8").fill("6");
    await verifySelected(page);

    // Queue the second code, keep equal payloads as two distinct repair
    // candidates, and verify it independently.
    const secondQueue = page.getByRole("checkbox", { name: /QR code 2/i });
    assert.equal(await secondQueue.count(), 1, "second QR code queue checkbox is missing");
    await secondQueue.check();
    await page.getByRole("button", { name: "Edit detected QR code 2", exact: true }).click();
    await assertPayloadReadOnly(page);
    await verifySelected(page);
    assert.equal(
      await page.getByRole("button", { name: "Apply verified QR repairs", exact: true }).isDisabled(),
      false,
      "two independently verified codes should enable multi-code Apply",
    );

    await page.screenshot({ path: "/tmp/simple-qr-before-apply.png", fullPage: true });
    await page.getByRole("button", { name: "Apply verified QR repairs", exact: true }).click();
    await page.getByText("QR repairs applied", { exact: true }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /QR Repair Studio/ }).waitFor();

    const repairedDownload = await downloadPrintPdf(page, "after repair");
    const repairedDecoded = await decodeDownloadedPdf(repairedDownload, "after repair");
    assert.ok(repairedDecoded.payloads.includes(PAYLOAD), "repaired print PNG did not exactly decode the QR payload");
    assert.ok(repairedDecoded.hasDarkNavy && repairedDecoded.hasCream,
      "repaired print PNG lost colored foreground/background");
    assert.notEqual(repairedDecoded.pixelFingerprint, originalDecoded.pixelFingerprint,
      "Apply did not change editor pixels");

    // A repaired image must not route through the former black/white overlay
    // path. The local detector may legitimately repopulate QR metadata after
    // the real pixel edit, so assert against the actual embedded print raster
    // rather than treating a toolbar count as overlay state.
    assert.equal(
      repairedDecoded.hasPureBlackOrWhite,
      false,
      "old black/white QR overlay pixels survived Apply",
    );

    // The modal can be reopened against the repaired image and is still a
    // real QR Repair Studio rather than an unmounted/blank overlay.
    await page.getByRole("button", { name: /QR Repair Studio/ }).click();
    await page.getByRole("heading", { name: "Fix QR code", exact: true }).waitFor();
    await page.screenshot({ path: "/tmp/simple-qr-after.png", fullPage: true });
    await page.getByRole("button", { name: "Cancel QR repair studio", exact: true }).click();

    // Undo must restore the original pixels and Redo must restore the repair.
    await page.getByTitle("Undo").click();
    await page.waitForTimeout(1_000);
    const undoneDownload = await downloadPrintPdf(page, "after Undo");
    const undoneDecoded = await decodeDownloadedPdf(undoneDownload, "after Undo");
    assert.equal(
      undoneDecoded.pixelFingerprint,
      originalDecoded.pixelFingerprint,
      "Undo did not restore the original embedded print pixels",
    );
    await page.getByTitle("Redo").click();
    await page.waitForTimeout(1_000);
    const redoneDownload = await downloadPrintPdf(page, "after Redo");
    const redoneDecoded = await decodeDownloadedPdf(redoneDownload, "after Redo");
    assert.equal(
      redoneDecoded.pixelFingerprint,
      repairedDecoded.pixelFingerprint,
      "Redo did not restore the repaired embedded print pixels",
    );

    assert.deepEqual(errors, [], "browser page errors during QR repair scenario");
    console.log("repair scenario: local two-code repair, real PNG decode, mobile modal, Undo/Redo passed");
  } finally {
    await page.close();
  }
}

async function runManualRecoveryScenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const serverQRRequests = [];
  page.on("request", (request) => {
    if (/\/api\/detect-qr(?:\?|$)/.test(request.url())) serverQRRequests.push(request.url());
  });
  try {
    await page.goto(baseURL);
    await page.locator("input[type=file]").setInputFiles(manualFixture);
    await page.getByRole("button", { name: /QR Repair Studio/ }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /QR Repair Studio/ }).click();
    await page.waitForFunction(() => document.body.textContent.includes("Scan complete"), undefined, { timeout: 30_000 });
    await setDisclosure(page, "More tools: scan again and diagnostics", true);
    await page.getByText(/No readable QR found/, { exact: false }).waitFor({ timeout: 30_000 });
    assert.equal(await page.getByText("QR code 1", { exact: true }).count(), 0,
      "manual blank fixture unexpectedly produced a detected QR");
    assert.deepEqual(serverQRRequests, [], "manual recovery must also use local QR detection");
    await setDisclosure(page, "More tools: scan again and diagnostics", false);

    const art = page.getByRole("application", { name: /Artwork region selector/ });
    const box = await art.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, "manual artwork selector is not visible");
    const start = {
      x: box.x + box.width * manualFixture.region.x / ART_WIDTH,
      y: box.y + box.height * manualFixture.region.y / ART_HEIGHT,
    };
    const end = {
      x: box.x + box.width * (manualFixture.region.x + manualFixture.region.width) / ART_WIDTH,
      y: box.y + box.height * (manualFixture.region.y + manualFixture.region.height) / ART_HEIGHT,
    };
    // First use the visible drag affordance, then commit the exact source
    // pixels through the numeric fields exposed for keyboard/pointer users.
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 4 });
    await page.mouse.up();
    await setDisclosure(page, "Select a QR manually", true);
    await setDisclosure(page, "Enter box coordinates instead", true);
    for (const field of ["x", "y", "width", "height"]) {
      await page.getByLabel(`Manual region ${field} in source pixels`).fill(
        String(manualFixture.region[field]),
      );
    }
    assert.equal(await page.getByLabel("Manual region width in source pixels").inputValue(), "480");
    assert.equal(await page.getByLabel("Manual region height in source pixels").inputValue(), "480");

    await page.getByLabel("Manual recovery exact payload").fill(PAYLOAD);
    await page.getByRole("button", { name: "Add manual QR recovery candidate to repair queue", exact: true }).click();
    await page.getByRole("button", { name: "Edit manual recovery", exact: true }).waitFor();
    const manualPayload = page.getByLabel("Manual QR payload");
    assert.equal(await manualPayload.inputValue(), PAYLOAD);
    assert.equal(await manualPayload.isEditable(), true, "manual payload must remain user-editable");

    await verifySelected(page);
    assert.equal(
      await page.getByRole("button", { name: "Apply verified QR repairs", exact: true }).isDisabled(),
      false,
      "verified manual recovery candidate should enable Apply",
    );
    await page.getByRole("button", { name: "Apply verified QR repairs", exact: true }).click();
    await page.getByText("QR repairs applied", { exact: true }).waitFor({ timeout: 30_000 });
    const repairedDownload = await downloadPrintPdf(page, "manual recovery after repair");
    const repairedDecoded = await decodeDownloadedPdf(repairedDownload, "manual recovery after repair");
    assert.ok(
      repairedDecoded.payloads.includes(PAYLOAD),
      "manual recovery print PDF did not decode the exact user-provided payload",
    );
    assert.ok(
      repairedDecoded.hasDarkNavy && repairedDecoded.hasCream,
      "manual recovery print PDF lost colored QR artwork",
    );
    console.log("manual recovery scenario: zero-code blank fixture, drag/numeric region, exact payload, and PDF decode passed");
  } finally {
    await page.close();
  }
}

async function runScanStatusScenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let workerStubRequests = 0;
  // Vite serves a small Worker constructor at ?worker and the actual worker
  // script at ?worker_file. Only replace the latter; replacing the wrapper
  // makes the application module fail before the upload control mounts.
  await page.route(/qr-detect-worker(?:\.ts|\.js)\?worker_file/, async (route) => {
    workerStubRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        self.onmessage = (event) => {
          if (event.data && event.data.deep) {
            self.postMessage({ type: "error", code: "timeout" });
          }
        };
      `,
    });
  });

  try {
    await page.goto(baseURL);
    await page.locator("input[type=file]").setInputFiles(fixture);
    await page.getByRole("button", { name: /QR Repair Studio/ }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /QR Repair Studio/ }).click();
    await page.getByRole("button", { name: "Cancel scan", exact: true }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Cancel scan", exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes("Scan cancelled"), undefined, { timeout: 30_000 });
    await setDisclosure(page, "More tools: scan again and diagnostics", true);
    await page.getByText(/Scan cancelled/, { exact: false }).waitFor();

    // Deep scan is an optional tool, so open its disclosure only for this
    // deadline-status contract.
    await page.getByRole("button", { name: "Deep scan", exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes("Scan error"), undefined, { timeout: 30_000 });
    await setDisclosure(page, "More tools: scan again and diagnostics", true);
    await page.getByText(/Scan error/, { exact: false }).waitFor({ timeout: 30_000 });
    await page.getByText(/Deep QR detection timed out after 20 seconds/, { exact: false }).waitFor({ timeout: 30_000 });
    assert.ok(workerStubRequests >= 2, "status scenario did not use the synthetic worker for normal and deep scans");
    console.log("scan status scenario: Cancel scan and Deep scan deadline status passed");
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ["--no-sandbox"],
});

const failures = [];
for (const [name, scenario] of [
  ["detected QR repair", runRepairScenario],
  ["manual recovery", runManualRecoveryScenario],
  ["scan status", runScanStatusScenario],
].filter(([name]) => !process.env.QR_STUDIO_SCENARIO || name === process.env.QR_STUDIO_SCENARIO)) {
  try {
    await scenario(browser);
  } catch (error) {
    failures.push({ name, error });
    // Keep the independent scenarios running so one functional failure does
    // not hide manual recovery or scan-status regressions.
    console.error(`qr-repair-studio-browser: ${name} FAIL`);
    console.error(error);
  }
}
await browser.close();
if (failures.length) {
  console.error(`qr-repair-studio-browser: FAIL (${failures.length} scenario${failures.length === 1 ? "" : "s"})`);
  process.exitCode = 1;
} else {
  console.log("qr-repair-studio-browser: PASS");
}