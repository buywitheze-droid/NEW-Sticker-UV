import assert from "node:assert/strict";
import { test } from "node:test";
import "../vps/src/canvas-shim.ts";

const { ImageData } = await import("@napi-rs/canvas");

const settings = {
  width: 0.04, color: "#ff00ff", enabled: true, alphaThreshold: 1,
  backgroundColor: "#ffffff", useCustomBackground: false,
  autoBridging: false, autoBridgingThreshold: 0,
};

function image(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 8; y < height - 8; y++) {
    for (let x = 12; x < width - 12; x++) {
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 200;
      data[i + 3] = 255;
    }
  }
  return new ImageData(data, width, height);
}

for (const tree of ["lib", "builders/spot-uv/lib"]) {
  test(`${tree}: worker preserves core page and path for preview and export`, async () => {
    const core = await import(`../client/src/${tree}/contour-trace-core.ts`);
    await import(`../client/src/${tree}/contour-worker.ts`);
    const handle = (globalThis as any).self.onmessage;
    assert.equal(typeof handle, "function");

    for (const previewMode of [true, false]) {
      // Exercise preview downscaling and export's authoritative full bleed.
      const width = previewMode ? 420 : 120;
      const height = 52;
      const input = image(width, height);
      const dpi = width / 3;
      const scale = previewMode ? 400 / width : 1;
      const scaled = previewMode
        ? core.downscaleImageData(input, Math.round(width * scale), Math.round(height * scale))
        : input;
      const original = core.processContour(scaled, settings, dpi * scale, previewMode);
      const messages: any[] = [];
      const oldPost = (globalThis as any).self.postMessage;
      (globalThis as any).self.postMessage = (msg: any) => messages.push(msg);
      try {
        handle({ data: { type: "process", imageData: input, strokeSettings: settings,
          effectiveDPI: dpi, previewMode, detectedShapeType: null, detectedShapeBBox: null } });
      } finally {
        (globalThis as any).self.postMessage = oldPost;
      }
      const result = messages.find(m => m.type === "result");
      assert.ok(result, messages.find(m => m.type === "error")?.error);
      assert.equal(result.contourData.bleedInches, previewMode ? 0.02 : 0.10);
      assert.equal(result.contourData.widthInches, original.contourData.widthInches);
      assert.equal(result.contourData.heightInches, original.contourData.heightInches);
      assert.deepEqual(result.contourData.pathPoints, original.contourData.pathPoints);
      assert.deepEqual(result.contourData.allPathPoints, original.contourData.allPathPoints);
      assert.equal(result.contourData.holePathStartIndex, original.contourData.holePathStartIndex);
      assert.equal(result.contourData.imageOffsetX, original.contourData.imageOffsetX);
      assert.equal(result.contourData.effectiveDPI, dpi);
      assert.equal(result.contourData.minPathX, original.contourData.minPathX / scale);
      assert.equal(result.contourData.previewPathPoints[0].x,
        original.contourData.previewPathPoints[0].x / scale);
    }
  });
}