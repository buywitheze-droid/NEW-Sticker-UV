// Run against a running dev server (the parent agent should restart it first):
// PLAYWRIGHT_MODULE=/mnt/pid2/node_modules/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium \
// TEST_BASE_URL=http://127.0.0.1:5000 node tests/spot-names-browser.mjs
//
// Exercises the real Spot UV editor entry path. No extraction, export, or API
// behavior is mocked; the generated image merely gives the existing extractor
// a deterministic pair of color regions to select.
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "/mnt/pid2/node_modules/playwright/index.mjs",
);
const executablePath = process.env.CHROMIUM_EXECUTABLE ||
  "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";
const baseURL = process.env.TEST_BASE_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`;
assert.ok(process.env.REPLIT_DEV_DOMAIN || process.env.TEST_BASE_URL,
  "Set REPLIT_DEV_DOMAIN or TEST_BASE_URL before running this browser test");

const canvas = createCanvas(320, 220);
const context = canvas.getContext("2d");
context.fillStyle = "#ffffff";
context.fillRect(0, 0, 320, 220);
context.fillStyle = "#111111";
context.fillRect(28, 28, 110, 80);
context.fillStyle = "#e31b23";
context.fillRect(182, 28, 110, 80);
context.fillStyle = "#111111";
context.beginPath();
context.arc(90, 165, 38, 0, Math.PI * 2);
context.fill();
context.fillStyle = "#e31b23";
context.beginPath();
context.arc(230, 165, 38, 0, Math.PI * 2);
context.fill();
const fixture = {
  name: "spot-names-browser.png",
  mimeType: "image/png",
  buffer: canvas.toBuffer("image/png"),
};

const browser = await chromium.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));

try {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="file"]').first().setInputFiles(fixture);
  const spotButton = page.getByRole("button", { name: "Spot White and Gloss", exact: true });
  await spotButton.waitFor({ state: "visible", timeout: 30_000 });
  await spotButton.click();
  const card = page.locator("[data-color-index]").first();
  await card.waitFor({ state: "visible", timeout: 30_000 });

  // Select both real spot channels so the editable separation-name row mounts.
  const whiteButton = card.locator('button[title^="Apply White"]').first();
  const glossButton = card.locator('button[title^="Apply Gloss"]').first();
  if (await whiteButton.count()) await whiteButton.click();
  if (await glossButton.count()) await glossButton.click();

  const cutName = page.getByLabel("CutContour spot name");
  await cutName.fill("KnifeLine");
  await cutName.press("Enter");
  assert.equal(await cutName.inputValue(), "KnifeLine", "custom CutContour name did not commit");
  await page.waitForTimeout(900);
  const undo = page.getByTitle("Undo").last();
  const redo = page.getByTitle("Redo").last();
  await undo.waitFor({ state: "visible", timeout: 10_000 });
  if (await undo.isEnabled()) {
    await undo.click();
    await page.waitForTimeout(250);
    assert.equal(await cutName.inputValue(), "CutContour", "Undo did not restore CutContour name");
    await redo.click();
    await page.waitForTimeout(250);
    assert.equal(await cutName.inputValue(), "KnifeLine", "Redo did not restore custom CutContour name");
  }
  await cutName.fill("Canceled");
  await cutName.press("Escape");
  assert.equal(await cutName.inputValue(), "KnifeLine", "Escape changed CutContour name");
  await cutName.fill("   ");
  await cutName.press("Enter");
  assert.equal(await cutName.inputValue(), "KnifeLine", "blank CutContour name was accepted");

  const whiteDisplay = page.getByText("RDG_WHITE", { exact: true }).last();
  await whiteDisplay.locator("xpath=..").getByTitle("Edit White spot name").click();
  const whiteInput = page.getByLabel("White spot name");
  await whiteInput.fill("Underbase");
  await whiteInput.press("Enter");
  assert.equal(await page.getByText("Underbase", { exact: true }).count(), 1,
    "custom White name did not render after commit");
  const whiteEdited = page.getByText("Underbase", { exact: true }).last();
  await whiteEdited.locator("xpath=..").getByTitle("Edit White spot name").click();
  await page.getByLabel("White spot name").fill("   ");
  await page.getByLabel("White spot name").press("Enter");
  assert.equal(await page.getByText("Underbase", { exact: true }).count(), 1,
    "blank White name was accepted");
  const whiteCollision = page.getByText("Underbase", { exact: true }).last();
  await whiteCollision.locator("xpath=..").getByTitle("Edit White spot name").click();
  await page.getByLabel("White spot name").fill("RDG_GLOSS");
  await page.getByLabel("White spot name").press("Enter");
  assert.equal(await page.getByText("Underbase", { exact: true }).count(), 1,
    "White/Varnish duplicate was accepted");

  const glossDisplay = page.getByText("RDG_GLOSS", { exact: true }).last();
  await glossDisplay.locator("xpath=..").getByTitle("Edit Varnish (Gloss) spot name").click();
  const glossInput = page.getByLabel("Varnish (Gloss) spot name");
  await glossInput.fill("Varnish");
  await glossInput.press("Enter");
  assert.equal(await page.getByText("Varnish", { exact: true }).count(), 1,
    "custom Varnish name did not render after commit");
  const glossEdited = page.getByText("Varnish", { exact: true }).last();
  await glossEdited.locator("xpath=..").getByTitle("Edit Varnish (Gloss) spot name").click();
  await page.getByLabel("Varnish (Gloss) spot name").fill("   ");
  await page.getByLabel("Varnish (Gloss) spot name").press("Enter");
  assert.equal(await page.getByText("Varnish", { exact: true }).count(), 1,
    "blank Varnish name was accepted");
  const glossCollision = page.getByText("Varnish", { exact: true }).last();
  await glossCollision.locator("xpath=..").getByTitle("Edit Varnish (Gloss) spot name").click();
  await page.getByLabel("Varnish (Gloss) spot name").fill("Underbase");
  await page.getByLabel("Varnish (Gloss) spot name").press("Enter");
  assert.equal(await page.getByText("Varnish", { exact: true }).count(), 1,
    "Varnish/White duplicate was accepted");

  // Duplicate names are rejected on commit and leave the previous valid value.
  await cutName.fill("Underbase");
  await cutName.press("Enter");
  assert.equal(await cutName.inputValue(), "KnifeLine",
    "duplicate CutContour name was accepted");
  assert.deepEqual(errors, [], `browser page errors: ${errors.join("; ")}`);
  await page.screenshot({ path: "/tmp/spot-names-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.screenshot({ path: "/tmp/spot-names-mobile.png", fullPage: true });
  console.log("spot-names-browser: passed");
} finally {
  await browser.close();
}