type Point = { x: number; y: number };

/**
 * Match cut-path inlets to the printed bleed without spending the size margin.
 * Called only for traced, non-zero-margin contours, before fitting/smoothing.
 */
export function closeContourInlets(
  points: Point[],
  radius: number,
  closeMerge: (points: Point[], radius: number) => Point[],
): Point[] {
  if (!(radius > 0) || points.length < 3) return points;

  const closedPath = closeMerge(points, radius);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  // Round joins may overshoot by a fraction of a pixel. Check each side,
  // not just width/height: a translated contour must not pass this guard.
  const slack = 0.75;
  const staysInsideEnvelope = closedPath.every(p =>
    p.x >= minX - slack && p.x <= maxX + slack &&
    p.y >= minY - slack && p.y <= maxY + slack
  );
  if (closedPath.length < 3 || !staysInsideEnvelope) {
    console.log('[Worker] Inlet closing rejected, keeping traced contour');
    return points;
  }

  const result = closedPath.map(p => ({
    x: Math.min(maxX, Math.max(minX, p.x)),
    y: Math.min(maxY, Math.max(minY, p.y)),
  }));
  console.log('[Worker] Inlet closing applied at', radius, 'px:', result.length, 'points');
  return result;
}