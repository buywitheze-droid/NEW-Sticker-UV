import assert from 'node:assert/strict';
import { test } from 'node:test';
import ClipperLib from 'js-clipper';
import { labelContourPixels } from '../client/src/lib/contour-component-labels';
import { contourOrigin, withCenteredContours } from '../client/src/lib/contour-clipper-origin';
import { offsetPreparedContours } from '../client/src/lib/prepared-contour-offset';

function referenceLabels(mask: Uint8Array, w: number, h: number) {
  const labels = new Int32Array(mask.length);
  let count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (mask[y*w+x] !== 1 || labels[y*w+x]) continue;
    count++;
    const stack = [{ x, y }];
    while (stack.length) {
      const p = stack.pop()!;
      if (p.x < 0 || p.x >= w || p.y < 0 || p.y >= h) continue;
      const i = p.y*w+p.x;
      if (mask[i] !== 1 || labels[i]) continue;
      labels[i] = count;
      stack.push({ x: p.x+1, y: p.y }, { x: p.x-1, y: p.y },
        { x: p.x, y: p.y+1 }, { x: p.x, y: p.y-1 });
    }
  }
  return { labels, count };
}

test('typed labels exactly match old flood fill for every 4x3 mask, including diagonal contacts and row boundaries', () => {
  for (let bits = 0; bits < 4096; bits++) {
    const mask = Uint8Array.from({ length: 12 }, (_, i) => (bits >> i) & 1);
    const before = mask.slice();
    assert.deepEqual(labelContourPixels(mask, 4, 3), referenceLabels(mask, 4, 3));
    assert.deepEqual(mask, before);
  }
});

test('typed queue handles dense million-pixel masks, narrow masks and empty masks', () => {
  const dense = labelContourPixels(new Uint8Array(1_000_000).fill(1), 1000, 1000);
  assert.equal(dense.count, 1);
  assert.ok(dense.labels.every(n => n === 1));
  for (const [w, h] of [[1, 100], [100, 1], [7, 5]]) {
    const mask = Uint8Array.from({ length: w*h }, (_, i) => i % 3 === 0 ? 1 : 0);
    assert.deepEqual(labelContourPixels(mask, w, h), referenceLabels(mask, w, h));
    assert.equal(labelContourPixels(new Uint8Array(w*h), w, h).count, 0);
  }
  assert.throws(() => labelContourPixels(new Uint8Array(2), 2, 2));
});

test('centering is reversible, non-mutating, and retains the original integer precision', () => {
  const paths = [[{ x: 9876.12345, y: -4567.54321 }, { x: 9000, y: -4000 }]];
  const before = structuredClone(paths);
  assert.ok(Number.isInteger(contourOrigin(paths).x));
  assert.deepEqual(withCenteredContours(paths, p => p[0]), paths[0]);
  assert.deepEqual(paths, before);
  assert.throws(() => contourOrigin([[{ x: NaN, y: 0 }]]));
});

test('centered offsets match original full-precision offsets on small, huge and translated paths', () => {
  for (const shift of [0, 900, -4000, 100000]) for (const radius of [2, 75, 1000]) {
    const source = Array.from({ length: 40 }, (_, i) => {
      const angle = i*Math.PI/20, r = i%2 ? 210 : 300;
      return { x: shift + Math.cos(angle)*r, y: shift + Math.sin(angle)*r };
    });
    const input = source.map(p => ({ X: Math.round(p.x*100000), Y: Math.round(p.y*100000) }));
    if (ClipperLib.Clipper.Area(input) < 0) input.reverse();
    const old = new ClipperLib.ClipperOffset(2, .05*100000);
    old.AddPath(input, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    const expected: { X: number; Y: number }[][] = [];
    old.Execute(expected, radius*100000);
    const actual = offsetPreparedContours([source], radius);
    assert.equal(actual.length, expected.length);
    const points = expected.flat().map(p => ({ x: p.X/100000, y: p.Y/100000 }));
    assert.equal(actual.flat().length, points.length);
    for (const p of actual.flat()) {
      assert.ok(points.some(q => Math.hypot(p.x-q.x, p.y-q.y) < .00002),
        'Centering must not lower coordinate precision');
    }
  }
});
