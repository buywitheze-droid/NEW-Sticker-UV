import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [before, after] = await Promise.all(process.argv.slice(2, 4).map(async file => JSON.parse(await readFile(file))));
function distance(p, a, b) {
  const x = b.x - a.x, y = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * x + (p.y - a.y) * y) / (x*x + y*y || 1)));
  return Math.hypot(p.x - a.x - t*x, p.y - a.y - t*y);
}
for (let i = 0; i < before.length; i++) {
  assert.equal(before[i].margin, after[i].margin);
  const a = before[i].contour, b = after[i].contour;
  let error = 0;
  for (const [x, y] of [[a.pathPoints, b.pathPoints], [b.pathPoints, a.pathPoints]]) {
    for (const point of x) {
      let nearest = Infinity;
      for (let j = 0; j < y.length; j++) nearest = Math.min(nearest, distance(point, y[j], y[(j+1)%y.length]));
      error = Math.max(error, nearest * a.effectiveDPI);
    }
  }
  console.log({ margin: before[i].margin, maxBoundaryErrorPixels: error });
  assert.ok(error < .01, 'Boundary drift exceeded 0.01 source pixels');
  for (const key of ['widthInches', 'heightInches', 'imageOffsetX', 'imageOffsetY']) {
    assert.ok(Math.abs(a[key] - b[key]) * a.effectiveDPI < .01, `${key} shifted`);
  }
}
