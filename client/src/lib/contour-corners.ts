export type CornerStyle = 'sharp' | 'balanced' | 'rounded';
type Point = { x: number; y: number };

/** Post-offset smoothing only: never changes the requested physical margin.
 * Protect deliberate turns measured over a physical neighborhood, rather than
 * mistaking individual raster stair steps for intentional corners. */
export function smoothContourCorners(points: Point[], style: CornerStyle, dpi: number): Point[] {
  if (points.length < 3 || style === 'sharp') return points;
  const protectedPoints = new Set<Point>();
  if (style === 'balanced') {
    const reach = Math.max(1, dpi * 0.025);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const neighbor = (direction: number) => {
        let distance = 0, index = i;
        for (let count = 0; count < points.length - 1 && distance < reach; count++) {
          const next = (index + direction + points.length) % points.length;
          distance += Math.hypot(points[next].x - points[index].x, points[next].y - points[index].y);
          index = next;
        }
        return points[index];
      };
      const a = neighbor(-1), b = neighbor(1);
      const ux = p.x - a.x, uy = p.y - a.y, vx = b.x - p.x, vy = b.y - p.y;
      const length = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      // Protect turns of at least 35 degrees, including inward notches.
      if (length > 0 && (ux * vx + uy * vy) / length < Math.cos(35 * Math.PI / 180)) protectedPoints.add(p);
    }
  }
  let path = points;
  for (let iteration = 0; iteration < (style === 'rounded' ? 3 : 1); iteration++) {
    const next: Point[] = [];
    for (let i = 0; i < path.length; i++) {
      const p = path[i], before = path[(i + path.length - 1) % path.length], after = path[(i + 1) % path.length];
      if (protectedPoints.has(p)) next.push(p);
      else {
        next.push({ x: 0.75 * p.x + 0.25 * before.x, y: 0.75 * p.y + 0.25 * before.y });
        next.push({ x: 0.75 * p.x + 0.25 * after.x, y: 0.75 * p.y + 0.25 * after.y });
      }
    }
    path = next;
  }
  return path;
}
