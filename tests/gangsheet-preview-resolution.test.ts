import assert from "node:assert/strict";
import { test } from "node:test";
import { gangSheetPreviewResolution } from "../client/src/builders/spot-uv/lib/gang-sheet-preview-resolution";

test("gang sheet preview doubles display resolution without changing aspect ratio", () => {
  assert.deepEqual(gangSheetPreviewResolution(1000, 500, 1), { width: 2000, height: 1000 });
  // Inputs already account for Retina/DPR, so do not multiply DPR again.
  assert.deepEqual(gangSheetPreviewResolution(2000, 1000, 1), { width: 4000, height: 2000 });
});

test("zoom redraws gang sheet detail at higher resolution", () => {
  assert.deepEqual(gangSheetPreviewResolution(1000, 500, 5), { width: 5000, height: 2500 });
  assert.deepEqual(gangSheetPreviewResolution(1000, 500, 20), { width: 5000, height: 2500 });
});

test("large and very long sheets stay within canvas memory and dimension limits", () => {
  for (const [width, height] of [[4000, 4000], [1000, 20000], [2400, 1200]]) {
    const result = gangSheetPreviewResolution(width, height, 5);
    assert.ok(result.width <= 8192 && result.height <= 8192);
    assert.ok(result.width * result.height <= 16_000_000);
    assert.ok(Math.abs(result.width / result.height - width / height) < 0.005);
  }
});