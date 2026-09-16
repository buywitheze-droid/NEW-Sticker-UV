import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ColorRegion, ExtractedColor } from '../client/src/builders/spot-uv/lib/color-extractor.ts';
import {
  generateAutoSpotSelections,
  type AutoSpotSettings,
} from '../client/src/builders/spot-uv/lib/auto-spot-layers.ts';

function region(id: number, flags: Partial<Pick<ColorRegion, 'spotWhite' | 'spotGloss'>> = {}): ColorRegion {
  return {
    id,
    bbox: { minX: id, minY: 0, maxX: id, maxY: 0 },
    pixelCount: 1,
    percentage: 25,
    selected: true,
    pixelIndices: [id],
    ...flags,
  };
}

function color(
  hex = '#808080',
  flags: Partial<Pick<ExtractedColor, 'spotWhite' | 'spotGloss'>> = {},
  regions?: ColorRegion[],
): ExtractedColor {
  return {
    hex,
    rgb: { r: 128, g: 128, b: 128 },
    count: 4,
    percentage: 100,
    spotWhite: false,
    spotGloss: false,
    spotFluorY: false,
    spotFluorM: false,
    spotFluorG: false,
    spotFluorOrange: false,
    ...flags,
    ...(regions === undefined ? {} : { regions }),
  };
}

function image(gray: number[], alpha: number[] = gray.map(() => 255)): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const data = new Uint8ClampedArray(gray.length * 4);
  gray.forEach((value, index) => {
    const offset = index * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = alpha[index];
  });
  return { data, width: gray.length, height: 1 };
}

function settings(overrides: Partial<AutoSpotSettings> = {}): AutoSpotSettings {
  return {
    white: 'clear',
    gloss: 'clear',
    whiteThreshold: 0.5,
    glossThreshold: 0.5,
    invertGloss: false,
    regionCoverage: 1,
    ...overrides,
  };
}

test('solid white and gloss select every visible pixel in existing color domains', () => {
  const result = generateAutoSpotSelections({
    imageData: image([0, 255, 120], [255, 255, 0]),
    colors: [color()],
    pixelMap: new Int16Array([0, 0, 0]),
    settings: settings({ white: 'solid', gloss: 'relief', glossThreshold: 0 }),
  });

  assert.deepEqual(Array.from(result.whiteMask), [255, 255, 0]);
  assert.deepEqual(Array.from(result.glossMask), [255, 255, 0]);
  assert.equal(result.whitePixels, 2);
  assert.equal(result.glossPixels, 2);
  assert.equal(result.width, 3);
  assert.equal(result.height, 1);
  assert.equal(result.colors[0].spotWhite, true);
  assert.equal(result.colors[0].spotGloss, true);
});

test('light and dark guides use tonal coverage before selecting a whole color', () => {
  const colors = [color()];
  const map = new Int16Array([0, 0, 0, 0]);

  const enoughLight = generateAutoSpotSelections({
    imageData: image([0, 255, 255, 0]),
    colors,
    pixelMap: map,
    settings: settings({ white: 'light', whiteThreshold: 0.8, regionCoverage: 0.5 }),
  });
  assert.deepEqual(Array.from(enoughLight.whiteMask), [255, 255, 255, 255]);

  const notEnoughLight = generateAutoSpotSelections({
    imageData: image([0, 255, 255, 0]),
    colors,
    pixelMap: map,
    settings: settings({ white: 'light', whiteThreshold: 0.8, regionCoverage: 0.75 }),
  });
  assert.deepEqual(Array.from(notEnoughLight.whiteMask), [0, 0, 0, 0]);
  assert.equal(notEnoughLight.colors[0].spotWhite, false);

  const enoughDark = generateAutoSpotSelections({
    imageData: image([0, 0, 255, 255]),
    colors,
    pixelMap: map,
    settings: settings({ white: 'dark', whiteThreshold: 0.2, regionCoverage: 0.5 }),
  });
  assert.deepEqual(Array.from(enoughDark.whiteMask), [255, 255, 255, 255]);
});

test('relief, highlights, and detail snap guides to existing connected regions', () => {
  const regions = [region(0), region(1), region(2), region(3)];
  const colors = [{ ...color('#808080', {}, regions), regionMap: new Int32Array([0, 1, 2, 3]) }];
  const map = new Int16Array([0, 0, 0, 0]);

  const relief = generateAutoSpotSelections({
    imageData: image([0, 85, 170, 255]),
    colors,
    pixelMap: map,
    settings: settings({ gloss: 'relief', glossThreshold: 0.5 }),
  });
  assert.deepEqual(Array.from(relief.glossMask), [0, 0, 255, 255]);
  assert.equal(relief.colors[0].regions![2].spotGloss, true);
  assert.equal(relief.colors[0].regions![3].spotGloss, true);

  const highlights = generateAutoSpotSelections({
    imageData: image([0, 85, 170, 255]),
    colors,
    pixelMap: map,
    settings: settings({ gloss: 'highlights', glossThreshold: 0.75 }),
  });
  assert.deepEqual(Array.from(highlights.glossMask), [0, 0, 0, 255]);

  const detail = generateAutoSpotSelections({
    imageData: image([0, 0, 255, 255]),
    colors,
    pixelMap: map,
    settings: settings({ gloss: 'detail', glossThreshold: 0.5 }),
  });
  assert.deepEqual(Array.from(detail.glossMask), [0, 255, 255, 0]);

  const inverted = generateAutoSpotSelections({
    imageData: image([0, 85, 170, 255]),
    colors,
    pixelMap: map,
    settings: settings({ gloss: 'relief', glossThreshold: 0.5, invertGloss: true }),
  });
  assert.deepEqual(Array.from(inverted.glossMask), [255, 255, 0, 0]);
});

test('transparent, orphan, and unknown region pixels stay out unless the layer is fully tagged', () => {
  const regions = [region(0), region(1)];
  const source = image([255, 0, 255, 255]);
  const map = new Int16Array([0, 0, 0, 0]);
  const regionMap = new Int32Array([0, -1, 99, 1]);
  const partial = generateAutoSpotSelections({
    imageData: image([255, 0, 255, 0]),
    colors: [{ ...color(), regions, regionMap }],
    pixelMap: map,
    settings: settings({ white: 'light', whiteThreshold: 0.8, regionCoverage: 1 }),
  });
  // The unknown region id at index 2 and the orphan at index 1 are not
  // assigned to a connected region. The second region has one mapped pixel.
  assert.deepEqual(Array.from(partial.whiteMask), [255, 0, 0, 0]);

  const full = generateAutoSpotSelections({
    imageData: source,
    colors: [{
      ...color(),
      regions: [region(0, { spotWhite: true }), region(1, { spotWhite: true })],
      regionMap,
    }],
    pixelMap: map,
    settings: settings({ white: 'keep' }),
  });
  // Exporter's all-tagged path uses the source alpha silhouette, deliberately
  // including the orphan and unknown-region pixels.
  assert.deepEqual(Array.from(full.whiteMask), [255, 255, 255, 255]);
  assert.equal(full.whitePixels, 4);
});

test('keep and clear preserve or remove each layer independently', () => {
  const sourceColors = [color('#808080', {}, [
    region(0, { spotWhite: true, spotGloss: false }),
    region(1, { spotWhite: false, spotGloss: true }),
  ])];
  sourceColors[0].regionMap = new Int32Array([0, 1]);
  const input = {
    imageData: image([100, 100]),
    colors: sourceColors,
    pixelMap: new Int16Array([0, 0]),
    settings: settings({ white: 'keep', gloss: 'clear' }),
  };
  const keptWhite = generateAutoSpotSelections(input);
  assert.deepEqual(Array.from(keptWhite.whiteMask), [255, 0]);
  assert.deepEqual(Array.from(keptWhite.glossMask), [0, 0]);
  assert.equal(keptWhite.colors[0].spotWhite, true);
  assert.equal(keptWhite.colors[0].spotGloss, false);

  const keptGloss = generateAutoSpotSelections({
    ...input,
    settings: settings({ white: 'clear', gloss: 'keep' }),
  });
  assert.deepEqual(Array.from(keptGloss.whiteMask), [0, 0]);
  assert.deepEqual(Array.from(keptGloss.glossMask), [0, 255]);
  assert.equal(keptGloss.colors[0].spotWhite, false);
  assert.equal(keptGloss.colors[0].spotGloss, true);
});

test('color flags use any selected region while all-tagged behavior uses every region', () => {
  const regions = [region(0), region(1), region(2)];
  const result = generateAutoSpotSelections({
    imageData: image([255, 0, 255]),
    colors: [{ ...color('#808080', {}, regions), regionMap: new Int32Array([0, 1, 2]) }],
    pixelMap: new Int16Array([0, 0, 0]),
    settings: settings({ white: 'light', whiteThreshold: 0.8 }),
  });

  assert.deepEqual(Array.from(result.whiteMask), [255, 0, 255]);
  assert.equal(result.colors[0].regions![0].spotWhite, true);
  assert.equal(result.colors[0].regions![1].spotWhite, false);
  assert.equal(result.colors[0].regions![2].spotWhite, true);
  assert.equal(result.colors[0].spotWhite, true);
});

test('returns shallow copies and does not mutate colors, regions, maps, or settings', () => {
  const regionMap = new Int32Array([0, 1]);
  const pixelMap = new Int16Array([0, 0]);
  const colors = [color('#123456', { spotWhite: true }, [
    region(0, { spotWhite: true }),
    region(1, { spotWhite: false }),
  ])];
  colors[0].regionMap = regionMap;
  const source = image([255, 0]);
  const original = structuredClone({ source, colors, pixelMap });
  const result = generateAutoSpotSelections({
    imageData: source,
    colors,
    pixelMap,
    settings: settings({ white: 'clear' }),
  });

  assert.notStrictEqual(result.colors, colors);
  assert.notStrictEqual(result.colors[0], colors[0]);
  assert.notStrictEqual(result.colors[0].regions, colors[0].regions);
  assert.notStrictEqual(result.colors[0].regions![0], colors[0].regions![0]);
  assert.strictEqual(result.colors[0].regionMap, regionMap);
  assert.strictEqual(result.colors[0].regions![0].bbox, colors[0].regions![0].bbox);
  assert.strictEqual(result.colors[0].regions![0].pixelIndices, colors[0].regions![0].pixelIndices);
  assert.deepEqual({ source, colors, pixelMap }, original);
});

test('validates dimensions, RGBA/map sizes, finite settings, and color indices', () => {
  const base = {
    imageData: image([0]),
    colors: [color()],
    pixelMap: new Int16Array([0]),
    settings: settings(),
  };

  assert.throws(() => generateAutoSpotSelections({
    ...base,
    imageData: { ...base.imageData, data: new Uint8ClampedArray(3) },
  }), /RGBA/);
  assert.throws(() => generateAutoSpotSelections({
    ...base,
    pixelMap: new Int16Array([]),
  }), /pixelMap length/);
  assert.throws(() => generateAutoSpotSelections({
    ...base,
    settings: settings({ whiteThreshold: Number.NaN }),
  }), /finite/);
  assert.throws(() => generateAutoSpotSelections({
    ...base,
    pixelMap: new Int16Array([2]),
  }), /invalid color index/);
  assert.throws(() => generateAutoSpotSelections({
    imageData: {
      data: new Uint8ClampedArray(1_000_001 * 4),
      width: 1_000_001,
      height: 1,
    },
    colors: [color()],
    pixelMap: new Int16Array(1_000_001),
    settings: settings(),
  }), /maximum/);
});