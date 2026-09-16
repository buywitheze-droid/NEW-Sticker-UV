// Run against a running dev server:
// PLAYWRIGHT_MODULE=/mnt/pid2/node_modules/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium \
// node tests/gangsheet-layers-scroll-browser.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const devDomain = process.env.REPLIT_DEV_DOMAIN;
const baseURL = process.env.TEST_BASE_URL || (devDomain ? `https://${devDomain}` : null);
if (!baseURL) {
  throw new Error("REPLIT_DEV_DOMAIN (or TEST_BASE_URL) is required");
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.CHROMIUM_EXECUTABLE }
    : {}),
  args: ["--no-sandbox"],
});

const artifactDir = "tests/artifacts";
await mkdir(artifactDir, { recursive: true });

function makeDesign(index) {
  const canvas = createCanvas(240, 180);
  const ctx = canvas.getContext("2d");
  const hue = (index * 31) % 360;
  ctx.fillStyle = `hsl(${hue} 75% 48%)`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 52px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(index + 1), canvas.width / 2, canvas.height / 2);
  return {
    name: `gangsheet-scroll-design-${String(index + 1).padStart(2, "0")}.png`,
    mimeType: "image/png",
    buffer: canvas.toBuffer("image/png"),
  };
}

const designs = Array.from({ length: 12 }, (_, index) => makeDesign(index));

async function waitForGangCount(page, count) {
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll("button")].some((button) => {
        if (!button.textContent?.includes("View Gangsheet")) return false;
        // The two count spans are adjacent in the accessible text because
        // their Tailwind classes do not add whitespace. Read the first span
        // directly instead of accidentally parsing "1" + "1 total" as 11.
        return button.querySelector("span")?.textContent?.trim() === String(expected);
      }),
    count,
    { timeout: 90000 }
  );
}

async function waitForVisibleRegion(page) {
  const region = page.getByRole("region", { name: "Gang sheet layers" });
  await region.waitFor({ state: "visible", timeout: 30000 });
  await page.waitForFunction(
    () => {
      const element = document.querySelector('[role="region"][aria-label="Gang sheet layers"]');
      return element && element.querySelectorAll('img[alt="sticker"]').length > 0;
    },
    undefined,
    { timeout: 30000 }
  );
  return region;
}

async function regionMetrics(region) {
  return region.evaluate((element) => {
    const rows = [...element.querySelectorAll('img[alt="sticker"]')].map((image) => {
      const rect = image.parentElement?.getBoundingClientRect();
      return rect
        ? { top: rect.top, bottom: rect.bottom, height: rect.height }
        : null;
    });
    const rect = element.getBoundingClientRect();
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      viewportTop: rect.top,
      viewportBottom: rect.bottom,
      rows,
      active: document.activeElement === element,
    };
  });
}

function assertScrollable(metrics, name) {
  assert.ok(
    metrics.scrollHeight > metrics.clientHeight + 1,
    `${name}: layer region did not overflow (${JSON.stringify(metrics)})`
  );
}

function assertLastRowReachable(metrics, name) {
  const lastRow = metrics.rows.at(-1);
  assert.ok(lastRow, `${name}: last layer row was not rendered`);
  assert.ok(
    lastRow.top >= metrics.viewportTop - 1 &&
      lastRow.bottom <= metrics.viewportBottom + 1,
    `${name}: last layer row is not visible after scrolling (${JSON.stringify({
      lastRow,
      viewportTop: metrics.viewportTop,
      viewportBottom: metrics.viewportBottom,
      scrollTop: metrics.scrollTop,
    })})`
  );
}

async function uploadAndAdd(page, file, expectedCount, firstUpload = false) {
  const input = firstUpload
    ? page.locator('input[type="file"]').first()
    : page.locator("#spot-uv-change-design-input");
  await input.setInputFiles(file);
  await page.waitForFunction(
    (fileName) => {
      const element = document.querySelector("#spot-uv-change-design-input") ||
        document.querySelector('input[type="file"]');
      return element?.value.endsWith(fileName);
    },
    file.name,
    { timeout: 30000 }
  );
  // Upload preparation is asynchronous (it measures/crops the image before
  // replacing imageInfo). Small fixtures settle quickly, but leave enough
  // time for that state transition before invoking the add action.
  await page.waitForTimeout(500);
  const add = page.getByRole("button", { name: "Add to Gang Sheet", exact: true });
  await add.waitFor({ state: "visible", timeout: 30000 });
  await add.click();
  await waitForGangCount(page, expectedCount);
}

async function testDesktopAndMobile(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await page.getByText("Upload your Design", { exact: true }).waitFor({
    state: "visible",
    timeout: 30000,
  });

  await uploadAndAdd(page, designs[0], 1, true);
  for (let index = 1; index < designs.length; index += 1) {
    await uploadAndAdd(page, designs[index], index + 1);
  }

  await page.getByRole("button", { name: /View Gangsheet/ }).click();
  const region = await waitForVisibleRegion(page);
  assert.equal(
    await region.locator('img[alt="sticker"]').count(),
    designs.length,
    "desktop: expected all generated designs in the layer list"
  );

  await region.evaluate((element) => {
    element.scrollTop = 0;
  });
  const desktopAtTop = await regionMetrics(region);
  assertScrollable(desktopAtTop, "desktop");
  assert.equal(
    desktopAtTop.scrollTop,
    0,
    "desktop: region should start at the top"
  );

  await region.focus();
  assert.equal(
    (await regionMetrics(region)).active,
    true,
    "desktop: layer region did not receive focus"
  );
  // Chrome's focused-element default for PageDown is affected by the app's
  // page-level key bindings. ArrowDown is the native keyboard affordance for
  // this focused overflow region and remains deterministic here.
  for (let press = 0; press < 8; press += 1) {
    await page.keyboard.press("ArrowDown");
  }
  const desktopAfterKeyboard = await regionMetrics(region);
  assert.ok(
    desktopAfterKeyboard.scrollTop > desktopAtTop.scrollTop,
    `desktop: keyboard ArrowDown did not scroll the focused region (${JSON.stringify({
      before: desktopAtTop.scrollTop,
      after: desktopAfterKeyboard.scrollTop,
    })})`
  );

  await region.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const desktopAtBottom = await regionMetrics(region);
  assertScrollable(desktopAtBottom, "desktop");
  assertLastRowReachable(desktopAtBottom, "desktop");
  await page.screenshot({
    path: `${artifactDir}/gangsheet-layers-scroll-browser-desktop.png`,
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await region.evaluate((element) => {
    element.scrollTop = 0;
  });
  const mobileAtTop = await regionMetrics(region);
  assertScrollable(mobileAtTop, "mobile");
  await region.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const mobileAtBottom = await regionMetrics(region);
  assert.ok(
    mobileAtBottom.scrollTop > mobileAtTop.scrollTop,
    `mobile: native region scrollTop did not change (${JSON.stringify({
      before: mobileAtTop.scrollTop,
      after: mobileAtBottom.scrollTop,
    })})`
  );
  assertLastRowReachable(mobileAtBottom, "mobile");
  await page.screenshot({
    path: `${artifactDir}/gangsheet-layers-scroll-browser-mobile.png`,
    fullPage: true,
  });

  // Exercise controls on the row that is only reachable after scrolling.
  let lastRow = region.locator('img[alt="sticker"]').last().locator("xpath=..");
  const quantity = lastRow.locator('input[type="number"]');
  assert.equal(await quantity.inputValue(), "1", "last design starts at quantity 1");
  await lastRow.getByRole("button", { name: "+", exact: true }).click();
  await page.waitForFunction(
    () => {
      const rows = document
        .querySelector('[role="region"][aria-label="Gang sheet layers"]')
        ?.querySelectorAll('input[type="number"]');
      return rows?.length === 12 && rows[rows.length - 1]?.value === "2";
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(
    await quantity.inputValue(),
    "2",
    "last design quantity increment did not work"
  );
  await lastRow.getByTitle("Remove").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="region"][aria-label="Gang sheet layers"]')
        ?.querySelectorAll('img[alt="sticker"]').length === 11,
    undefined,
    { timeout: 30000 }
  );
  assert.equal(
    await region.locator('img[alt="sticker"]').count(),
    11,
    "last design remove did not update the layer list"
  );

  // A short list must size to its content rather than retaining the overflow
  // viewport height that is used only when the list actually needs scrolling.
  while (await region.locator('img[alt="sticker"]').count() > 1) {
    const beforeCount = await region.locator('img[alt="sticker"]').count();
    lastRow = region.locator('img[alt="sticker"]').last().locator("xpath=..");
    await lastRow.getByTitle("Remove").click();
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector('[role="region"][aria-label="Gang sheet layers"]')
          ?.querySelectorAll('img[alt="sticker"]').length === expected,
      beforeCount - 1,
      { timeout: 30000 }
    );
  }
  const shortList = await regionMetrics(region);
  assert.ok(
    shortList.scrollHeight <= shortList.clientHeight + 1,
    `short list: artificial overflow area remains (${JSON.stringify(shortList)})`
  );
  assert.ok(
    shortList.clientHeight < 0.52 * 844,
    `short list: region retained the capped tall viewport (${JSON.stringify(shortList)})`
  );

  assert.deepEqual(errors, [], `browser page errors: ${errors.join("; ")}`);
}

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  try {
    await testDesktopAndMobile(page);
  } finally {
    await page.close();
  }
  console.log(
    "Gang sheet layer scrolling passed: desktop + mobile native scrolling, keyboard scrolling, last-row quantity/remove, and short-list sizing."
  );
  console.log(
    `Screenshots: ${artifactDir}/gangsheet-layers-scroll-browser-desktop.png, ${artifactDir}/gangsheet-layers-scroll-browser-mobile.png`
  );
} finally {
  await browser.close();
}