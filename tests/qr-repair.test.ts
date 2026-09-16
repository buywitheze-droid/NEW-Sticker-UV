import assert from "node:assert/strict";
import test from "node:test";

import "../vps/src/canvas-shim.ts";
import { createCanvas } from "@napi-rs/canvas";

import {
  applyQRRepairs,
  buildQRRepair,
  sampleQRRepairColors,
  suggestQRRepairColors,
  verifyQRRepairAtScale,
  verifyQRRepairPixels,
} from "../client/src/builders/spot-uv/lib/qr-repair";
import type { QRRepairDraft } from "../client/src/builders/spot-uv/lib/qr-repair-types";
import { scaleQRRepairDrafts } from "../client/src/builders/spot-uv/lib/qr-repair-geometry";

function installDocumentShim(): void {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement(tagName: string) {
        if (tagName === "canvas") return createCanvas(1, 1);
        throw new Error(`Unsupported test element: ${tagName}`);
      },
    },
  });
}

installDocumentShim();

function draft(
  id: string,
  x: number,
  payload = "repair-test",
  overrides: Partial<QRRepairDraft["options"]> = {},
): QRRepairDraft {
  return {
    id,
    region: { x, y: 12, width: 96, height: 96 },
    options: {
      payload,
      dark: "#000000",
      light: "#ffffff",
      errorCorrectionLevel: "H",
      quietZone: 4,
      preserveLogo: false,
      logoScale: 0.2,
      ...overrides,
    },
  };
}

test("samples QR colours and suggests a same-hue contrast-safe pair", async () => {
  const source = createCanvas(128, 128);
  const result = await buildQRRepair(source as unknown as HTMLCanvasElement, draft("colour", 16));
  assert.equal(result.verified, true);
  source.getContext("2d").drawImage(result.canvas, 16, 12);
  const colours = sampleQRRepairColors(source as unknown as HTMLCanvasElement, {
    x: 16,
    y: 12,
    width: 96,
    height: 96,
  });
  assert.equal(colours.dark.toLowerCase(), "#000000");
  assert.equal(colours.light.toLowerCase(), "#ffffff");
  const suggested = suggestQRRepairColors("#777777", "#999999");
  assert.ok(suggested.dark !== "#777777" || suggested.light !== "#999999");
});

test("builds, verifies after output resampling, and rejects bad payload input", async () => {
  const source = createCanvas(128, 128);
  const result = await buildQRRepair(source as unknown as HTMLCanvasElement, draft("scale", 16));
  assert.equal(result.decodedPayload, "repair-test");
  assert.equal(result.verified, true);
  const scaled = verifyQRRepairAtScale(result, 1);
  assert.equal(scaled.verified, true);
  await assert.rejects(() => buildQRRepair(source as unknown as HTMLCanvasElement, {
    ...draft("empty", 16),
    options: { ...draft("empty", 16).options, payload: "" },
  }));
});

test("reports low contrast and too-small repairs without substituting colours", async () => {
  const source = createCanvas(128, 128);
  const lowContrast = await buildQRRepair(source as unknown as HTMLCanvasElement, draft("contrast", 16, "repair-test", {
    dark: "#777777",
    light: "#ffffff",
  }));
  assert.ok(lowContrast.contrastRatio < 4.5);
  assert.equal(lowContrast.verified, true);
  assert.equal(verifyQRRepairAtScale(lowContrast, 1).verified, true);
  assert.equal(lowContrast.draft.options.dark, "#777777");
  assert.ok(lowContrast.warnings.some((warning) => warning.includes("contrast")));
  await applyQRRepairs(source as unknown as HTMLCanvasElement, [lowContrast.draft]);
  verifyQRRepairPixels(source as unknown as HTMLCanvasElement, [lowContrast.draft]);
  const unreadable = await buildQRRepair(source as unknown as HTMLCanvasElement, draft("unreadable", 16, "repair-test", {
    dark: "#ffffff", light: "#ffffff",
  }));
  assert.equal(unreadable.verified, false);
  assert.equal(verifyQRRepairAtScale(unreadable, 1).verified, false);
  const tiny = createCanvas(33, 33);
  const small = await buildQRRepair(tiny as unknown as HTMLCanvasElement, {
    ...draft("tiny", 0),
    region: { x: 0, y: 0, width: 33, height: 33 },
  });
  assert.equal(small.verified, false);
  assert.ok(small.warnings.some((warning) => warning.includes("pixels")));
});

test("preserves a centred source logo only when the resulting payload still verifies", async () => {
  const source = createCanvas(128, 128);
  const plain = await buildQRRepair(source as unknown as HTMLCanvasElement, draft("base", 16));
  source.getContext("2d").drawImage(plain.canvas, 16, 12);
  const context = source.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(16 + 48 - 5, 12 + 48 - 5, 10, 10);
  const logo = await buildQRRepair(source as unknown as HTMLCanvasElement, draft("logo", 16, "repair-test", {
    preserveLogo: true,
    logoScale: 0.1,
  }));
  assert.equal(logo.verified, true);
});

test("validates every repair before painting and keeps application atomic", async () => {
  const source = createCanvas(360, 128);
  const context = source.getContext("2d");
  context.fillStyle = "#ff00ff";
  context.fillRect(0, 0, source.width, source.height);
  const before = source.toBuffer("image/png");
  await assert.rejects(() => applyQRRepairs(source as unknown as HTMLCanvasElement, [
    draft("one", 16),
    { ...draft("two", 80), region: { x: 80, y: 12, width: 96, height: 96 } },
  ]));
  assert.deepEqual(source.toBuffer("image/png"), before);
  await assert.rejects(() => applyQRRepairs(source as unknown as HTMLCanvasElement, [
    draft("valid-first", 16),
    { ...draft("bad-second", 128), options: { ...draft("bad", 128).options, dark: "#999999", light: "#999999" } },
  ]), /verified/);
  assert.deepEqual(source.toBuffer("image/png"), before);

  await applyQRRepairs(source as unknown as HTMLCanvasElement, [
    draft("one", 16),
    { ...draft("two", 0, "second-payload"), region: { x: 128, y: 12, width: 96, height: 96 } },
    { ...draft("three", 0, "repair-test"), region: { x: 240, y: 12, width: 96, height: 96 } },
  ], 1);
  verifyQRRepairPixels(source as unknown as HTMLCanvasElement, [
    draft("one", 16),
    { ...draft("two", 0, "second-payload"), region: { x: 128, y: 12, width: 96, height: 96 } },
    { ...draft("three", 0, "repair-test"), region: { x: 240, y: 12, width: 96, height: 96 } },
  ]);
  assert.deepEqual([...source.getContext("2d").getImageData(0, 0, 1, 1).data], [255, 0, 255, 255]);
});

test("repairs a small region of artwork larger than the patch memory limit", async () => {
  const source = createCanvas(6000, 6000);
  const repair = draft("large-artwork", 16);
  await applyQRRepairs(source as unknown as HTMLCanvasElement, [repair]);
  verifyQRRepairPixels(source as unknown as HTMLCanvasElement, [repair]);
  assert.deepEqual([...source.getContext("2d").getImageData(5900, 5900, 1, 1).data], [0, 0, 0, 0]);
});

test("verifies actual fractionally resampled preview pixels and rejects tampered pixels", async () => {
  const source = createCanvas(1000, 700);
  const repair = { ...draft("resample", 113), region: { x: 113, y: 57, width: 401, height: 401 } };
  await applyQRRepairs(source as unknown as HTMLCanvasElement, [repair]);
  const preview = createCanvas(793, 555);
  const ctx = preview.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, preview.width, preview.height);
  const mapped = scaleQRRepairDrafts([repair], 1000, 700, 793, 555);
  verifyQRRepairPixels(preview as unknown as HTMLCanvasElement, mapped);
  verifyQRRepairPixels(preview as unknown as HTMLCanvasElement, mapped, 0.85);
  verifyQRRepairPixels(preview as unknown as HTMLCanvasElement, mapped, { x: 0.9, y: 0.85 });
  assert.throws(() => verifyQRRepairPixels(preview as unknown as HTMLCanvasElement, mapped, { x: 2, y: 0.05 }), /payload|density/);
  const r = mapped[0].region;
  ctx.clearRect(r.x, r.y, r.width, r.height);
  assert.throws(() => verifyQRRepairPixels(preview as unknown as HTMLCanvasElement, mapped), /payload/);
});
