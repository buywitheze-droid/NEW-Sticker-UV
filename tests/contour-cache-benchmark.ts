// Run separately from the unit suite: npx tsx tests/contour-cache-benchmark.ts [image]
import '../vps/src/canvas-shim.ts';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { processContour, preparedContourCache } from '../client/src/builders/spot-uv/lib/contour-trace-core';

const file = process.argv[2] || 'attached_assets/HootzDecalFinal_1791307163714.png';
const image = await loadImage(file);
const canvas = createCanvas(image.width, image.height);
const ctx = canvas.getContext('2d');
ctx.drawImage(image, 0, 0);
const input = ctx.getImageData(0, 0, image.width, image.height);
const settings = {
  width: .02, color: '#ff00ff', enabled: true, alphaThreshold: 128,
  backgroundColor: '#ffffff', useCustomBackground: true,
  autoBridging: false, autoBridgingThreshold: .01, cornerMode: 'balanced' as const,
};
const log = console.log;
console.log = () => {};
let coldMs: number;
const margins = [.04, .07, .14, .25, .02];
const timings: { margin: number; ms: number; vertices: number }[] = [];
try {
  preparedContourCache.clear();
  let t = performance.now();
  processContour(input, settings, 300, false);
  coldMs = performance.now() - t;
  for (const margin of margins) {
    t = performance.now();
    const result = processContour(input, { ...settings, width: margin }, 300, false);
    timings.push({ margin, ms: Math.round(performance.now() - t), vertices: result.contourData.pathPoints.length });
  }
  assert.equal(preparedContourCache.stats.misses, 1);
  assert.equal(preparedContourCache.stats.hits, margins.length);
} finally { console.log = log; }
console.log(JSON.stringify({
  file, dimensions: [image.width, image.height], coldMs: Math.round(coldMs!),
  warm: timings, cache: preparedContourCache.stats,
  note: 'Full core calls including raster rendering; first-run vs cached margin changes, not an old/new speed ratio.',
}, null, 2));
