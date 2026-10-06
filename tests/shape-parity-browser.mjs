// Real UI -> preview canvas -> downloaded PDF. Run only against an already-running app:
// TEST_BASE_URL=http://127.0.0.1:5000 \
// PLAYWRIGHT_MODULE=/mnt/pid2/node_modules/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/path/to/chromium node tests/shape-parity-browser.mjs
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseURL = process.env.TEST_BASE_URL ||
  (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null);
assert.ok(baseURL, "Set TEST_BASE_URL or REPLIT_DEV_DOMAIN");
const artifactDir = "tests/artifacts";
await mkdir(artifactDir, { recursive: true });

// Deliberately asymmetric artwork: positioning/scale errors should be visible.
const fixtureCanvas = createCanvas(900, 600);
const ink = fixtureCanvas.getContext("2d");
ink.fillStyle = "#fff";
ink.fillRect(0, 0, 900, 600);
ink.fillStyle = "#e23735";
ink.fillRect(25, 35, 300, 175);
ink.fillStyle = "#1564cf";
ink.fillRect(575, 55, 280, 250);
ink.fillStyle = "#f2c72b";
ink.beginPath();
ink.arc(265, 448, 112, 0, Math.PI * 2);
ink.fill();
ink.fillStyle = "#222";
ink.fillRect(545, 410, 240, 145);
const fixture = {
  name: "shape-parity-asymmetric.png",
  mimeType: "image/png",
  buffer: fixtureCanvas.toBuffer("image/png"),
};

function separationNames(pdf) {
  const names = new Set();
  const visit = (value) => {
    const resources = pdf.context.lookup(value);
    if (!(resources instanceof PDFDict)) return;
    const spaces = pdf.context.lookup(resources.get(PDFName.of("ColorSpace")));
    if (spaces instanceof PDFDict) {
      for (const [, entry] of spaces.entries()) {
        const arr = pdf.context.lookup(entry);
        if (arr instanceof PDFArray &&
            pdf.context.lookup(arr.get(0))?.toString() === "/Separation") {
          names.add(pdf.context.lookup(arr.get(1)).decodeText().replace(/^\/+/, ""));
        }
      }
    }
  };
  for (const page of pdf.getPages()) visit(page.node.Resources());
  return [...names];
}

// Content streams produced by the shape exporter contain an uncompressed spot
// stroke. Sample its actual PDF m/l/c operators, not the editor's shape resolver.
function pdfCutPath(pdf, spotName) {
  const contents = pdf.getPage(0).node.Contents();
  const streams = contents instanceof PDFArray
    ? [...Array(contents.size())].map((_, i) => contents.get(i))
    : [contents];
  const marker = `/${spotName} CS 1 SCN`;
  for (const ref of streams) {
    const stream = pdf.context.lookup(ref);
    if (typeof stream?.getContents !== "function") continue;
    const text = new TextDecoder().decode(stream.getContents());
    const start = text.indexOf(marker);
    if (start < 0) continue;
    const lines = text.slice(start + marker.length).split("\n");
    const samples = [];
    let current;
    for (const line of lines) {
      const tokens = line.trim().split(/\s+/);
      const op = tokens.at(-1);
      const nums = tokens.slice(0, -1).map(Number);
      if (op === "m" && nums.length === 2) {
        current = nums;
        samples.push(current);
      } else if (op === "l" && nums.length === 2) {
        assert.ok(current, "PDF cut path has a line without a move");
        for (let i = 1; i <= 32; i++) {
          const t = i / 32;
          samples.push([current[0] * (1 - t) + nums[0] * t,
            current[1] * (1 - t) + nums[1] * t]);
        }
        current = nums;
      } else if (op === "c" && nums.length === 6) {
        assert.ok(current, "PDF cut path has a curve without a move");
        for (let i = 1; i <= 32; i++) {
          const t = i / 32, u = 1 - t;
          samples.push([0, 1].map((axis) =>
            u ** 3 * current[axis] + 3 * u ** 2 * t * nums[axis] +
            3 * u * t ** 2 * nums[axis + 2] + t ** 3 * nums[axis + 4]));
        }
        current = nums.slice(4);
      } else if (op === "S") break;
    }
    assert.ok(samples.length >= 64, `PDF spot ${spotName} has no sampled vector contour`);
    return samples;
  }
  throw new Error(`No PDF content stream strokes the ${spotName} separation`);
}

function bounds(points) {
  return {
    minX: Math.min(...points.map((p) => p[0])),
    maxX: Math.max(...points.map((p) => p[0])),
    minY: Math.min(...points.map((p) => p[1])),
    maxY: Math.max(...points.map((p) => p[1])),
  };
}

async function previewOutline(page) {
  // Only the visible preview canvas is read; no renderer or export is mocked.
  return page.locator("canvas").evaluateAll((canvases) => {
    const candidates = canvases.map((canvas) => {
      if (!canvas.getClientRects().length || getComputedStyle(canvas).visibility === "hidden") return null;
      const { width, height } = canvas;
      if (width < 100 || height < 100) return null;
      const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
      const pixels = [];
      const colors = { red: [], blue: [] };
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (data[i] > 185 && data[i + 1] < 85 && data[i + 2] > 185 && data[i + 3] > 150) {
            pixels.push([x, y]);
          }
          if (data[i + 3] > 190) {
            if (data[i] > 170 && data[i + 1] < 110 && data[i + 2] < 110) colors.red.push([x, y]);
            if (data[i + 2] > 140 && data[i] < 100 && data[i + 1] < 160) colors.blue.push([x, y]);
          }
        }
      }
      return { width, height, pixels, colors };
    }).filter(Boolean).sort((a, b) => b.pixels.length - a.pixels.length);
    return candidates[0] || null;
  });
}

function centroid(points, label) {
  assert.ok(points.length > 100, `${label}: asymmetric artwork color is absent`);
  const total = points.reduce(([sx, sy], [x, y]) => [sx + x, sy + y], [0, 0]);
  return [total[0] / points.length, total[1] / points.length];
}

function assertArtworkPosition(preview, pdf, size, label) {
  const resources = pdf.context.lookup(pdf.getPage(0).node.Resources());
  const xObjects = pdf.context.lookup(resources.get(PDFName.of("XObject")));
  assert.ok(xObjects instanceof PDFDict, `${label}: no image XObjects in PDF`);
  const expectedW = Math.round(size.width * 300), expectedH = Math.round(size.height * 300);
  const images = [...xObjects.entries()].map(([, ref]) => pdf.context.lookup(ref));
  const image = images.find((stream) =>
    stream?.dict?.get(PDFName.of("Width"))?.asNumber() === expectedW &&
    stream?.dict?.get(PDFName.of("Height"))?.asNumber() === expectedH &&
    stream?.dict?.get(PDFName.of("ColorSpace"))?.toString() === "/DeviceRGB");
  assert.ok(image, `${label}: PDF has no ${expectedW}×${expectedH} clipped artwork image`);
  const rgb = inflateSync(image.getContents());
  assert.equal(rgb.length, expectedW * expectedH * 3, `${label}: unexpected RGB raster length`);
  const maskRef = image.dict.get(PDFName.of("SMask"));
  const mask = maskRef ? inflateSync(pdf.context.lookup(maskRef).getContents()) : null;
  const pdfColors = { red: [], blue: [] };
  // Sparse scan keeps this affordable even for multi-megapixel print images.
  for (let y = 0; y < expectedH; y += 3) {
    for (let x = 0; x < expectedW; x += 3) {
      const pixel = y * expectedW + x, i = pixel * 3;
      if (mask && mask[pixel] <= 190) continue;
      if (rgb[i] > 170 && rgb[i + 1] < 110 && rgb[i + 2] < 110) pdfColors.red.push([x, y]);
      if (rgb[i + 2] > 140 && rgb[i] < 100 && rgb[i + 1] < 160) pdfColors.blue.push([x, y]);
    }
  }
  const outline = bounds(preview.pixels);
  for (const color of ["red", "blue"]) {
    const [vx, vy] = centroid(preview.colors[color], `${label} preview ${color}`);
    const [px, py] = centroid(pdfColors[color], `${label} PDF ${color}`);
    const dx = Math.abs((vx - outline.minX) / (outline.maxX - outline.minX) - px / expectedW);
    const dy = Math.abs((vy - outline.minY) / (outline.maxY - outline.minY) - py / expectedH);
    assert.ok(dx < 0.045 && dy < 0.045,
      `${label}: ${color} artwork placement differs preview/PDF (dx=${dx.toFixed(3)}, dy=${dy.toFixed(3)})`);
  }
}

function assertPreviewMatchesPDF(preview, points, expected, label) {
  assert.ok(preview && preview.pixels.length > 80, `${label}: preview has no magenta cut outline`);
  const p = bounds(points);
  const v = bounds(preview.pixels);
  const pdfW = (p.maxX - p.minX) / 72;
  const pdfH = (p.maxY - p.minY) / 72;
  assert.ok(Math.abs(pdfW - expected.width) < 0.025,
    `${label}: PDF vector width ${pdfW}" differs from UI cut size ${expected.width}"`);
  assert.ok(Math.abs(pdfH - expected.height) < 0.025,
    `${label}: PDF vector height ${pdfH}" differs from UI cut size ${expected.height}"`);
  const vw = v.maxX - v.minX, vh = v.maxY - v.minY;
  assert.ok(vw > 90 && vh > 90, `${label}: preview outline is too small`);
  assert.ok(Math.abs(vw / vh - pdfW / pdfH) < 0.045,
    `${label}: preview aspect ${vw / vh} differs from PDF vector ${pdfW / pdfH}`);
  // Compare the *whole boundary*, not merely its enclosing box. A rectangle
  // incorrectly substituted for an oval has the same bounds but fails here.
  const occupied = new Set(preview.pixels.map(([x, y]) => `${x},${y}`));
  let hits = 0;
  for (const [x, y] of points) {
    const px = Math.round(v.minX + (x - p.minX) / (p.maxX - p.minX) * vw);
    const py = Math.round(v.minY + (p.maxY - y) / (p.maxY - p.minY) * vh);
    let match = false;
    for (let dy = -4; dy <= 4 && !match; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (occupied.has(`${px + dx},${py + dy}`)) { match = true; break; }
      }
    }
    if (match) hits++;
  }
  assert.ok(hits / points.length > 0.82,
    `${label}: only ${hits}/${points.length} PDF cut-path samples overlap the preview outline`);
}

async function downloadPDF(page, button, label) {
  await button.waitFor({ state: "visible", timeout: 30_000 });
  const pending = page.waitForEvent("download", { timeout: 90_000 });
  await button.click({ timeout: 30_000 });
  const download = await pending;
  const path = await download.path();
  assert.ok(path, `${label}: no downloaded PDF path`);
  const bytes = await readFile(path);
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "%PDF", `${label}: not a PDF`);
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1, `${label}: expected one page`);
  assert.ok(separationNames(pdf).includes("KnifeLine"),
    `${label}: CutContour spot name KnifeLine missing`);
  return pdf;
}

async function cutSize(page) {
  const badge = page.getByText("Cut Size", { exact: true }).locator("xpath=..");
  const value = await badge.textContent();
  const match = value.match(/(\d+(?:\.\d+)?)"\s*×\s*(\d+(?:\.\d+)?)"/);
  assert.ok(match, `cannot read Cut Size from ${value}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function checkPage(pdf, size, label, bleed = 0.2) {
  const { width, height } = pdf.getPage(0).getSize();
  assert.ok(Math.abs(width / 72 - size.width - bleed) < 0.025,
    `${label}: PDF page width ${width / 72}" vs UI cut width ${size.width}" + ${bleed}" bleed`);
  assert.ok(Math.abs(height / 72 - size.height - bleed) < 0.025,
    `${label}: PDF page height ${height / 72}" vs UI cut height ${size.height}" + ${bleed}" bleed`);
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

try {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="file"]').first().setInputFiles(fixture);
  const outline = page.getByRole("button", { name: "Outline Type", exact: true });
  await outline.waitFor({ state: "visible", timeout: 30_000 });
  const shape = page.getByRole("button", { name: "Shape", exact: true });
  // Outline Type can already be expanded. Never blindly toggle it shut.
  if (!await shape.isVisible()) await outline.click();
  await shape.click();
  const circle = page.getByRole("button", { name: "Circle", exact: true });
  if (!await circle.isVisible()) await shape.click();
  await circle.waitFor({ state: "visible" });
  const cutInput = page.getByLabel("CutContour spot name").first();
  await cutInput.fill("KnifeLine");
  await cutInput.press("Enter");
  assert.equal(await cutInput.inputValue(), "KnifeLine");

  const standard = page.getByRole("button", { name: "Download PDF", exact: true }).first();
  const single = page.getByRole("button", { name: "Single Artboard Download", exact: true });
  const presets = ["Circle", "Oval", "Rounded", "Square", "Rectangle", "Rounded Sq"];
  const results = [];
  for (const preset of presets) {
    await page.getByRole("button", { name: preset, exact: true }).click();
    if (preset === "Rounded" || preset === "Rounded Sq") {
      const corners = page.getByText("Corners", { exact: true }).locator("xpath=..");
      await corners.locator('input[type="range"]').fill("0.38");
      assert.match(await corners.textContent(), /0\.38"/);
    }
    if (preset === "Oval" || preset === "Rounded") {
      const advanced = page.getByRole("button", { name: "Advanced", exact: true });
      if (!await page.getByText("Custom Cut Size", { exact: true }).isVisible()) await advanced.click();
      const custom = page.getByText("Custom Cut Size", { exact: true }).locator("xpath=..");
      const dimensions = custom.locator('input[type="number"]');
      assert.equal(await dimensions.count(), 2, `${preset}: custom cut size inputs missing`);
      const unlock = custom.getByTitle("Unlock aspect ratio");
      if (await unlock.isVisible()) await unlock.click();
      await dimensions.nth(0).fill("3.4");
      await dimensions.nth(1).fill("2.2");
      const position = page.getByText("Image Position", { exact: true }).locator("xpath=../..");
      const fields = position.locator('input[type="number"]');
      assert.equal(await fields.count(), 3, `${preset}: image position inputs missing`);
      await fields.nth(0).fill("0.18");
      await fields.nth(1).fill("-0.12");
      await fields.nth(2).fill("125");
      assert.deepEqual(await fields.evaluateAll((inputs) => inputs.map((input) => input.value)),
        ["0.18", "-0.12", "125"]);
    }
    const size = await cutSize(page);
    if (preset === "Oval" || preset === "Rounded") {
      assert.deepEqual(size, { width: 3.4, height: 2.2 },
        `${preset}: custom dimensions were not applied`);
    }
    await page.waitForTimeout(350); // preview's 100ms debounced shape settings + paint
    const preview = await previewOutline(page);
    await page.screenshot({
      path: `${artifactDir}/shape-parity-${preset.toLowerCase().replace(/\s+/g, "-")}.png`,
      fullPage: true,
    });
    const pdf = await downloadPDF(page, standard, `${preset} standard`);
    await checkPage(pdf, size, `${preset} standard`);
    assertPreviewMatchesPDF(preview, pdfCutPath(pdf, "KnifeLine"), size, preset);
    if (preset === "Oval" || preset === "Rounded") assertArtworkPosition(preview, pdf, size, preset);
    // Both download actions must preserve the same cutline geometry.
    const singlePDF = await downloadPDF(page, single, `${preset} single artboard`);
    await checkPage(singlePDF, size, `${preset} single artboard`);
    assertPreviewMatchesPDF(preview, pdfCutPath(singlePDF, "KnifeLine"), size, `${preset} single artboard`);
    results.push({ preset, size });
  }

  // Negative margins must shrink the shape, clear previous custom cut-size
  // overrides, and produce the same visible and downloaded boundary.
  for (const preset of presets) {
    await page.getByRole("button", { name: preset, exact: true }).click();
    const margin = page.getByRole("slider", { name: "Shape Margin", exact: true });
    await margin.fill("0");
    await page.waitForTimeout(200);
    const zero = await cutSize(page);
    await margin.fill("-0.2");
    await page.waitForTimeout(350);
    const smaller = await cutSize(page);
    assert.ok(smaller.width < zero.width && smaller.height < zero.height, `${preset}: negative margin did not shrink`);
    const preview = await previewOutline(page);
    for (const button of [standard, single]) {
      const pdf = await downloadPDF(page, button, `${preset} negative margin`);
      await checkPage(pdf, smaller, preset);
      assertPreviewMatchesPDF(preview, pdfCutPath(pdf, "KnifeLine"), smaller, preset);
    }
    await margin.fill("0.25");
    await page.waitForTimeout(200);
    const larger = await cutSize(page);
    assert.ok(larger.width > zero.width && larger.height > zero.height);
  }

  // Save an asymmetric, offset, scaled rounded rectangle, then verify the
  // gang-sheet item export retains its own cutline (not the sheet's bounds).
  await page.getByRole("button", { name: "Rounded", exact: true }).click();
  const advanced = page.getByRole("button", { name: "Advanced", exact: true });
  if (!await page.getByText("Custom Cut Size", { exact: true }).isVisible()) await advanced.click();
  const custom = page.getByText("Custom Cut Size", { exact: true }).locator("xpath=..");
  await custom.locator('input[type="number"]').nth(0).fill("3.4");
  await custom.locator('input[type="number"]').nth(1).fill("2.2");
  const size = await cutSize(page);
  await page.getByRole("button", { name: "Add to Gang Sheet", exact: true }).click();
  await page.getByRole("button", { name: /View Gangsheet/ }).click();
  const region = page.getByRole("region", { name: "Gang sheet layers" });
  await region.waitFor({ state: "visible", timeout: 30_000 });
  const row = region.locator('img[alt="sticker"]').first().locator("xpath=..");
  await page.screenshot({ path: `${artifactDir}/shape-parity-desktop.png`, fullPage: true });
  const panel = region.locator("xpath=..");
  const presetText = await panel.getByRole("combobox").first().textContent();
  const sheetMatch = presetText?.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
  assert.ok(sheetMatch, `gang-sheet preset dimensions missing: ${presetText}`);
  const sheet = { width: Number(sheetMatch[1]), height: Number(sheetMatch[2]) };
  for (const [name, button] of [
    ["gang standard", page.getByRole("button", { name: "Download Gang Sheet PDF", exact: true })],
    ["gang single", panel.getByRole("button", { name: "Single Artboard Download", exact: true })],
  ]) {
    const pdf = await downloadPDF(page, button, name);
    await checkPage(pdf, sheet, name, 0);
    const b = bounds(pdfCutPath(pdf, "KnifeLine"));
    assert.ok(Math.abs((b.maxX - b.minX) / 72 - size.width) < 0.025, `${name}: cut width changed`);
    assert.ok(Math.abs((b.maxY - b.minY) / 72 - size.height) < 0.025, `${name}: cut height changed`);
  }
  for (const [name, action] of [
    ["gang item standard", "Download design 1 PDF"],
    ["gang item single", "Single Artboard Download design 1"],
  ]) {
    const pdf = await downloadPDF(page, row.getByRole("button", { name: action, exact: true }), name);
    await checkPage(pdf, size, name);
    const path = pdfCutPath(pdf, "KnifeLine");
    const b = bounds(path);
    assert.ok(Math.abs((b.maxX - b.minX) / 72 - size.width) < 0.025, `${name}: cut width changed`);
    assert.ok(Math.abs((b.maxY - b.minY) / 72 - size.height) < 0.025, `${name}: cut height changed`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${artifactDir}/shape-parity-mobile.png`, fullPage: true });
  assert.deepEqual(errors, [], `browser exceptions: ${errors.join("; ")}`);
  console.log("shape-parity-browser: passed", results);
} finally {
  await browser.close();
}