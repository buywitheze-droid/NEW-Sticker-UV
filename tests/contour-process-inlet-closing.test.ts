import assert from "node:assert/strict";
import { test } from "node:test";

import "../vps/src/canvas-shim.ts";

const { ImageData } = await import("@napi-rs/canvas");
const coreModules = await Promise.all([
  import("../client/src/lib/contour-trace-core.ts"),
  import("../client/src/builders/spot-uv/lib/contour-trace-core.ts"),
]);

type Core = (typeof coreModules)[number];
type Point = { x: number; y: number };

function quiet<T>(fn: () => T): T {
  const methods = ["log", "warn", "error", "table"] as const;
  const original = methods.map(method => [method, console[method]] as const);
  for (const [method] of original) {
    (console as any)[method] = () => undefined;
  }
  try {
    return fn();
  } finally {
    for (const [method, value] of original) {
      (console as any)[method] = value;
    }
  }
}

function isInside(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const current = polygon[i];
    const previous = polygon[j];
    if (
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) /
          (previous.y - current.y) +
          current.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function makeConcaveImage(notchWidth = 8): InstanceType<typeof ImageData> {
  const width = 64;
  const height = 64;
  const left = (64 - notchWidth) / 2;
  const right = (64 + notchWidth) / 2;
  const polygon: Point[] = [
    { x: 8, y: 8 },
    { x: 56, y: 8 },
    { x: 56, y: 56 },
    { x: right, y: 56 },
    { x: right, y: 24 },
    { x: left, y: 24 },
    { x: left, y: 56 },
    { x: 8, y: 56 },
  ];
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isInside({ x: x + 0.5, y: y + 0.5 }, polygon)) continue;
      const index = (y * width + x) * 4;
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = 255;
    }
  }
  return new ImageData(data, width, height);
}

const baseSettings = {
  width: 0.01,
  color: "#000000",
  enabled: true,
  alphaThreshold: 128,
  backgroundColor: "#ffffff",
  useCustomBackground: true,
  autoBridging: false,
  autoBridgingThreshold: 0.01,
  contourMode: "smooth" as const,
};

function runContour(
  core: Core,
  settings: Partial<typeof baseSettings> = {},
  previewMode = true,
  detectedShapeType?: "rectangle",
  detectedShapeBBox?: { x: number; y: number; width: number; height: number },
) {
  return quiet(() =>
    core.processContour(
      makeConcaveImage(),
      { ...baseSettings, ...settings },
      300,
      previewMode,
      detectedShapeType,
      detectedShapeBBox,
    ),
  );
}

function inletDepth(result: ReturnType<Core["processContour"]>): number {
  const points = result.contourData.previewPathPoints;
  assert.ok(points.length >= 3);
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const centerX = (minX + maxX) / 2;
  const centerBand = points.filter(point => Math.abs(point.x - centerX) < 10);
  assert.ok(centerBand.length > 0);
  return (
    Math.max(...centerBand.map(point => point.y)) -
    Math.min(...centerBand.map(point => point.y))
  );
}

for (const [name, core] of [
  ["shared contour core", coreModules[0]],
  ["Spot UV contour core", coreModules[1]],
] as const) {
  test(`${name}: preview/export use DPI-scaled bleed radius and autoBridge overrides it`, () => {
    const preview = runContour(core, {}, true);
    const exported = runContour(core, {}, false);
    const autoBridged = runContour(
      core,
      { autoBridging: true, autoBridgingThreshold: 0.5 },
      true,
    );

    assert.equal(preview.contourData.effectiveDPI, 300);
    assert.equal(exported.contourData.effectiveDPI, 300);
    assert.equal(preview.contourData.bleedInches, 0.02);
    assert.equal(exported.contourData.bleedInches, 0.1);

    const previewDepth = inletDepth(preview);
    const exportDepth = inletDepth(exported);
    const autoDepth = inletDepth(autoBridged);
    assert.ok(
      previewDepth > exportDepth + 0.2,
      `export radius should close more of the inlet (${previewDepth} vs ${exportDepth})`,
    );
    assert.ok(
      exportDepth > autoDepth + 0.1,
      `autoBridge radius should override bleed (${exportDepth} vs ${autoDepth})`,
    );
    assert.ok(
      preview.contourData.widthInches < exported.contourData.widthInches,
      "export page should include its larger bleed in inches",
    );
  });

  test(`${name}: Zero Hero and detected rectangles bypass inlet closing`, () => {
    const zeroHero = runContour(
      core,
      { width: 0, autoBridging: true, autoBridgingThreshold: 0.5 },
      true,
    );
    assert.ok(
      inletDepth(zeroHero) > 20,
      "Zero Hero should retain the source concavity even with autoBridge enabled",
    );
    assert.equal(zeroHero.contourData.allPreviewPathPoints?.length, 1);

    const detectedRectangle = runContour(
      core,
      { autoBridging: true, autoBridgingThreshold: 0.5 },
      true,
      "rectangle",
      { x: 8, y: 8, width: 48, height: 48 },
    );
    assert.equal(detectedRectangle.contourData.previewPathPoints.length, 4);
    assert.equal(detectedRectangle.contourData.pathPoints.length, 4);
  });
}