// Run against a running dev server:
// PLAYWRIGHT_MODULE=/mnt/pid2/node_modules/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium \
// node tests/gangsheet-preview-resolution-browser.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";

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

function makeHighDetailArtwork() {
  const width = 1600;
  const height = 1200;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#071b4d");
  gradient.addColorStop(0.32, "#00a6a6");
  gradient.addColorStop(0.66, "#f04e98");
  gradient.addColorStop(1, "#ffb347");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Fine repeated details make a low-resolution backing bitmap observable,
  // while keeping the fixture deterministic and small enough for a browser
  // upload. The source remains genuinely 1600px wide.
  ctx.globalAlpha = 0.72;
  for (let x = 0; x < width; x += 8) {
    ctx.strokeStyle = x % 24 === 0 ? "#ffffff" : "#102a70";
    ctx.lineWidth = x % 24 === 0 ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 500, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 8) {
    ctx.strokeStyle = y % 32 === 0 ? "#fff3b0" : "#0b426c";
    ctx.lineWidth = y % 32 === 0 ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y + 160);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.9;
  for (let y = 80; y < height; y += 120) {
    for (let x = 80; x < width; x += 120) {
      ctx.fillStyle = (x / 120 + y / 120) % 2 ? "#fff2a8" : "#102a70";
      ctx.beginPath();
      ctx.arc(x, y, 25 + ((x + y) % 18), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 116px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("DETAIL", width / 2, height / 2 - 52);
  ctx.font = "bold 42px sans-serif";
  ctx.fillText("1600 PX • GANG SHEET RESOLUTION CHECK", width / 2, height / 2 + 74);

  return {
    name: "gangsheet-preview-resolution-1600px.png",
    mimeType: "image/png",
    buffer: canvas.toBuffer("image/png"),
  };
}

async function waitForVisibleCanvas(page) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("canvas")].some(
        (canvas) => canvas.offsetWidth > 0 && canvas.offsetHeight > 0
      ),
    undefined,
    { timeout: 30000 }
  );
  return page.locator("canvas").first();
}

async function canvasMetrics(page) {
  return page.evaluate(() => {
    const canvas = [...document.querySelectorAll("canvas")].find(
      (element) => element.offsetWidth > 0 && element.offsetHeight > 0
    );
    if (!canvas) throw new Error("Visible preview canvas not found");
    const container = canvas.parentElement;
    if (!container) throw new Error("Preview canvas container not found");
    const containerStyle = getComputedStyle(container);
    const canvasStyle = getComputedStyle(canvas);
    const rect = canvas.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const contentWidth =
      container.clientWidth -
      (parseFloat(containerStyle.paddingLeft) || 0) -
      (parseFloat(containerStyle.paddingRight) || 0);
    const contentHeight =
      container.clientHeight -
      (parseFloat(containerStyle.paddingTop) || 0) -
      (parseFloat(containerStyle.paddingBottom) || 0);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const logicalWidth = Math.max(220, Math.round(contentWidth * dpr));
    const logicalHeight = Math.max(220, Math.round(contentHeight * dpr));
    return {
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      cssRectWidth: rect.width,
      cssRectHeight: rect.height,
      cssLayoutWidth: canvas.offsetWidth,
      cssLayoutHeight: canvas.offsetHeight,
      cssWidth: parseFloat(canvasStyle.width),
      cssHeight: parseFloat(canvasStyle.height),
      transform: canvasStyle.transform,
      containerWidth: containerRect.width,
      containerHeight: containerRect.height,
      contentWidth,
      contentHeight,
      logicalWidth,
      logicalHeight,
      dpr,
    };
  });
}

async function waitForGangSheetFit(page) {
  await page.waitForFunction(
    () => {
      const canvas = [...document.querySelectorAll("canvas")].find(
        (element) => element.offsetWidth > 0 && element.offsetHeight > 0
      );
      if (!canvas || !canvas.parentElement) return false;
      const container = canvas.parentElement;
      const style = getComputedStyle(container);
      const contentWidth =
        container.clientWidth -
        (parseFloat(style.paddingLeft) || 0) -
        (parseFloat(style.paddingRight) || 0);
      const contentHeight =
        container.clientHeight -
        (parseFloat(style.paddingTop) || 0) -
        (parseFloat(style.paddingBottom) || 0);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const logicalWidth = Math.max(220, Math.round(contentWidth * dpr));
      const logicalHeight = Math.max(220, Math.round(contentHeight * dpr));
      return (
        Math.abs(canvas.width - logicalWidth * 2) <= 3 &&
        Math.abs(canvas.height - logicalHeight * 2) <= 3
      );
    },
    undefined,
    { timeout: 10000 }
  );
}

function assertGangSheetBacking(metrics, name) {
  assert.ok(
    metrics.backingWidth >= metrics.cssLayoutWidth * 1.8 &&
      metrics.backingHeight >= metrics.cssLayoutHeight * 1.8,
    `${name}: backing bitmap is not approximately 2x CSS size (${JSON.stringify(metrics)})`
  );
  assert.ok(
    Math.abs(metrics.backingWidth - metrics.logicalWidth * 2) <= 3 &&
      Math.abs(metrics.backingHeight - metrics.logicalHeight * 2) <= 3,
    `${name}: fit backing does not match measured DOM dimensions × quality 2 (${JSON.stringify(metrics)})`
  );
  assert.ok(
    Math.abs(
      metrics.backingWidth / metrics.backingHeight -
        metrics.logicalWidth / metrics.logicalHeight
    ) < 0.02,
    `${name}: backing aspect does not match measured logical preview aspect (${JSON.stringify(metrics)})`
  );
}

async function bitmapVariation(page) {
  return page.evaluate(() => {
    const canvas = [...document.querySelectorAll("canvas")].find(
      (element) => element.offsetWidth > 0 && element.offsetHeight > 0
    );
    if (!canvas) throw new Error("Visible preview canvas not found");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D preview context not found");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const stride = Math.max(4, Math.floor(pixels.length / 120_000 / 4) * 4);
    const colors = new Set();
    let colored = 0;
    for (let index = 0; index < pixels.length; index += stride) {
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      colors.add(`${r >> 3},${g >> 3},${b >> 3}`);
      if (Math.max(r, g, b) - Math.min(r, g, b) > 30) colored += 1;
    }
    return { width: canvas.width, height: canvas.height, uniqueColors: colors.size, colored };
  });
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
    const artwork = makeHighDetailArtwork();
    await page.locator('input[type="file"]').first().setInputFiles(artwork);
    await page.waitForFunction(
      (fileName) =>
        document.querySelector('input[type="file"]')?.value.endsWith(fileName),
      artwork.name,
      { timeout: 30000 }
    );
    await page.waitForTimeout(700);
    const addButton = page.getByRole("button", {
      name: "Add to Gang Sheet",
      exact: true,
    });
    await addButton.waitFor({ state: "visible", timeout: 30000 });
    await addButton.click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("button")].some((button) => {
          if (!button.textContent?.includes("View Gangsheet")) return false;
          return button.querySelector("span")?.textContent?.trim() === "1";
        }),
      undefined,
      { timeout: 90000 }
    );

    await page.getByRole("button", { name: /View Gangsheet/ }).click();
    await page.getByRole("button", { name: "Back to Designer", exact: true }).waitFor({
      state: "visible",
      timeout: 30000,
    });
    await waitForVisibleCanvas(page);
    await waitForGangSheetFit(page);

    const desktopFit = await canvasMetrics(page);
    assertGangSheetBacking(desktopFit, "desktop fit");
    assert.equal(
      Math.round(desktopFit.backingWidth / desktopFit.backingHeight * 100) / 100,
      Math.round(desktopFit.logicalWidth / desktopFit.logicalHeight * 100) / 100,
      "desktop fit: backing aspect ratio changed"
    );
    const desktopBitmap = await bitmapVariation(page);
    assert.ok(
      desktopBitmap.uniqueColors > 32 && desktopBitmap.colored > 300,
      `desktop fit: final bitmap lacks detailed color variation (${JSON.stringify(desktopBitmap)})`
    );
    await page.screenshot({
      path: `${artifactDir}/gangsheet-preview-resolution-browser-desktop.png`,
      fullPage: true,
    });

    const canvas = page.locator("canvas").first();
    const center = await canvas.boundingBox();
    assert.ok(center, "desktop: preview canvas has no bounding box");
    await page.mouse.move(
      center.x + center.width / 2,
      center.y + center.height / 2
    );
    for (let index = 0; index < 9; index += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(20);
    }
    // The component deliberately commits wheel zoom after a 150ms debounce.
    await page.waitForTimeout(350);
    const desktopZoomed = await canvasMetrics(page);
    assert.ok(
      desktopZoomed.backingWidth > desktopFit.backingWidth * 1.05 &&
        desktopZoomed.backingHeight > desktopFit.backingHeight * 1.05,
      `desktop zoom: backing resolution did not increase for zoom >2 (${JSON.stringify({
        fit: desktopFit,
        zoomed: desktopZoomed,
      })})`
    );
    assert.equal(
      desktopZoomed.cssLayoutWidth,
      desktopFit.cssLayoutWidth,
      "desktop zoom: CSS fit width changed"
    );
    assert.equal(
      desktopZoomed.cssLayoutHeight,
      desktopFit.cssLayoutHeight,
      "desktop zoom: CSS fit height changed"
    );
    assert.equal(
      desktopZoomed.containerWidth,
      desktopFit.containerWidth,
      "desktop zoom: preview layout width changed"
    );
    assert.equal(
      desktopZoomed.containerHeight,
      desktopFit.containerHeight,
      "desktop zoom: preview layout height changed"
    );
    assert.match(
      desktopZoomed.transform,
      /matrix|scale\(/,
      "desktop zoom: deliberate canvas transform was not applied"
    );
    const zoomedBitmap = await bitmapVariation(page);
    assert.ok(
      zoomedBitmap.width === desktopZoomed.backingWidth &&
        zoomedBitmap.height === desktopZoomed.backingHeight &&
        zoomedBitmap.uniqueColors > 32,
      `desktop zoom: detailed bitmap was not rendered (${JSON.stringify(zoomedBitmap)})`
    );

    const reset = page.getByTitle("Reset");
    await reset.click();
    await page.waitForTimeout(350);
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForGangSheetFit(page);
    const mobileFit = await canvasMetrics(page);
    assertGangSheetBacking(mobileFit, "mobile fit");
    assert.ok(
      mobileFit.logicalHeight >= 220,
      `mobile fit: preview height floor was not applied (${JSON.stringify(mobileFit)})`
    );
    assert.equal(
      mobileFit.cssLayoutWidth,
      mobileFit.cssWidth,
      "mobile fit: CSS canvas width changed unexpectedly"
    );
    await page.screenshot({
      path: `${artifactDir}/gangsheet-preview-resolution-browser-mobile.png`,
      fullPage: true,
    });

    await page.getByRole("button", { name: "Back to Designer", exact: true }).click();
    await page.getByRole("button", { name: "Add to Gang Sheet", exact: true }).waitFor({
      state: "visible",
      timeout: 30000,
    });
    await page.waitForTimeout(350);
    const designer = await canvasMetrics(page);
    assert.ok(
      designer.backingWidth <= designer.logicalWidth * 1.1 &&
        designer.backingHeight <= designer.logicalHeight * 1.1,
      `back to designer: normal backing sizing was not restored (${JSON.stringify(designer)})`
    );
    assert.ok(
      designer.backingWidth < mobileFit.backingWidth &&
        designer.backingHeight < mobileFit.backingHeight,
      `back to designer: normal backing did not shrink from gang-sheet quality (${JSON.stringify({
        designer,
        gangSheet: mobileFit,
      })})`
    );
    await page.screenshot({
      path: `${artifactDir}/gangsheet-preview-resolution-browser-designer.png`,
      fullPage: true,
    });

    assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join("; ")}`);
    console.log(
      "Gang sheet preview resolution passed: measured desktop/mobile 2x fit backing, debounced wheel zoom backing increase, stable CSS layout, detailed bitmap, and designer restore."
    );
    console.log(
      `Fit metrics: desktop ${desktopFit.backingWidth}x${desktopFit.backingHeight} (CSS ${desktopFit.cssLayoutWidth}x${desktopFit.cssLayoutHeight}); mobile ${mobileFit.backingWidth}x${mobileFit.backingHeight} (CSS ${mobileFit.cssLayoutWidth}x${mobileFit.cssLayoutHeight}); zoomed ${desktopZoomed.backingWidth}x${desktopZoomed.backingHeight}; designer ${designer.backingWidth}x${designer.backingHeight}.`
    );
    console.log(
      `Screenshots: ${artifactDir}/gangsheet-preview-resolution-browser-desktop.png, ${artifactDir}/gangsheet-preview-resolution-browser-mobile.png, ${artifactDir}/gangsheet-preview-resolution-browser-designer.png`
    );
  } finally {
    await page.close();
  }
} finally {
  await browser.close();
}