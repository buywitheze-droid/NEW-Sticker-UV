// Run against a running dev server:
// PLAYWRIGHT_MODULE=/mnt/pid2/node_modules/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium \
// TEST_BASE_URL=http://127.0.0.1:5000 \
//   node tests/auto-spot-layers-browser.mjs
//
// This is an end-to-end test of the real spot-layer extraction, preview, and
// apply path. It deliberately does not mock a worker, API response, canvas
// result, or separation export. The fixture assumptions are intentionally
// narrow: the root route is the individual Spot UV editor, and its existing
// spot names are RDG_WHITE and RDG_GLOSS.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";

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

const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ["--no-sandbox"],
});

function makeBlackWhiteFixture() {
  const canvas = createCanvas(360, 240);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  context.fillRect(22, 22, 105, 78);
  context.fillRect(233, 22, 105, 78);
  context.beginPath();
  context.arc(90, 174, 45, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.arc(270, 174, 45, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ffffff";
  context.fillRect(49, 49, 51, 24);
  context.fillRect(260, 49, 51, 24);
  context.strokeStyle = "#000000";
  context.lineWidth = 5;
  context.beginPath();
  context.moveTo(145, 22);
  context.lineTo(215, 100);
  context.moveTo(215, 22);
  context.lineTo(145, 100);
  context.stroke();
  return {
    name: "auto-spot-black-white.png",
    mimeType: "image/png",
    buffer: canvas.toBuffer("image/png"),
  };
}

function makeGrayscaleFixture() {
  const canvas = createCanvas(360, 240);
  const context = canvas.getContext("2d");
  const background = context.createLinearGradient(0, 0, canvas.width, 0);
  background.addColorStop(0, "#101010");
  background.addColorStop(0.5, "#858585");
  background.addColorStop(1, "#f6f6f6");
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const panel = context.createLinearGradient(0, 0, 0, canvas.height);
  panel.addColorStop(0, "#eeeeee");
  panel.addColorStop(1, "#333333");
  context.fillStyle = panel;
  context.fillRect(40, 30, 108, 180);
  context.fillStyle = "#1e1e1e";
  context.fillRect(62, 52, 64, 54);
  context.fillStyle = "#d8d8d8";
  context.beginPath();
  context.arc(95, 164, 33, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#fafafa";
  context.fillRect(206, 32, 112, 176);
  context.fillStyle = "#494949";
  for (let index = 0; index < 7; index += 1) {
    context.fillRect(218 + index * 13, 50 + index * 12, 8, 110 - index * 10);
  }
  context.strokeStyle = "#111111";
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(192, 12);
  context.lineTo(192, 228);
  context.stroke();
  return {
    name: "auto-spot-grayscale.png",
    mimeType: "image/png",
    buffer: canvas.toBuffer("image/png"),
  };
}

function makeRichColorDetailFixture() {
  const canvas = createCanvas(360, 240);
  const context = canvas.getContext("2d");
  context.fillStyle = "#172a46";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const sky = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  sky.addColorStop(0, "#18a8c4");
  sky.addColorStop(0.45, "#3554d1");
  sky.addColorStop(1, "#7b1fa2");
  context.fillStyle = sky;
  context.fillRect(18, 18, 324, 204);

  context.fillStyle = "#f7d038";
  context.beginPath();
  context.arc(80, 72, 39, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ed3b64";
  context.fillRect(132, 37, 78, 68);
  context.fillStyle = "#21d18a";
  context.beginPath();
  context.moveTo(252, 35);
  context.lineTo(320, 72);
  context.lineTo(254, 112);
  context.closePath();
  context.fill();

  context.fillStyle = "#111827";
  context.fillRect(32, 132, 105, 66);
  context.fillStyle = "#f9fafb";
  context.fillRect(46, 146, 77, 8);
  context.fillRect(46, 165, 57, 8);
  context.fillStyle = "#ff7a18";
  context.beginPath();
  context.arc(182, 164, 40, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#26124d";
  context.beginPath();
  context.arc(182, 164, 19, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#31c6ed";
  context.fillRect(236, 139, 82, 63);
  context.fillStyle = "#ff3ca6";
  for (let index = 0; index < 6; index += 1) {
    context.fillRect(244 + index * 12, 148 + (index % 2) * 18, 7, 38);
  }
  context.strokeStyle = "#ffffff";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(18, 118);
  context.lineTo(342, 118);
  context.moveTo(146, 18);
  context.lineTo(146, 222);
  context.stroke();
  return {
    name: "auto-spot-rich-color-detail.png",
    mimeType: "image/png",
    buffer: canvas.toBuffer("image/png"),
  };
}

const fixtures = {
  blackWhite: makeBlackWhiteFixture(),
  grayscale: makeGrayscaleFixture(),
  rich: makeRichColorDetailFixture(),
};

async function waitForMeaningfulExtraction(page) {
  // A worker can briefly render old cards while the replacement image is
  // being prepared. Do not sample that transient frame.
  await page.waitForFunction(
    () => {
      const detecting = [...document.querySelectorAll("body *")].some(
        element => element.textContent?.trim() === "Detecting colors…",
      );
      return !detecting && document.querySelectorAll("[data-color-index]").length > 0;
    },
    undefined,
    { timeout: 60_000 },
  );
  // Extraction and region enrichment are separate meaningful state updates.
  await page.waitForTimeout(300);
}

async function openManualSpotPanel(page) {
  const spotButton = page.getByRole("button", {
    name: "Spot White and Gloss",
    exact: true,
  });
  await spotButton.waitFor({ state: "visible", timeout: 30_000 });
  const firstCard = page.locator("[data-color-index]").first();
  if (!(await firstCard.isVisible().catch(() => false))) {
    await spotButton.click();
  }
  await waitForMeaningfulExtraction(page);
  await firstCard.waitFor({ state: "visible", timeout: 30_000 });
  return firstCard;
}

async function closeManualSpotPanel(page) {
  const spotButton = page.getByRole("button", {
    name: "Spot White and Gloss",
    exact: true,
  });
  const firstCard = page.locator("[data-color-index]").first();
  if (await firstCard.isVisible().catch(() => false)) {
    await spotButton.click();
    await firstCard.waitFor({ state: "hidden", timeout: 10_000 });
  }
}

async function uploadFixture(page, fixture, initial = false) {
  // Force the next extraction to be observed from its own open panel. If the
  // old palette stayed mounted, a stale card could satisfy the settled-state
  // check before the replacement worker has delivered its map.
  if (!initial) await closeManualSpotPanel(page);
  const input = initial
    ? page.locator('input[type="file"]').first()
    : page.locator("#spot-uv-change-design-input");
  await input.waitFor({ state: "attached", timeout: 30_000 });
  await input.setInputFiles(fixture);
  await page.waitForFunction(
    name => [...document.querySelectorAll('input[type="file"]')]
      .some(element => element.files?.[0]?.name === name),
    fixture.name,
    { timeout: 30_000 },
  );
  // Raster preparation and the image element update precede colour-map
  // extraction. Give that real state transition time to begin before opening
  // the panel whose "Detecting colors…" status we use below.
  if (!initial) await page.waitForTimeout(500);
  await page.getByRole("button", {
    name: "Spot White and Gloss",
    exact: true,
  }).waitFor({ state: "visible", timeout: 30_000 });
  const firstCard = await openManualSpotPanel(page);
  assert.ok(
    await firstCard.isVisible(),
    `fixture assumption failed: ${fixture.name} did not produce an editable extracted color`,
  );
  return firstCard;
}

async function ensureChannelSelected(page, card, channel, selected) {
  const remove = card.locator(`button[title^="Remove ${channel} from all shapes"]`);
  const apply = card.locator(`button[title^="Apply ${channel} to all shapes"]`);
  let isSelected = await remove.count() > 0;

  if (selected && !isSelected) {
    // The bulk control handles palettes whose first colour has multiple
    // enriched regions and therefore has a mixed card-level state.
    await page.getByRole("button", { name: `All ${channel}`, exact: true }).first().click();
    await remove.waitFor({ state: "attached", timeout: 10_000 });
    isSelected = true;
  } else if (!selected && isSelected) {
    await remove.first().click();
    await apply.waitFor({ state: "attached", timeout: 10_000 });
    isSelected = false;
  }

  assert.equal(
    isSelected,
    selected,
    `manual ${channel} selection did not reach the requested state`,
  );
}

async function cardFlags(card) {
  return {
    white: await card.locator('button[title^="Remove White from all shapes"]').count() > 0,
    gloss: await card.locator('button[title^="Remove Gloss from all shapes"]').count() > 0,
  };
}

function autoPanelFromButton(page) {
  const button = page.getByRole("button", { name: "Auto Spot Layers", exact: true });
  return { button, panel: button.locator("xpath=..") };
}

async function openAutoPanel(page) {
  const { button, panel } = autoPanelFromButton(page);
  await button.waitFor({ state: "visible", timeout: 30_000 });
  const expanded = await button.getAttribute("aria-expanded");
  if (expanded !== "true") await button.click();
  await panel.getByRole("combobox", { name: "White underbase" }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  return { button, panel };
}

async function setAutoSettings(panel, {
  white = "solid",
  gloss = "relief",
  whiteThreshold,
  glossThreshold,
  regionCoverage,
} = {}) {
  await panel.getByRole("combobox", { name: "White underbase" }).selectOption(white);
  await panel.getByRole("combobox", { name: "Gloss finish" }).selectOption(gloss);
  if (whiteThreshold !== undefined) {
    await panel.getByLabel("White threshold").fill(String(whiteThreshold));
  }
  if (glossThreshold !== undefined) {
    await panel.getByLabel("Gloss threshold").fill(String(glossThreshold));
  }
  if (regionCoverage !== undefined) {
    await panel.getByLabel("Region coverage").fill(String(regionCoverage));
  }
}

async function waitForPreviewCleared(panel) {
  await panel.locator('img[alt="White solid spot selection"]').waitFor({
    state: "hidden",
    timeout: 10_000,
  });
  assert.equal(
    await panel.getByRole("button", { name: "Apply selections", exact: true }).count(),
    0,
    "stale Apply selections remained after an input changed",
  );
}

async function readBinaryMask(page, imageLocator, label, requireSelected = true) {
  const src = await imageLocator.getAttribute("src");
  assert.ok(src?.startsWith("data:image/png"), `${label}: preview is not a PNG data URL`);
  const result = await page.evaluate(async source => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not read generated mask preview");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const values = new Set();
    let nonBinary = 0;
    let nonOpaque = 0;
    let whitePixels = 0;
    let blackPixels = 0;
    let hash = 2166136261;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const alpha = pixels[index + 3];
      values.add(red);
      if (red !== 0 && red !== 255) nonBinary += 1;
      if (red !== green || red !== blue) nonBinary += 1;
      if (alpha !== 255) nonOpaque += 1;
      if (red === 255) whitePixels += 1;
      if (red === 0) blackPixels += 1;
      hash ^= red;
      hash = Math.imul(hash, 16777619);
    }
    return {
      width: canvas.width,
      height: canvas.height,
      values: [...values],
      nonBinary,
      nonOpaque,
      whitePixels,
      blackPixels,
      fingerprint: hash >>> 0,
    };
  }, src);
  assert.ok(result.width > 0 && result.height > 0, `${label}: mask has no dimensions`);
  assert.deepEqual(
    result.values.sort((left, right) => left - right),
    result.values.filter(value => value === 0 || value === 255).sort((left, right) => left - right),
    `${label}: mask contains non-binary channel values`,
  );
  assert.equal(result.nonBinary, 0, `${label}: mask RGB values are not a solid binary mask`);
  assert.equal(result.nonOpaque, 0, `${label}: mask contains transparent pixels`);
  if (requireSelected) {
    assert.ok(result.whitePixels > 0, `${label}: mask contains no selected pixels`);
  }
  return { ...result, src };
}

async function generatePreview(page, panel, label) {
  const generate = panel.getByRole("button", {
    name: "Generate preview",
    exact: true,
  });
  await generate.waitFor({ state: "visible", timeout: 30_000 });
  await generate.click();
  // The panel uses requestAnimationFrame for work scheduling. Wait for both
  // actual mask images, rather than sleeping through the transient spinner.
  const whiteImage = panel.locator('img[alt="White solid spot selection"]');
  const glossImage = panel.locator('img[alt="Gloss solid spot selection"]');
  await whiteImage.waitFor({ state: "visible", timeout: 30_000 });
  await glossImage.waitFor({ state: "visible", timeout: 30_000 });
  await panel.getByRole("button", { name: "Apply selections", exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  // Empty masks are valid for Clear, Keep-current-empty, and strict thresholds.
  // Scenario-specific assertions below check the expected coverage.
  const white = await readBinaryMask(page, whiteImage, `${label} White`, false);
  const gloss = await readBinaryMask(page, glossImage, `${label} Gloss`, false);
  return { white, gloss };
}

async function applyPreview(page, panel, label) {
  const apply = panel.getByRole("button", { name: "Apply selections", exact: true });
  await apply.click();
  // onApply may synchronously cause the panel's ephemeral "applied" message
  // to disappear when extraction state refreshes. Assert durable separation
  // state instead of waiting for that message.
  const card = page.locator("[data-color-index]").first();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  assert.ok(await card.isVisible(), `${label}: manual spot panel did not open after Apply`);
  return card;
}

async function downloadPrintPdf(page, label) {
  const pdfButton = page.getByRole("button", { name: "Download PDF", exact: true }).first();
  assert.equal(await pdfButton.count(), 1, `${label}: Download PDF action is missing`);
  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await pdfButton.click();
  const yes = page.getByRole("button", { name: "Yes", exact: true });
  if (await yes.count() && await yes.first().isVisible().catch(() => false)) {
    await yes.first().click();
  }
  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path, `${label}: Playwright did not expose the downloaded PDF path`);
  const bytes = await fs.readFile(path);
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "%PDF", `${label}: not a PDF`);
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPages().length > 0, `${label}: PDF has no pages`);
  const metadata = [
    pdf.getTitle?.() || "",
    pdf.getSubject?.() || "",
    pdf.getKeywords?.() || "",
    bytes.toString("latin1"),
  ].join(" ");
  assert.match(metadata, /RDG_WHITE/, `${label}: existing White separation name changed`);
  assert.match(metadata, /RDG_GLOSS/, `${label}: existing Gloss separation name changed`);
  return bytes;
}

async function assertMobileBounds(page, panel) {
  const viewport = page.viewportSize();
  assert.ok(viewport, "mobile: Playwright viewport is unavailable");
  const controls = [
    ["Auto Spot Layers", page.getByRole("button", { name: "Auto Spot Layers", exact: true })],
    ["White underbase", panel.getByRole("combobox", { name: "White underbase" })],
    ["Gloss finish", panel.getByRole("combobox", { name: "Gloss finish" })],
    ["White threshold", panel.getByLabel("White threshold")],
    ["Gloss threshold", panel.getByLabel("Gloss threshold")],
    ["Region coverage", panel.getByLabel("Region coverage")],
    ["Generate preview", panel.getByRole("button", { name: "Generate preview", exact: true })],
    ["Apply selections", panel.getByRole("button", { name: "Apply selections", exact: true })],
  ];
  for (const [label, locator] of controls) {
    await locator.scrollIntoViewIfNeeded();
    const bounds = await locator.boundingBox();
    assert.ok(bounds, `mobile: ${label} has no bounds`);
    assert.ok(
      bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1,
      `mobile: ${label} is clipped horizontally: ${JSON.stringify(bounds)}`,
    );
    assert.ok(
      bounds.width > 0 && bounds.height > 0,
      `mobile: ${label} has empty bounds: ${JSON.stringify(bounds)}`,
    );
  }
}

async function run() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  try {
    await page.goto(baseURL, { waitUntil: "domcontentloaded" });
    await page.getByText("Upload your Design", { exact: true }).waitFor({
      state: "visible",
      timeout: 30_000,
    });

    // Rich colour artwork exercises both local-contrast Details and
    // luminance-based Highlights, while keeping the generated masks authentic.
    let card = await uploadFixture(page, fixtures.rich, true);
    let { panel: autoPanel } = await openAutoPanel(page);
    await setAutoSettings(autoPanel, {
      white: "solid",
      gloss: "detail",
      glossThreshold: 0.28,
      regionCoverage: 0.12,
    });

    // Existing manual flags are intentionally selected before generation.
    // Preview is read-only until Apply, so these flags must not change.
    await ensureChannelSelected(page, card, "White", true);
    await ensureChannelSelected(page, card, "Gloss", true);
    const flagsBeforePreview = await cardFlags(card);
    assert.deepEqual(flagsBeforePreview, { white: true, gloss: true });
    const detailPreview = await generatePreview(page, autoPanel, "rich Details");
    assert.deepEqual(
      await cardFlags(card),
      flagsBeforePreview,
      "preview-only generation changed existing manual White/Gloss selections",
    );
    // Make the post-Apply open assertion meaningful: the manual panel is
    // closed while the remaining previews are generated.
    await closeManualSpotPanel(page);

    await setAutoSettings(autoPanel, {
      white: "solid",
      gloss: "highlights",
      glossThreshold: 0.8,
      regionCoverage: 0.12,
    });
    const highlightsPreview = await generatePreview(page, autoPanel, "rich Highlights");
    assert.notEqual(
      detailPreview.gloss.fingerprint,
      highlightsPreview.gloss.fingerprint,
      "rich fixture Details and Highlights previews did not differ",
    );

    // Change a setting while a preview exists: the old Apply action must be
    // removed. Regenerate with a low relief threshold before applying so both
    // existing channels have a deterministic selected domain.
    await setAutoSettings(autoPanel, {
      white: "solid",
      gloss: "relief",
      whiteThreshold: 0.44,
      glossThreshold: 0.05,
      regionCoverage: 0.12,
    });
    await waitForPreviewCleared(autoPanel);
    await setAutoSettings(autoPanel, {
      white: "solid",
      gloss: "relief",
      whiteThreshold: 0.44,
      glossThreshold: 0.05,
      regionCoverage: 0.12,
    });
    await generatePreview(page, autoPanel, "rich apply preview");
    card = await applyPreview(page, autoPanel, "rich apply");
    await ensureChannelSelected(page, card, "White", true);
    await ensureChannelSelected(page, card, "Gloss", true);
    await downloadPrintPdf(page, "rich applied spot names");

    // Keep White while clearing Gloss. Explicitly use the Auto panel's Clear
    // action once as well, then regenerate and apply durable selections.
    await ensureChannelSelected(page, card, "Gloss", false);
    await ensureChannelSelected(page, card, "White", true);
    await setAutoSettings(autoPanel, { white: "keep", gloss: "clear" });
    await generatePreview(page, autoPanel, "keep White clear Gloss");
    const keepClearPreview = await readBinaryMask(
      page,
      autoPanel.locator('img[alt="White solid spot selection"]'),
      "keep White clear Gloss White",
    );
    const clearedGlossPreview = await readBinaryMask(
      page,
      autoPanel.locator('img[alt="Gloss solid spot selection"]'),
      "keep White clear Gloss Gloss",
      false,
    );
    assert.ok(keepClearPreview.whitePixels > 0, "Keep White unexpectedly produced an empty mask");
    assert.equal(clearedGlossPreview.whitePixels, 0, "Clear Gloss produced ink in its mask");
    await autoPanel.getByRole("button", { name: "Clear", exact: true }).click();
    await waitForPreviewCleared(autoPanel);

    await generatePreview(page, autoPanel, "keep White clear Gloss regenerated");
    card = await applyPreview(page, autoPanel, "keep White clear Gloss apply");
    assert.deepEqual(await cardFlags(card), { white: true, gloss: false });

    // Manual controls still own the final state after an auto apply.
    await ensureChannelSelected(page, card, "White", false);
    assert.equal((await cardFlags(card)).white, false, "manual White toggle after Apply did not clear");
    await ensureChannelSelected(page, card, "White", true);
    assert.equal((await cardFlags(card)).white, true, "manual White toggle after Apply did not restore");

    // A replacement image must invalidate an already generated preview.
    await setAutoSettings(autoPanel, { white: "solid", gloss: "highlights", glossThreshold: 0.5 });
    await generatePreview(page, autoPanel, "rich replacement sentinel");
    await uploadFixture(page, fixtures.grayscale);
    await waitForPreviewCleared(autoPanel);

    // Grayscale and black/white are real uploaded fixtures, not synthetic
    // browser results. Both still produce valid binary output masks.
    await setAutoSettings(autoPanel, {
      white: "solid",
      gloss: "detail",
      glossThreshold: 0.18,
      regionCoverage: 0.12,
    });
    await generatePreview(page, autoPanel, "grayscale Detail");

    await uploadFixture(page, fixtures.blackWhite);
    await waitForPreviewCleared(autoPanel);
    await setAutoSettings(autoPanel, {
      white: "solid",
      gloss: "highlights",
      glossThreshold: 0.45,
      regionCoverage: 0.12,
    });
    await generatePreview(page, autoPanel, "black-white Highlights");

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: "/tmp/auto-spot-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 320, height: 900 });
    await assertMobileBounds(page, autoPanel);
    await page.screenshot({ path: "/tmp/auto-spot-mobile.png", fullPage: true });

    assert.deepEqual(
      pageErrors,
      [],
      `browser page errors indicate an application bug: ${pageErrors.join("; ")}`,
    );
    console.log("auto-spot-layers-browser: PASS");
  } finally {
    await page.close();
    await browser.close();
  }
}

try {
  await run();
} catch (error) {
  console.error(
    "auto-spot-layers-browser: FAIL",
  );
  console.error(error);
  process.exitCode = 1;
}