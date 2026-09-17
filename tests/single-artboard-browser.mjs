// Run against a running dev server (the parent agent should restart it first):
// PLAYWRIGHT_MODULE=/mnt/pid2/node_modules/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium \
// TEST_BASE_URL=http://127.0.0.1:5000 node tests/single-artboard-browser.mjs
//
// This test uses the real PNG extraction, contour generation, and PDF download
// paths. It does not mock the editor, workers, canvases, or export endpoints.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFStream,
} from "pdf-lib";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "/mnt/pid2/node_modules/playwright/index.mjs",
);
const executablePath = process.env.CHROMIUM_EXECUTABLE ||
  "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";
const baseURL = process.env.TEST_BASE_URL ||
  `https://${process.env.REPLIT_DEV_DOMAIN}`;

assert.ok(
  process.env.REPLIT_DEV_DOMAIN || process.env.TEST_BASE_URL,
  "Set REPLIT_DEV_DOMAIN or TEST_BASE_URL before running this browser test",
);

const canvas = createCanvas(360, 240);
const context = canvas.getContext("2d");
context.fillStyle = "#ffffff";
context.fillRect(0, 0, canvas.width, canvas.height);
context.fillStyle = "#111111";
context.fillRect(22, 20, 138, 88);
context.fillStyle = "#e31b23";
context.fillRect(200, 20, 138, 88);
context.fillStyle = "#1268d3";
context.beginPath();
context.arc(92, 178, 48, 0, Math.PI * 2);
context.fill();
context.fillStyle = "#f2c811";
context.beginPath();
context.arc(268, 178, 48, 0, Math.PI * 2);
context.fill();
const fixture = {
  name: "single-artboard-browser.png",
  mimeType: "image/png",
  buffer: canvas.toBuffer("image/png"),
};

function resolveObject(pdf, value) {
  if (value === undefined) return undefined;
  try {
    return pdf.context.lookup(value);
  } catch {
    return value;
  }
}

function decodedName(value) {
  return value instanceof PDFName
    ? value.decodeText().replace(/^\/+/, "")
    : null;
}

/**
 * Read actual /Separation names through pdf-lib. Form XObjects may own their
 * own resource dictionaries, so only inspecting the page resource dictionary
 * would miss valid spot channels in nested artwork.
 */
function decodedSeparationNames(pdf) {
  const names = new Set();
  const visited = new Set();

  const visitResources = (resourceValue) => {
    const resources = resolveObject(pdf, resourceValue);
    if (!(resources instanceof PDFDict) || visited.has(resources)) return;
    visited.add(resources);

    const colorSpaces = resolveObject(
      pdf,
      resources.get(PDFName.of("ColorSpace")),
    );
    if (colorSpaces instanceof PDFDict) {
      for (const [, colorValue] of colorSpaces.entries()) {
        const colorSpace = resolveObject(pdf, colorValue);
        if (!(colorSpace instanceof PDFArray) || colorSpace.size() < 2) continue;
        const family = resolveObject(pdf, colorSpace.get(0));
        if (decodedName(family) !== "Separation") continue;
        const spotName = decodedName(resolveObject(pdf, colorSpace.get(1)));
        if (spotName) names.add(spotName);
      }
    }

    const xObjects = resolveObject(pdf, resources.get(PDFName.of("XObject")));
    if (!(xObjects instanceof PDFDict)) return;
    for (const [, xObjectValue] of xObjects.entries()) {
      const xObject = resolveObject(pdf, xObjectValue);
      if (!(xObject instanceof PDFStream)) continue;
      if (decodedName(resolveObject(pdf, xObject.dict.get(PDFName.of("Subtype")))) !== "Form") {
        continue;
      }
      visitResources(xObject.dict.get(PDFName.of("Resources")));
    }
  };

  for (const page of pdf.getPages()) visitResources(page.node.Resources());
  return [...names].sort();
}

async function downloadAndParse(page, button, expectedPages, label) {
  await button.waitFor({ state: "visible", timeout: 30_000 });
  await button.waitFor({ state: "attached" });
  const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
  await button.click();

  // This dialog is only expected if a contour was not ready. Supporting it
  // here keeps the failure diagnostic useful, but the page-count assertions
  // below still require the real separated export.
  const yes = page.getByRole("button", { name: "Yes", exact: true });
  if (await yes.first().waitFor({ state: "visible", timeout: 1_500 }).then(
    () => true,
    () => false,
  )) {
    await yes.first().click();
  }

  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path, `${label}: Playwright did not expose the downloaded PDF path`);
  const bytes = await fs.readFile(path);
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "%PDF", `${label}: download is not a PDF`);
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), expectedPages, `${label}: unexpected PDF page count`);
  return {
    bytes,
    pdf,
    filename: download.suggestedFilename(),
    names: decodedSeparationNames(pdf),
  };
}

function assertNames(result, expected, label) {
  for (const name of expected) {
    assert.ok(
      result.names.includes(name),
      `${label}: missing decoded /Separation ${name}; found ${result.names.join(", ") || "(none)"}`,
    );
  }
}

function assertPageSize(pdf, widthInches, heightInches, label) {
  const size = pdf.getPage(0).getSize();
  assert.ok(
    Math.abs(size.width / 72 - widthInches) < 0.02,
    `${label}: expected ${widthInches}" width, got ${size.width / 72}"`,
  );
  assert.ok(
    Math.abs(size.height / 72 - heightInches) < 0.02,
    `${label}: expected ${heightInches}" height, got ${size.height / 72}"`,
  );
}

async function selectWhiteAndGloss(page) {
  const spotButton = page.getByRole("button", {
    name: "Spot White and Gloss",
    exact: true,
  });
  await spotButton.waitFor({ state: "visible", timeout: 30_000 });
  await spotButton.click();

  const firstCard = page.locator("[data-color-index]").first();
  await firstCard.waitFor({ state: "visible", timeout: 30_000 });
  const cards = page.locator("[data-color-index]");
  const count = await cards.count();
  assert.ok(count > 0, "real color extraction produced no selectable colors");

  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const white = card.locator('button[title^="Apply White to all shapes"]');
    const gloss = card.locator('button[title^="Apply Gloss to all shapes"]');
    if (await white.count()) await white.first().click();
    else {
      const individualWhite = card.locator('button[title^="Apply White"]').first();
      if (await individualWhite.count()) await individualWhite.click();
    }
    if (await gloss.count()) await gloss.first().click();
    else {
      const individualGloss = card.locator('button[title^="Apply Gloss"]').first();
      if (await individualGloss.count()) await individualGloss.click();
    }
  }

  await page.getByTitle("Edit White spot name").waitFor({
    state: "visible",
    timeout: 10_000,
  });
}

async function renameSpots(page) {
  const cutName = page.getByLabel("CutContour spot name").first();
  await cutName.fill("KnifeLine");
  await cutName.press("Enter");
  assert.equal(await cutName.inputValue(), "KnifeLine");

  await page.getByTitle("Edit White spot name").click();
  const whiteInput = page.getByLabel("White spot name");
  await whiteInput.fill("Underbase");
  await whiteInput.press("Enter");
  await page.getByText("Underbase", { exact: true }).waitFor({ state: "visible" });

  await page.getByTitle("Edit Varnish (Gloss) spot name").click();
  const glossInput = page.getByLabel("Varnish (Gloss) spot name");
  await glossInput.fill("Varnish");
  await glossInput.press("Enter");
  await page.getByText("Varnish", { exact: true }).waitFor({ state: "visible" });
}

const expectedNames = ["KnifeLine", "Underbase", "Varnish"];
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

try {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="file"]').first().setInputFiles(fixture);
  // Cutting names can only appear when an outline is enabled. The default
  // no-outline editor correctly offers an artwork-only download instead.
  const outlineButton = page.getByRole("button", { name: "Outline Type", exact: true });
  await outlineButton.waitFor({ state: "visible", timeout: 30_000 });
  const shapeButton = page.getByRole("button", { name: "Shape", exact: true });
  if (!await shapeButton.waitFor({ state: "visible", timeout: 2_000 }).then(
    () => true,
    () => false,
  )) {
    await outlineButton.click();
    await shapeButton.waitFor({ state: "visible", timeout: 10_000 });
  }
  const rectangleButton = page.getByRole("button", { name: "Rectangle", exact: true });
  if (!await rectangleButton.isVisible().catch(() => false)) {
    await shapeButton.click();
    await rectangleButton.waitFor({ state: "visible", timeout: 10_000 });
  }
  await rectangleButton.click();
  await selectWhiteAndGloss(page);
  await renameSpots(page);

  const standardButton = page.getByRole("button", {
    name: "Download PDF",
    exact: true,
  }).first();
  const singleButton = page.getByRole("button", {
    name: "Single Artboard Download",
    exact: true,
  });
  assert.equal(await singleButton.count(), 1, "individual editor must have one exact Single Artboard Download action");
  assert.ok(
    await standardButton.evaluate((standard, single) =>
      !!(standard.compareDocumentPosition(single) & Node.DOCUMENT_POSITION_FOLLOWING),
    await singleButton.elementHandle()),
    "Single Artboard Download should be the second individual download action",
  );

  const individualStandard = await downloadAndParse(
    page,
    standardButton,
    3,
    "individual standard download",
  );
  assertNames(individualStandard, expectedNames, "individual standard download");
  const individualSingle = await downloadAndParse(
    page,
    singleButton,
    1,
    "individual single-artboard download",
  );
  assertNames(individualSingle, expectedNames, "individual single-artboard download");

  const add = page.getByRole("button", { name: "Add to Gang Sheet", exact: true });
  if (await add.count() && await add.isVisible() && await add.isEnabled()) {
    await add.click();
    const viewGang = page.getByRole("button", { name: /View Gangsheet/ });
    await viewGang.waitFor({ state: "visible", timeout: 90_000 });
    await viewGang.click();

    const gangStandardButton = page.getByRole("button", {
      name: "Download Gang Sheet PDF",
      exact: true,
    });
    await gangStandardButton.waitFor({ state: "visible", timeout: 30_000 });
    const layersRegion = page.getByRole("region", { name: "Gang sheet layers" });
    await layersRegion.waitFor({ state: "visible", timeout: 30_000 });
    const panel = layersRegion.locator("xpath=..");
    const presetLabel = (await panel.getByRole("combobox").first().textContent())?.trim() || "";
    const dimensions = presetLabel.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
    assert.ok(dimensions, `could not read gang-sheet dimensions from preset "${presetLabel}"`);
    const sheetWidth = Number(dimensions[1]);
    const sheetHeight = Number(dimensions[2]);

    await page.screenshot({ path: "/tmp/single-artboard-desktop.png", fullPage: true });

    const gangStandard = await downloadAndParse(
      page,
      gangStandardButton,
      3,
      "gang-sheet standard download",
    );
    assertNames(gangStandard, expectedNames, "gang-sheet standard download");
    assertPageSize(gangStandard.pdf, sheetWidth, sheetHeight, "gang-sheet standard download");

    const gangSingleButton = panel.getByRole("button", {
      name: "Single Artboard Download",
      exact: true,
    });
    assert.equal(await gangSingleButton.count(), 1, "gang-sheet panel must have one exact Single Artboard Download action");
    const gangSingle = await downloadAndParse(
      page,
      gangSingleButton,
      1,
      "gang-sheet single-artboard download",
    );
    assertNames(gangSingle, expectedNames, "gang-sheet single-artboard download");
    assertPageSize(gangSingle.pdf, sheetWidth, sheetHeight, "gang-sheet single-artboard download");

    // Some entry variants expose downloads on each item row. When present,
    // scope the new action to that row so the panel-wide green button cannot
    // accidentally satisfy the selector.
    const firstRow = panel.locator('img[alt="sticker"]').first().locator("xpath=..");
    const itemStandardButton = firstRow.getByRole("button", {
      name: "Download design 1 PDF",
      exact: true,
    });
    const itemSingleButton = firstRow.getByRole("button", {
      name: /Single Artboard Download design 1/,
    });
    if (await itemSingleButton.count()) {
      if (await itemStandardButton.count()) {
        const itemStandard = await downloadAndParse(
          page,
          itemStandardButton,
          3,
          "gang-sheet item standard download",
        );
        assertNames(itemStandard, expectedNames, "gang-sheet item standard download");
      }
      const itemSingle = await downloadAndParse(
        page,
        itemSingleButton,
        1,
        "gang-sheet item single-artboard download",
      );
      assertNames(itemSingle, expectedNames, "gang-sheet item single-artboard download");
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: "/tmp/single-artboard-mobile.png", fullPage: true });
  } else {
    // The individual entry is still fully tested. A hidden/disabled Add
    // action means this deployment does not allow entering the gang-sheet UI.
    await page.screenshot({ path: "/tmp/single-artboard-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/single-artboard-mobile.png", fullPage: true });
    console.warn("single-artboard-browser: Add to Gang Sheet unavailable; gang-sheet assertions skipped");
  }

  assert.deepEqual(errors, [], `browser page errors: ${errors.join("; ")}`);
  console.log("single-artboard-browser: passed");
} finally {
  await browser.close();
}