import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../vps/src/canvas-shim.ts';
import { PreparedContourCache } from '../client/src/lib/prepared-contour-cache';
import { offsetPreparedContours } from '../client/src/lib/prepared-contour-offset';

const { ImageData } = await import('@napi-rs/canvas');
const settings = {
  width: .02, color: '#ff00ff', enabled: true, alphaThreshold: 128,
  backgroundColor: '#ffffff', useCustomBackground: true,
  autoBridging: false, autoBridgingThreshold: .01,
  cornerMode: 'balanced' as const, includeHoles: true,
};

// Two near-equal peers, one with an interior hole. A short gap lets the
// existing bridging stage weld them without treating the second as debris.
function artwork() {
  const w = 180, h = 100, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 12; y < 88; y++) for (let x = 12; x < 168; x++) {
    if (x >= 86 && x < 94) continue;
    if (x >= 30 && x < 65 && y >= 32 && y < 68) continue;
    const i = (y * w + x) * 4;
    data[i] = 210; data[i + 1] = 110; data[i + 2] = 30; data[i + 3] = 255;
  }
  return new ImageData(data, w, h);
}

function quiet<T>(fn: () => T) {
  const log = console.log, warn = console.warn;
  console.log = console.warn = () => {};
  try { return fn(); } finally { console.log = log; console.warn = warn; }
}

test('prepared cache compares copied pixels, catches same-buffer edits, and evicts old entries', () => {
  const cache = new PreparedContourCache();
  const pixels = new Uint8ClampedArray([1, 2, 3, 4]);
  let builds = 0;
  const run = (p = pixels, key = 'a') => cache.getOrCreate(p, key, () => ++builds);
  assert.equal(run(), 1);
  assert.equal(run(pixels.slice()), 1);
  pixels[0] = 7;
  assert.equal(run(), 2);
  assert.equal(run(pixels, 'b'), 3);
  assert.equal(run(), 4);
  assert.deepEqual(cache.stats, { hits: 1, misses: 4 });
});

test('vector offset retains separated peers, unions touching offsets, and never clamps wide margins', () => {
  const box = (x: number) => [{ x, y: 0 }, { x: x + 100, y: 0 },
    { x: x + 100, y: 100 }, { x, y: 100 }];
  const paths = [box(0), box(120)];
  assert.equal(offsetPreparedContours(paths, 3).length, 2);
  assert.equal(offsetPreparedContours(paths, 12).length, 1);
  const wide = offsetPreparedContours(paths, 1000).flat();
  assert.equal(Math.min(...wide.map(p => p.x)), -1000);
  assert.equal(Math.max(...wide.map(p => p.x)), 1220);
  assert.equal(Math.min(...wide.map(p => p.y)), -1000);
  assert.equal(Math.max(...wide.map(p => p.y)), 1100);
});

for (const tree of ['lib', 'builders/spot-uv/lib']) {
  const core = await import(`../client/src/${tree}/contour-trace-core.ts`);
  test(`${tree}: cached margins/styles equal fresh geometry and preserve peers and holes`, () => quiet(() => {
    const image = artwork();
    const run = (width: number, cornerMode: 'sharp' | 'balanced' | 'rounded') =>
      core.processContour(new ImageData(image.data.slice(), image.width, image.height),
        { ...settings, width, cornerMode }, 100, false);
    for (const corner of ['sharp', 'balanced', 'rounded'] as const) {
      for (const margin of [.02, .04, .07, .14, .25]) {
        core.preparedContourCache.clear();
        run(.01, 'balanced');
        const warm = run(margin, corner);
        assert.equal(core.preparedContourCache.stats.hits, 1);
        core.preparedContourCache.clear();
        const cold = run(margin, corner);
        assert.deepEqual(warm.contourData, cold.contourData);
        assert.deepEqual(warm.imageData.data, cold.imageData.data);
        // Both halves must survive; the ink spans 1.56 inches before margin.
        const pts = warm.contourData.pathPoints;
        assert.ok(Math.max(...pts.map((p: any) => p.x)) - Math.min(...pts.map((p: any) => p.x)) > 1.5);
        if (margin <= .07) assert.equal(warm.contourData.holePathStartIndex, 1);
      }
    }
  }));

  test(`${tree}: colors/bridge settings reuse preparation; pixel, DPI, threshold, holes invalidate it`, () => quiet(() => {
    const image = artwork();
    core.preparedContourCache.clear();
    const run = (s = {}, dpi = 100, input = image) =>
      core.processContour(input, { ...settings, ...s }, dpi, false);
    run();
    run({ color: '#112233', backgroundColor: '#eeeeee', autoBridging: true, autoBridgingThreshold: .03 });
    assert.deepEqual(core.preparedContourCache.stats, { hits: 1, misses: 1 });
    run({ alphaThreshold: 80 });
    run({ includeHoles: false });
    run({}, 120);
    image.data[(20 * image.width + 20) * 4 + 3] = 0;
    run({}, 120);
    assert.equal(core.preparedContourCache.stats.misses, 5);
    const before = { ...core.preparedContourCache.stats };
    run({ width: 0 });
    assert.deepEqual(core.preparedContourCache.stats, before, 'Zero Hero uses its unchanged exact pipeline');
  }));
}
