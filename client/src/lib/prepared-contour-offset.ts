import ClipperLib from 'js-clipper';

type Point = { x: number; y: number };
const SCALE = 100000;

/** Strip only redundant points: do not smooth away small artwork features. */
export function compactContour(path: Point[]): Point[] {
  return path.filter((b, i) => {
    const a = path[(i + path.length - 1) % path.length];
    const c = path[(i + 1) % path.length];
    const abx = b.x - a.x, aby = b.y - a.y;
    const bcx = c.x - b.x, bcy = c.y - b.y;
    return Math.abs(abx * bcy - aby * bcx) > 1e-9 ||
      abx * bcx + aby * bcy < 0;
  });
}

/**
 * Offset ALL retained components together. Never pick only the largest result:
 * disconnected artwork must reach the existing bridging/safety stage intact.
 * Round joins match disk dilation; Sharp controls subsequent smoothing, not
 * unbounded miter tips. The tolerance is in source pixels, not inches.
 */
export function offsetPreparedContours(paths: Point[][], radius: number): Point[][] {
  if (!Number.isFinite(radius) || radius < 0) throw new Error('Invalid contour offset');
  const input = paths.filter(p => p.length >= 3).map(path => {
    const p = path.map(q => ({ X: Math.round(q.x * SCALE), Y: Math.round(q.y * SCALE) }));
    if (ClipperLib.Clipper.Area(p) < 0) p.reverse();
    return p;
  });
  if (!input.length) throw new Error('No prepared artwork boundaries');
  const offset = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
  offset.AddPaths(input, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const result: Array<Array<{ X: number; Y: number }>> = [];
  offset.Execute(result, radius * SCALE);
  const outer = result.filter(p => p.length >= 3 && ClipperLib.Clipper.Area(p) > 0);
  if (!outer.length) throw new Error('Unable to offset prepared artwork boundaries');
  return outer.map(path => path.map(p => ({ x: p.X / SCALE, y: p.Y / SCALE })));
}
