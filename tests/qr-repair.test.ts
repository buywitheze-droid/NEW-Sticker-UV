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

function paintPattern(
  canvas: ReturnType<typeof createCanvas>,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const offset = (row * width + column) * 4;
      image.data[offset] = (column * 31 + row * 7) % 256;
      image.data[offset + 1] = (column * 11 + row * 37) % 256;
      image.data[offset + 2] = (column * 53 + row * 17) % 256;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, x, y);
}

function assertPixelsEqual(
  actual: ReturnType<typeof createCanvas>,
  expected: ReturnType<typeof createCanvas>,
  actualX: number,
  actualY: number,
  width: number,
  height: number,
  expectedX = actualX,
  expectedY = actualY,
): void {
  const actualData = actual.getContext("2d").getImageData(actualX, actualY, width, height).data;
  const expectedData = expected.getContext("2d").getImageData(expectedX, expectedY, width, height).data;
  assert.deepEqual([...actualData], [...expectedData]);
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

test("preserves exact center, off-center rectangular, and corner logo pixels", async () => {
  const source = createCanvas(160, 140);
  const region = { x: 20, y: 18, width: 120, height: 100 };
  const base = draft("arbitrary-logo", 20, "repair-test", {
    preserveLogo: false,
  });
  const plain = await buildQRRepair(source as unknown as HTMLCanvasElement, { ...base, region });
  source.getContext("2d").drawImage(plain.canvas, region.x, region.y);

  const cases = [
    { id: "center", logoRegion: { x: 0.375, y: 0.4, width: 0.1, height: 0.1 } },
    { id: "off-center", logoRegion: { x: 0.2, y: 0.55, width: 0.2, height: 0.1 } },
    // This logo is in the source-region corner but remains outside the QR
    // finder because the generated code is centered inside its repair box.
    { id: "corner", logoRegion: { x: 0, y: 0, width: 0.1, height: 0.1 } },
  ] as const;

  for (const { id, logoRegion } of cases) {
    const logoX = Math.round(logoRegion.x * region.width);
    const logoY = Math.round(logoRegion.y * region.height);
    const logoRight = Math.round((logoRegion.x + logoRegion.width) * region.width);
    const logoBottom = Math.round((logoRegion.y + logoRegion.height) * region.height);
    const logoWidth = logoRight - logoX;
    const logoHeight = logoBottom - logoY;
    paintPattern(source, region.x + logoX, region.y + logoY, logoWidth, logoHeight);
    const original = createCanvas(logoWidth, logoHeight);
    original.getContext("2d").drawImage(
      source,
      region.x + logoX,
      region.y + logoY,
      logoWidth,
      logoHeight,
      0,
      0,
      logoWidth,
      logoHeight,
    );

    const result = await buildQRRepair(source as unknown as HTMLCanvasElement, {
      ...base,
      id,
      region,
      options: { ...base.options, preserveLogo: true, logoRegion },
    });
    assert.equal(result.verified, true);
    assertPixelsEqual(
      result.canvas as unknown as ReturnType<typeof createCanvas>,
      original,
      logoX,
      logoY,
      logoWidth,
      logoHeight,
      0,
      0,
    );
  }
});

test("rejects invalid normalized logo rectangles", async () => {
  const source = createCanvas(128, 128);
  const invalidRegions = [
    { x: Number.NaN, y: 0, width: 0.2, height: 0.2 },
    { x: -0.01, y: 0, width: 0.2, height: 0.2 },
    { x: 0, y: 0, width: 0, height: 0.2 },
    { x: 0.9, y: 0, width: 0.2, height: 0.1 },
  ];
  for (const logoRegion of invalidRegions) {
    await assert.rejects(
      () => buildQRRepair(source as unknown as HTMLCanvasElement, draft("invalid-logo", 16, "repair-test", {
        preserveLogo: true,
        logoRegion,
      })),
      /logo region|normalized|nonzero|finite/i,
    );
  }
});

test("warns on finder overlap but allows benign originals and fails corrupted protected pixels", async () => {
  const source = createCanvas(128, 128);
  const repair = draft("finder-logo", 16, "repair-test", {
    preserveLogo: true,
    // For this region/payload, the top-left finder occupies x/y 16..36
    // inside the 96px patch. Preserve that exact original finder area.
    logoRegion: { x: 16 / 96, y: 16 / 96, width: 21 / 96, height: 21 / 96 },
  });
  const plain = await buildQRRepair(source as unknown as HTMLCanvasElement, {
    ...repair,
    options: { ...repair.options, preserveLogo: false },
  });
  source.getContext("2d").drawImage(plain.canvas, 16, 12);

  const benign = await buildQRRepair(source as unknown as HTMLCanvasElement, repair);
  assert.equal(benign.verified, true);
  assert.equal(benign.decodedPayload, repair.options.payload);
  assert.ok(benign.warnings.some((warning) => /corner recognition|overlap/i.test(warning)));
  assert.equal(verifyQRRepairAtScale(benign, 1).verified, true);
  verifyQRRepairPixels(source as unknown as HTMLCanvasElement, [repair]);

  // Replace the protected finder with a solid patch. The engine must retain
  // those source pixels and let exact decode fail, rather than removing,
  // moving, shrinking, or recolouring the selected logo.
  const corrupted = createCanvas(128, 128);
  corrupted.getContext("2d").drawImage(source, 0, 0);
  const context = corrupted.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(16 + 16, 12 + 16, 21, 21);
  const failed = await buildQRRepair(corrupted as unknown as HTMLCanvasElement, repair);
  assert.equal(failed.verified, false);
  assert.notEqual(failed.decodedPayload, repair.options.payload);
  assert.ok(failed.warnings.some((warning) => /corner recognition|overlap/i.test(warning)));
  assert.ok(failed.warnings.some((warning) => /not automatically removed|moved|shrunk/i.test(warning)));
  assertPixelsEqual(
    failed.canvas as unknown as ReturnType<typeof createCanvas>,
    corrupted,
    16,
    16,
    21,
    21,
    16 + 16,
    12 + 16,
  );
  assert.equal(verifyQRRepairAtScale(failed, 1).verified, false);
  assert.throws(
    () => verifyQRRepairPixels(corrupted as unknown as HTMLCanvasElement, [repair]),
    /protected logo|corner recognition|payload/i,
  );
});

test("keeps a normalized logo area intact when rebuilding the scaled print source", async () => {
  const source = createCanvas(128, 128);
  const repair = draft("scaled-logo", 16, "repair-test", {
    preserveLogo: true,
    logoRegion: { x: 0, y: 0, width: 0.125, height: 0.125 },
  });
  const plain = await buildQRRepair(source as unknown as HTMLCanvasElement, {
    ...repair,
    options: { ...repair.options, preserveLogo: false },
  });
  source.getContext("2d").drawImage(plain.canvas, 16, 12);
  paintPattern(source, 16, 12, 12, 12);
  const sourceLogoData = source.getContext("2d").getImageData(16, 12, 12, 12);
  sourceLogoData.data.set([29, 71, 163, 0], 0);
  sourceLogoData.data.set([203, 41, 117, 128], 4);
  source.getContext("2d").putImageData(sourceLogoData, 16, 12);

  const printSource = createCanvas(256, 256);
  const printContext = printSource.getContext("2d");
  printContext.imageSmoothingEnabled = false;
  printContext.drawImage(source, 0, 0, 256, 256);
  const expectedLogo = createCanvas(24, 24);
  expectedLogo.getContext("2d").drawImage(printSource, 32, 24, 24, 24, 0, 0, 24, 24);

  const [scaled] = scaleQRRepairDrafts([repair], 128, 128, 256, 256);
  assert.deepEqual(scaled.options.logoRegion, repair.options.logoRegion);
  await applyQRRepairs(printSource as unknown as HTMLCanvasElement, [scaled]);
  assertPixelsEqual(printSource as unknown as ReturnType<typeof createCanvas>, expectedLogo, 32, 24, 24, 24, 0, 0);
  verifyQRRepairPixels(printSource as unknown as HTMLCanvasElement, [scaled]);
});

test("applies transparent and semitransparent source-logo pixels without alpha blending", async () => {
  const source = createCanvas(128, 128);
  const repair = draft("alpha-logo", 16, "repair-test", {
    preserveLogo: true,
    logoRegion: { x: 0, y: 0, width: 0.125, height: 0.125 },
  });
  const plain = await buildQRRepair(source as unknown as HTMLCanvasElement, {
    ...repair,
    options: { ...repair.options, preserveLogo: false },
  });
  source.getContext("2d").drawImage(plain.canvas, 16, 12);

  const logoContext = source.getContext("2d");
  const logoData = logoContext.getImageData(16, 12, 12, 12);
  // Keep the RGB values intentional even when alpha is zero: equality here
  // checks the actual source pixel contract, not only visible compositing.
  logoData.data.set([19, 83, 147, 0], 0);
  logoData.data.set([211, 97, 43, 128], 4);
  logoContext.putImageData(logoData, 16, 12);

  const expectedLogo = createCanvas(12, 12);
  expectedLogo.getContext("2d").drawImage(source, 16, 12, 12, 12, 0, 0, 12, 12);
  await applyQRRepairs(source as unknown as HTMLCanvasElement, [repair]);
  assertPixelsEqual(source as unknown as ReturnType<typeof createCanvas>, expectedLogo, 16, 12, 12, 12, 0, 0);
  const applied = source.getContext("2d").getImageData(16, 12, 2, 1).data;
  assert.deepEqual([...applied], [...expectedLogo.getContext("2d").getImageData(0, 0, 2, 1).data]);
  verifyQRRepairPixels(source as unknown as HTMLCanvasElement, [repair]);
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
