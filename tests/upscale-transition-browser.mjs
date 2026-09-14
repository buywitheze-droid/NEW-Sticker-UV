// Run against a running dev server:
// PLAYWRIGHT_MODULE=/mnt/pid2/node_modules/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium \
// REPLIT_DEV_DOMAIN=... node tests/upscale-transition-browser.mjs
//
// This test deliberately exercises the complete image-enhancement transition.
// It does not stub contour workers: only the unrelated QR server fallback is
// routed to an empty response so a no-QR art test cannot spend time in QR
// detection.
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseURL = process.env.TEST_BASE_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`;

const executablePath = process.env.CHROMIUM_EXECUTABLE;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  args: ["--no-sandbox"],
});

// Keep the art large enough to exercise the 400px display-only contour cap.
// The transparent irregular silhouette also prevents shape detection from
// turning the test into a rectangular fast path.
const artwork = createCanvas(1800, 1200);
const art = artwork.getContext("2d");
art.clearRect(0, 0, 1800, 1200);
const gradient = art.createLinearGradient(100, 80, 1720, 1120);
gradient.addColorStop(0, "#16104a");
gradient.addColorStop(0.22, "#007c9e");
gradient.addColorStop(0.46, "#6420ad");
gradient.addColorStop(0.72, "#e23a83");
gradient.addColorStop(1, "#ff9e22");
art.beginPath();
art.moveTo(140, 170);
art.bezierCurveTo(310, 40, 520, 105, 690, 125);
art.bezierCurveTo(925, 20, 1150, 105, 1340, 82);
art.bezierCurveTo(1570, 58, 1700, 190, 1690, 390);
art.bezierCurveTo(1780, 610, 1670, 820, 1710, 1015);
art.bezierCurveTo(1520, 1145, 1310, 1082, 1125, 1140);
art.bezierCurveTo(880, 1180, 690, 1112, 500, 1148);
art.bezierCurveTo(260, 1152, 100, 1010, 138, 810);
art.bezierCurveTo(52, 595, 104, 380, 140, 170);
art.closePath();
art.fillStyle = gradient;
art.fill();

for (const [color, y, bend] of [
  ["#00e5ff", 310, 90],
  ["#ffef3c", 545, -85],
  ["#ff3e96", 780, 105],
]) {
  art.save();
  art.globalAlpha = 0.78;
  art.strokeStyle = color;
  art.lineWidth = 52;
  art.beginPath();
  art.moveTo(120, y);
  art.bezierCurveTo(450, y + bend, 720, y - bend, 1020, y + 8);
  art.bezierCurveTo(1280, y + bend, 1510, y - bend / 2, 1710, y + 40);
  art.stroke();
  art.restore();
}

for (const [x, y, radius, color] of [
  [420, 340, 210, "#ff446e"],
  [420, 340, 140, "#ffcf33"],
  [420, 340, 74, "#4df7d4"],
  [1290, 805, 235, "#2dff8f"],
  [1290, 805, 155, "#2875ff"],
  [1290, 805, 70, "#ff4bc3"],
]) {
  art.beginPath();
  art.arc(x, y, radius, 0, Math.PI * 2);
  art.globalAlpha = 0.72;
  art.fillStyle = color;
  art.fill();
  art.globalAlpha = 1;
}

function drawStar(cx, cy, outer, inner, points, colors) {
  art.save();
  art.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / points;
    const radius = i % 2 ? inner : outer;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) art.moveTo(x, y);
    else art.lineTo(x, y);
  }
  art.closePath();
  const starGradient = art.createLinearGradient(cx - outer, cy - outer, cx + outer, cy + outer);
  starGradient.addColorStop(0, colors[0]);
  starGradient.addColorStop(0.5, colors[1]);
  starGradient.addColorStop(1, colors[2]);
  art.fillStyle = starGradient;
  art.fill();
  art.lineWidth = 8;
  art.strokeStyle = "#ffffff99";
  art.stroke();
  art.restore();
}

drawStar(920, 380, 270, 92, 11, ["#ffea00", "#ff6d00", "#ff006e"]);
drawStar(940, 870, 175, 62, 8, ["#00f0ff", "#5d34ff", "#c026d3"]);
for (let i = 0; i < 42; i++) {
  const x = 180 + ((i * 379) % 1450);
  const y = 125 + ((i * 211) % 960);
  const size = 14 + (i % 5) * 7;
  art.save();
  art.translate(x, y);
  art.rotate((i % 9) * 0.22);
  art.fillStyle = ["#fff", "#00f5d4", "#fbff12", "#ff70a6"][i % 4];
  art.fillRect(-size / 2, -size / 2, size, size);
  art.strokeStyle = "#16104d";
  art.lineWidth = 4;
  art.strokeRect(-size / 2, -size / 2, size, size);
  art.restore();
}
art.font = "bold 72px sans-serif";
art.fillStyle = "#ffffff";
art.globalAlpha = 0.88;
art.fillText("CHROMA / 01", 235, 1035);
art.globalAlpha = 1;

const file = {
  name: "upscale-transition-chroma-1800x1200.png",
  mimeType: "image/png",
  buffer: artwork.toBuffer("image/png"),
};

function installInstrumentation(context) {
  context.addInitScript(() => {
    const state = {
      workers: [],
      contourJobs: [],
      nextWorkerId: 1,
      qualityStart: null,
      qualityEnd: null,
      stopSampling: false,
    };
    window.__upscaleTransition = state;

    const NativeWorker = window.Worker;
    if (!NativeWorker) return;
    class InstrumentedWorker extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        const id = state.nextWorkerId++;
        this.__upscaleWorkerId = id;
        this.__upscaleWorkerUrl = String(url);
        state.workers.push({ id, url: String(url), created: performance.now(), terminated: null });
        this.addEventListener("message", (event) => {
          const data = event.data;
          const type = data && typeof data === "object"
            ? data.type || (data.ready ? "ready" : data.ok ? "echo" : undefined)
            : undefined;
          if (type === "result" || type === "error") {
            const pending = [...state.contourJobs]
              .reverse()
              .find((job) => job.workerId === id && !job.end);
            if (pending) {
              pending.end = performance.now();
              pending.result = type;
            }
          }
        });
      }

      postMessage(message, transfer) {
        const type = message && typeof message === "object" ? message.type : undefined;
        if (
          type === "process" &&
          this.__upscaleWorkerUrl.includes("contour-worker")
        ) {
          state.contourJobs.push({
            workerId: this.__upscaleWorkerId,
            start: performance.now(),
            end: null,
            result: null,
            inputWidth: message.imageData?.width ?? null,
            inputHeight: message.imageData?.height ?? null,
            settings: {
              strokeSettings: message.strokeSettings,
              resizeSettings: message.resizeSettings,
              previewMode: message.previewMode,
              effectiveDPI: message.effectiveDPI,
            },
          });
        }
        if (transfer === undefined) return super.postMessage(message);
        return super.postMessage(message, transfer);
      }

      terminate() {
        const worker = state.workers.find((item) => item.id === this.__upscaleWorkerId);
        if (worker) worker.terminated = performance.now();
        return super.terminate();
      }
    }
    window.Worker = InstrumentedWorker;
  });
}

async function waitUntil(page, predicate, label, timeout = 90000, interval = 75) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(interval);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

async function routeQrFallback(page) {
  await page.route("**/api/detect-qr", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ qrCodes: [] }),
  }));
}

async function visibleFixedText(page, pattern) {
  return page.evaluate((source) => {
    const regex = new RegExp(source);
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0";
    };
    return [...document.querySelectorAll(".fixed")]
      .filter(visible)
      .some((element) => regex.test(element.innerText || ""));
  }, pattern.source);
}

function startTransitionSampler(page) {
  return page.evaluate(async () => {
    const state = window.__upscaleTransition;
    const frames = [];
    const started = performance.now();
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0";
    };

    while (!state.stopSampling && performance.now() - started < 120000) {
      if (state.qualityStart !== null) {
        const canvas = [...document.querySelectorAll("canvas")].find(visible);
        let hash = null;
        let nonzero = 0;
        if (canvas?.width && canvas?.height) {
          const data = canvas.getContext("2d")?.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          ).data;
          if (data) {
            for (let index = 0; index < data.length; index += 397) {
              hash = (hash * 31 + data[index] * 3 + data[index + 1] * 5 +
                data[index + 2] * 7 + data[index + 3]) | 0;
              if (
                data[index] ||
                data[index + 1] ||
                data[index + 2] ||
                data[index + 3]
              ) nonzero++;
            }
          }
        }
        const rect = canvas?.getBoundingClientRect();
        const modalVisible = [...document.querySelectorAll(".fixed")]
          .filter(visible)
          .some((element) => (element.innerText || "").includes("Increasing Quality"));
        const processingVisible = [...document.querySelectorAll(".fixed")]
          .filter(visible)
          .some((element) => (element.innerText || "").includes("Processing..."));
        frames.push({
          t: Math.round(performance.now() - state.qualityStart),
          hash,
          nonzero,
          modalVisible,
          processingVisible,
          canvas: canvas && rect
            ? {
                width: canvas.width,
                height: canvas.height,
                cssWidth: Math.round(rect.width),
                cssHeight: Math.round(rect.height),
              }
            : null,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      frames,
      qualityStart: state.qualityStart,
      qualityEnd: state.qualityEnd,
      contourJobs: state.contourJobs,
    };
  });
}

function stableSettings(job) {
  return JSON.stringify({
    strokeSettings: job.settings.strokeSettings,
    resizeSettings: job.settings.resizeSettings,
    previewMode: job.settings.previewMode,
  });
}

async function collectPageErrors(page) {
  const errors = [];
  const consoleErrors = [];
  const ignoredConsoleErrors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // The unauthenticated editor probes /api/auth/user on page load. Chrome
    // reports its expected 401 as a failed resource in the console even
    // though no application error occurred.
    if (/Failed to load resource:.*\b401\b/.test(message.text())) {
      ignoredConsoleErrors.push(message.text());
    } else {
      consoleErrors.push(message.text());
    }
  });
  return { errors, consoleErrors, ignoredConsoleErrors };
}

async function runContourTransition(context) {
  const page = await context.newPage({ viewport: { width: 1280, height: 900 } });
  const { errors, consoleErrors } = await collectPageErrors(page);
  await routeQrFallback(page);
  await page.goto(baseURL, { waitUntil: "domcontentloaded", timeout: 30000 });
  const sampler = startTransitionSampler(page);

  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByRole("button", { name: "Increase Quality", exact: true }).waitFor({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Contour", exact: true }).click();
  await waitUntil(
    page,
    () => page.evaluate(() => window.__upscaleTransition.contourJobs.length > 0),
    "initial contour worker request",
  );
  await page.getByText(/Processing\.\.\./).first().waitFor({
    state: "hidden",
    timeout: 90000,
  });
  await waitUntil(
    page,
    () => page.evaluate(() => {
      const jobs = window.__upscaleTransition.contourJobs;
      return jobs.length > 0 && jobs.every((job) => job.end !== null);
    }),
    "initial contour result",
  );
  await page.waitForTimeout(400);

  const modal = page.getByText("Increasing Quality", { exact: true }).first();
  const qualityButton = page.getByRole("button", { name: "Increase Quality", exact: true });
  await page.evaluate(() => {
    window.__upscaleTransition.qualityStart = performance.now();
  });
  await qualityButton.click();
  await modal.waitFor({ state: "visible", timeout: 15000 });
  await page.getByText("Quality increased", { exact: true }).first().waitFor({
    state: "visible",
    timeout: 90000,
  });
  await modal.waitFor({ state: "hidden", timeout: 90000 });
  await page.getByText(/Processing\.\.\./).first().waitFor({
    state: "hidden",
    timeout: 90000,
  });
  await page.waitForTimeout(450);
  await page.evaluate(() => {
    window.__upscaleTransition.qualityEnd = performance.now();
    window.__upscaleTransition.stopSampling = true;
  });
  const sampled = await sampler;
  const jobs = sampled.contourJobs;

  assert.deepEqual(errors, [], "contour transition: browser page errors");
  assert.deepEqual(consoleErrors, [], "contour transition: console errors");
  assert.ok(jobs.length >= 1, "contour transition: no real contour worker jobs observed");
  for (const job of jobs) {
    assert.ok(
      Math.max(job.inputWidth, job.inputHeight) <= 400,
      `contour payload exceeded 400px cap: ${job.inputWidth}x${job.inputHeight}`,
    );
    assert.ok(job.end !== null, "contour worker job did not produce a result");
    assert.equal(job.result, "result", "contour worker returned an error");
  }

  const qualityStart = sampled.qualityStart;
  assert.ok(qualityStart !== null, "quality start marker missing");
  const postQualityJobs = jobs.filter((job) => job.start >= qualityStart);
  assert.equal(
    postQualityJobs.length,
    1,
    `expected one unchanged-settings contour request after upscale, got ${postQualityJobs.length}: ${JSON.stringify(jobs)}`,
  );
  const initialJob = jobs.filter((job) => job.start < qualityStart).at(-1);
  assert.ok(initialJob, "initial contour job missing before quality transition");
  assert.equal(
    stableSettings(postQualityJobs[0]),
    stableSettings(initialJob),
    "contour settings changed during the quality transition",
  );
  const postQualityResult = postQualityJobs[0].end;

  assert.ok(sampled.frames.length >= 3, "too few transition frames were sampled");
  assert.ok(sampled.qualityEnd !== null, "quality end marker missing");
  const transitionDuration = sampled.qualityEnd - sampled.qualityStart;
  const transitionFrames = sampled.frames.filter((frame) => frame.t <= transitionDuration);
  const resultRelative = postQualityResult - sampled.qualityStart;
  const framesThroughContourResult = transitionFrames.filter(
    (frame) => frame.t <= resultRelative,
  );
  const firstModal = framesThroughContourResult.findIndex((frame) => frame.modalVisible);
  assert.ok(firstModal >= 0, "Increasing Quality modal was never observed");
  const modalFrames = framesThroughContourResult.slice(firstModal);
  assert.ok(
    modalFrames.every((frame) => frame.modalVisible),
    `Increasing Quality modal blinked or exposed a plain phase: ${JSON.stringify(modalFrames)}`,
  );
  assert.ok(
    modalFrames.every((frame) => frame.canvas && frame.nonzero > 0),
    `transition exposed a missing/blank preview frame: ${JSON.stringify(modalFrames)}`,
  );
  assert.ok(
    transitionFrames.every((frame) => frame.canvas && frame.nonzero > 0),
    `transition exposed a missing/blank preview frame after contour result: ${JSON.stringify(transitionFrames)}`,
  );
  const canvasSizes = new Set(
    transitionFrames.map((frame) => JSON.stringify(frame.canvas)),
  );
  assert.equal(
    canvasSizes.size,
    1,
    `preview canvas size changed during enhancement: ${JSON.stringify(modalFrames)}`,
  );
  assert.ok(
    postQualityResult <= sampled.qualityEnd,
    "quality completed before the contour worker result was available",
  );

  console.log("upscale transition passed", {
    input: "1800x1200",
    contourJobs: jobs.map((job) => ({
      input: `${job.inputWidth}x${job.inputHeight}`,
      durationMs: Math.round(job.end - job.start),
      phase: job.start >= qualityStart ? "after-upscale" : "initial",
    })),
    transitionMs: Math.round(sampled.qualityEnd - sampled.qualityStart),
    frames: sampled.frames.length,
  });
  await page.close();
}

async function runNoContourPath(context) {
  const page = await context.newPage({ viewport: { width: 1280, height: 900 } });
  const { errors, consoleErrors } = await collectPageErrors(page);
  await routeQrFallback(page);
  await page.goto(baseURL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator('input[type="file"]').setInputFiles(file);
  const qualityButton = page.getByRole("button", { name: "Increase Quality", exact: true });
  await qualityButton.waitFor({ timeout: 30000 });

  const modal = page.getByText("Increasing Quality", { exact: true }).first();
  await qualityButton.click();
  await modal.waitFor({ state: "visible", timeout: 15000 });
  await page.getByText("Quality increased", { exact: true }).first().waitFor({
    state: "visible",
    timeout: 90000,
  });
  await modal.waitFor({ state: "hidden", timeout: 90000 });
  await page.waitForTimeout(350);

  assert.deepEqual(errors, [], "no-contour path: browser page errors");
  assert.deepEqual(consoleErrors, [], "no-contour path: console errors");
  const stuck = await visibleFixedText(page, /Processing\.\.\./);
  assert.equal(stuck, false, "no-contour path left a stuck Processing modal");
  const jobs = await page.evaluate(() => window.__upscaleTransition.contourJobs);
  assert.equal(jobs.length, 0, "no-contour path unexpectedly started a contour worker");
  console.log("no-contour quality path passed", { contourJobs: jobs.length });
  await page.close();
}

const context = await browser.newContext();
installInstrumentation(context);
try {
  await runContourTransition(context);
  await runNoContourPath(context);
} finally {
  await context.close();
  await browser.close();
}