type Point = { x: number; y: number };

/**
 * Keep the original 100000-unit precision. Clipper's fast-number range depends
 * on absolute coordinates, so temporarily center operations near zero instead
 * of lowering precision. Large shapes still use its full-range arithmetic.
 * Integer-pixel origins keep the original quantization grid unchanged.
 */
export function contourOrigin(paths: readonly (readonly Point[])[]) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const path of paths) for (const p of path) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('Invalid contour coordinate');
    left = Math.min(left, p.x); right = Math.max(right, p.x);
    top = Math.min(top, p.y); bottom = Math.max(bottom, p.y);
  }
  return Number.isFinite(left)
    ? { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2) }
    : { x: 0, y: 0 };
}

export function withCenteredContours(paths: Point[][], operation: (paths: Point[][]) => Point[]): Point[] {
  const origin = contourOrigin(paths);
  const local = paths.map(path => path.map(p => ({ x: p.x - origin.x, y: p.y - origin.y })));
  return operation(local).map(p => ({ x: p.x + origin.x, y: p.y + origin.y }));
}
