// Run against a running dev server:
// PLAYWRIGHT_MODULE=/mnt/pid2/node_modules/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium \
// node tests/gangsheet-item-download-browser.mjs
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const devDomain = process.env.REPLIT_DEV_DOMAIN;
const baseURL = process.env.TEST_BASE_URL || (devDomain ? `https://${devDomain}` : null);
if (!baseURL) throw new Error("REPLIT_DEV_DOMAIN (or TEST_BASE_URL) is required");

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.CHROMIUM_EXECUTABLE }
    : {}),
  args: ["--no-sandbox"],
});

const artifactDir = "tests/artifacts";
await mkdir(artifactDir, { recursive: true });

function makeDesign(kind, copy) {
  const width = kind === "a" ? 900 : 1200;
  const height = kind === "a" ? 600 : 900;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = kind === "a" ? "#f24b4b" : "#2368d1";
  ctx.fillRect(0, 0, width, height);
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = kind === "a" ? "#ffe66d" : "#7fffd4";
  ctx.lineWidth = kind === "a" ? 18 : 22;
  for (let x = -height; x < width + height; x += 70) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + height, height);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${kind === "a" ? 108 : 132}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(kind === "a" ? "DESIGN A" : "DESIGN B", width / 2, height / 2);
  ctx.font = "bold 34px sans-serif";
  ctx.fillText(`COPY ${copy}`, width / 2, height / 2 + 100);
  return {
    name: `gangsheet-item-${kind}-${copy}.png`,
    mimeType: "image/png",
    buffer: canvas.toBuffer("image/png"),
  };
}

const files = Array.from({ length: 8 }, (_, index) =>
  makeDesign(index % 2 === 0 ? "a" : "b", index + 1)
);

async function waitForGangCount(page, count) {
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll("button")].some((button) => {
        if (!button.textContent?.includes("View Gangsheet")) return false;
        return button.querySelector("span")?.textContent?.trim() === String(expected);
      }),
    count,
    { timeout: 90000 }
  );
}

async function uploadAndAdd(page, file, expectedCount, firstUpload = false) {
  const input = firstUpload
    ? page.locator('input[type="file"]').first()
    : page.locator("#spot-uv-change-design-input");
  await input.setInputFiles(file);
  await page.waitForFunction(
    (fileName) =>
      (document.querySelector("#spot-uv-change-design-input") ||
        document.querySelector('input[type="file"]'))?.value.endsWith(fileName),
    file.name,
    { timeout: 30000 }
  );
  await page.waitForTimeout(500);
  const add = page.getByRole("button", {
    name: "Add to Gang Sheet",
    exact: true,
  });
  await add.waitFor({ state: "visible", timeout: 30000 });
  await add.click();
  await waitForGangCount(page, expectedCount);
}

async function regionMetrics(region) {
  return region.evaluate((element) => {
    const rows = [...element.querySelectorAll('img[alt="sticker"]')].map((image) => {
      const rect = image.parentElement?.getBoundingClientRect();
      return rect ? { top: rect.top, bottom: rect.bottom } : null;
    });
    const rect = element.getBoundingClientRect();
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      viewportTop: rect.top,
      viewportBottom: rect.bottom,
      rows,
      quantities: [...element.querySelectorAll('input[type="number"]')].map(
        (input) => input.value
      ),
    };
  });
}

function assertBottomRowVisible(metrics, name) {
  const row = metrics.rows.at(-1);
  assert.ok(row, `${name}: final layer row was not rendered`);
  assert.ok(
    row.top >= metrics.viewportTop - 1 &&
      row.bottom <= metrics.viewportBottom + 1,
    `${name}: final layer row was not reachable after scrolling (${JSON.stringify(metrics)})`
  );
}

async function assertControlsFit(region, row, name) {
  const rowBox = await row.boundingBox();
  const download = row.getByRole("button", {
    name: /Download design \d+ PDF/,
  });
  const plus = row.getByRole("button", { name: "+", exact: true });
  const remove = row.getByTitle("Remove");
  assert.ok(rowBox, `${name}: row has no bounding box`);
  for (const [label, locator] of [
    ["download", download],
    ["quantity +", plus],
    ["remove", remove],
  ]) {
    const box = await locator.boundingBox();
    assert.ok(box, `${name}: ${label} control is not visible`);
    assert.ok(box.width >= 18 && box.height >= 18, `${name}: ${label} control is too small`);
    assert.ok(
      box.x >= rowBox.x - 1 && box.x + box.width <= rowBox.x + rowBox.width + 1,
      `${name}: ${label} control overflows row (${JSON.stringify({ rowBox, box })})`
    );
  }
}

async function saveAndParseDownload(page, button, expectedWidth, expectedHeight, label) {
  const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
  await button.click();
  const download = await downloadPromise;
  const filename = download.suggestedFilename();
  assert.match(
    filename,
    new RegExp(`^design_[A-Za-z0-9_-]+_${expectedWidth.toFixed(2)}x${expectedHeight.toFixed(2)}\\.pdf$`),
    `${label}: unexpected download filename`
  );
  const downloadPath = await download.path();
  assert.ok(downloadPath, `${label}: Playwright did not expose a download path`);
  const bytes = await readFile(downloadPath);
  assert.ok(bytes.length > 1000, `${label}: downloaded PDF is unexpectedly empty`);
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1, `${label}: item PDF should have one page`);
  const size = pdf.getPage(0).getSize();
  assert.ok(Math.abs(size.width / 72 - expectedWidth) < 0.02, `${label}: PDF width mismatch`);
  assert.ok(Math.abs(size.height / 72 - expectedHeight) < 0.02, `${label}: PDF height mismatch`);
  assert.ok(
    Math.abs(size.width / 72 - 48) > 1 || Math.abs(size.height / 72 - 12) > 1,
    `${label}: item download incorrectly used the full 48×12 sheet`
  );

  // The single-design export contains one transparent background image and
  // one design image. A second design would add another image XObject; this
  // bounded check verifies the unselected row was not packed into the PDF.
  const pdfText = new TextDecoder().decode(bytes);
  const imageObjects = pdfText.match(/\/Subtype\s*\/Image/g) || [];
  assert.ok(
    imageObjects.length >= 2 && imageObjects.length <= 3,
    `${label}: PDF contains unexpected design image count`
  );
  return { filename, bytes, size, imageObjectCount: imageObjects.length };
}

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(baseURL, { waitUntil: "domcontentloaded" });
    await page.getByText("Upload your Design", { exact: true }).waitFor({
      state: "visible",
      timeout: 30000,
    });
    await uploadAndAdd(page, files[0], 1, true);
    for (let index = 1; index < files.length; index += 1) {
      await uploadAndAdd(page, files[index], index + 1);
    }

    await page.getByRole("button", { name: /View Gangsheet/ }).click();
    const region = page.getByRole("region", { name: "Gang sheet layers" });
    await region.waitFor({ state: "visible", timeout: 30000 });
    assert.equal(await region.locator('img[alt="sticker"]').count(), 8);

    // Select design B (row 2), then increase only its quantity.
    let selected = region.locator('img[alt="sticker"]').nth(1).locator("xpath=..");
    const selectedQuantity = selected.locator('input[type="number"]');
    assert.equal(await selectedQuantity.inputValue(), "1");
    await selected.getByRole("button", { name: "+", exact: true }).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="region"][aria-label="Gang sheet layers"]')
          ?.querySelectorAll('input[type="number"]')[1]?.value === "2",
      undefined,
      { timeout: 30000 }
    );
    assert.equal(await selectedQuantity.inputValue(), "2");

    const stateBefore = await region.evaluate((element) => {
      const sheet = [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("48 x 12")
      );
      return {
        quantities: [...element.querySelectorAll('input[type="number"]')].map(
          (input) => input.value
        ),
        designs: element.querySelectorAll('img[alt="sticker"]').length,
        sheet: sheet?.textContent?.replace(/\s+/g, " ").trim(),
      };
    });
    assert.deepEqual(stateBefore.quantities, ["1", "2", "1", "1", "1", "1", "1", "1"]);
    assert.equal(stateBefore.designs, 8);
    assert.match(stateBefore.sheet || "", /48 x 12/);

    await assertControlsFit(region, selected, "desktop");
    await region.evaluate((element) => {
      element.scrollTop = 0;
    });
    const desktopTop = await regionMetrics(region);
    assert.ok(
      desktopTop.scrollHeight > desktopTop.clientHeight + 1,
      `desktop: layer list did not overflow enough for native scrolling (${JSON.stringify(desktopTop)})`
    );
    await region.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const desktopBottom = await regionMetrics(region);
    assert.ok(desktopBottom.scrollTop > desktopTop.scrollTop, "desktop: native scrollTop did not change");
    assertBottomRowVisible(desktopBottom, "desktop");
    await page.screenshot({
      path: `${artifactDir}/gangsheet-item-download-browser-desktop.png`,
      fullPage: true,
    });

    // Download row 2 while row 1 is the visually distinct, unselected design.
    selected = region.locator('img[alt="sticker"]').nth(1).locator("xpath=..");
    const firstDownload = await saveAndParseDownload(
      page,
      selected.getByRole("button", { name: "Download design 2 PDF", exact: true }),
      4,
      3,
      "first row-2 download"
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(350);
    await region.evaluate((element) => {
      element.scrollTop = 0;
    });
    const mobileTop = await regionMetrics(region);
    assert.ok(
      mobileTop.scrollHeight > mobileTop.clientHeight + 1,
      `mobile: layer list did not overflow enough for native scrolling (${JSON.stringify(mobileTop)})`
    );
    await region.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const mobileBottom = await regionMetrics(region);
    assert.ok(mobileBottom.scrollTop > mobileTop.scrollTop, "mobile: native scrollTop did not change");
    assertBottomRowVisible(mobileBottom, "mobile");

    selected = region.locator('img[alt="sticker"]').nth(1).locator("xpath=..");
    await assertControlsFit(region, selected, "mobile");
    const secondDownload = await saveAndParseDownload(
      page,
      selected.getByRole("button", { name: "Download design 2 PDF", exact: true }),
      4,
      3,
      "repeat row-2 download"
    );
    assert.equal(
      secondDownload.filename,
      firstDownload.filename,
      "repeat download: filename changed for the same saved design"
    );
    await page.screenshot({
      path: `${artifactDir}/gangsheet-item-download-browser-mobile.png`,
      fullPage: true,
    });

    const stateAfter = await region.evaluate((element) => {
      const sheet = [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("48 x 12")
      );
      return {
        quantities: [...element.querySelectorAll('input[type="number"]')].map(
          (input) => input.value
        ),
        designs: element.querySelectorAll('img[alt="sticker"]').length,
        sheet: sheet?.textContent?.replace(/\s+/g, " ").trim(),
      };
    });
    assert.deepEqual(stateAfter, stateBefore, "download changed rows, quantities, or sheet settings");
    assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join("; ")}`);
    console.log(
      "Gang sheet item download passed: selected row exported as a tight one-design PDF, repeat download was stable, unselected design was excluded, rows/settings stayed unchanged, and desktop/mobile controls plus native scrolling worked."
    );
    console.log(
      `Downloaded ${firstDownload.filename}; parsed page ${firstDownload.size.width / 72}x${firstDownload.size.height / 72}in with ${firstDownload.imageObjectCount} image XObjects (background plus one design, including any alpha mask). Screenshots: ${artifactDir}/gangsheet-item-download-browser-desktop.png, ${artifactDir}/gangsheet-item-download-browser-mobile.png`
    );
  } finally {
    await page.close();
  }
} finally {
  await browser.close();
}