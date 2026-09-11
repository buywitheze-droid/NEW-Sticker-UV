import assert from "node:assert/strict";
import { test } from "node:test";

import type { ColorRegion, ExtractedColor } from "../client/src/builders/spot-uv/lib/color-extractor.ts";
import { mergeDetectedColorRegions } from "../client/src/builders/spot-uv/lib/spot-selection-state.ts";

function makeRegion(
  id: number,
  overrides: Partial<ColorRegion> = {},
): ColorRegion {
  return {
    id,
    bbox: { minX: id, minY: id, maxX: id + 1, maxY: id + 1 },
    pixelCount: 10 + id,
    percentage: 0.1,
    selected: true,
    pixelIndices: [id],
    ...overrides,
  };
}

function makeColor(
  hex: string,
  overrides: Partial<ExtractedColor> = {},
): ExtractedColor {
  return {
    hex,
    rgb: { r: 10, g: 20, b: 30 },
    count: 100,
    percentage: 25,
    spotWhite: false,
    spotGloss: false,
    spotFluorY: false,
    spotFluorM: false,
    spotFluorG: false,
    spotFluorOrange: false,
    ...overrides,
  };
}

test("live whole-color choices win over late detection", () => {
  const oldRegionMap = new Int32Array([7, 7, 0, 8]);
  const freshRegionMap = new Int32Array([7, 9, 9, 8, 8]);
  const current = [
    makeColor("#123456", {
      count: 12,
      name: "chosen color",
      spotWhite: true,
      spotGloss: true,
      regions: [
        makeRegion(7, {
          selected: false,
          spotWhite: false,
          spotGloss: false,
          thumbnailUrl: "user-thumbnail",
        }),
        makeRegion(9, {
          selected: false,
          spotWhite: false,
          spotGloss: false,
        }),
      ],
      regionMap: oldRegionMap,
    }),
  ];
  const detected = [
    makeColor("#123456", {
      count: 99,
      name: "detected color",
      spotWhite: false,
      spotGloss: false,
      regions: [
        makeRegion(7, {
          bbox: { minX: 20, minY: 21, maxX: 30, maxY: 31 },
          pixelCount: 200,
          selected: true,
          spotWhite: true,
          spotGloss: true,
        }),
        // Missing region-level flags inherit the user's whole-color choices.
        makeRegion(8, { selected: true }),
        // Explicit false values must not be replaced by whole-color choices.
        makeRegion(9, {
          selected: false,
          spotWhite: true,
          spotGloss: true,
        }),
      ],
      regionMap: freshRegionMap,
    }),
  ];

  const merged = mergeDetectedColorRegions(current, detected);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].spotWhite, true);
  assert.equal(merged[0].spotGloss, true);
  assert.strictEqual(merged[0].regionMap, freshRegionMap);
  assert.deepEqual(Array.from(merged[0].regionMap ?? []), [7, 9, 9, 8, 8]);

  assert.deepEqual(merged[0].regions, [
    {
      ...detected[0].regions![0],
      selected: false,
      spotWhite: false,
      spotGloss: false,
    },
    {
      ...detected[0].regions![1],
      spotWhite: true,
      spotGloss: true,
    },
    {
      ...detected[0].regions![2],
      spotWhite: false,
      spotGloss: false,
    },
  ]);
  // Detection geometry is used, while the live palette metadata remains intact.
  assert.equal(merged[0].count, 12);
  assert.equal(merged[0].name, "chosen color");
});

test("merging regions does not mutate current or detected snapshots", () => {
  const current = [
    makeColor("#ABCDEF", {
      spotWhite: true,
      spotGloss: false,
      regions: [
        makeRegion(1, { selected: false, spotWhite: true }),
      ],
      regionMap: new Int32Array([1, 0, 1]),
    }),
  ];
  const detected = [
    makeColor("#ABCDEF", {
      spotWhite: false,
      spotGloss: true,
      regions: [
        makeRegion(1, { selected: true, spotGloss: true }),
        makeRegion(2),
      ],
      regionMap: new Int32Array([1, 2, 2]),
    }),
  ];
  const currentBefore = structuredClone(current);
  const detectedBefore = structuredClone(detected);

  mergeDetectedColorRegions(current, detected);

  assert.deepEqual(current, currentBefore);
  assert.deepEqual(detected, detectedBefore);
});

test("a mismatched palette entry is returned safely without merging", () => {
  const current = [
    makeColor("#111111", {
      regions: [makeRegion(4, { selected: false })],
      regionMap: new Int32Array([4]),
    }),
  ];
  const detected = [
    makeColor("#222222", {
      regions: [makeRegion(4, { selected: true })],
      regionMap: new Int32Array([4, 4]),
    }),
  ];

  const merged = mergeDetectedColorRegions(current, detected);

  assert.strictEqual(merged[0], current[0]);
  assert.deepEqual(merged, current);
});