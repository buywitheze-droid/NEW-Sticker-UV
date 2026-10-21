/**
 * Four-connected labels for boundary tracing (NOT the eight-connected
 * artwork-selection labels). Mark on enqueue so each pixel enters once.
 * A single typed queue is reused across components, avoiding millions of
 * temporary coordinate objects and duplicate stack entries.
 */
export function labelContourPixels(mask: Uint8Array, width: number, height: number) {
  if (width <= 0 || height <= 0 || !Number.isInteger(width) ||
      !Number.isInteger(height) || mask.length !== width * height) {
    throw new Error('Invalid contour mask dimensions');
  }
  const labels = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  let count = 0;
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || labels[start] !== 0) continue;
    const id = ++count;
    let head = 0, tail = 1;
    queue[0] = start;
    labels[start] = id;
    while (head < tail) {
      const i = queue[head++];
      const x = i % width;
      // Bounds checks must precede neighbor access, especially at row wraps.
      if (x + 1 < width && mask[i + 1] === 1 && labels[i + 1] === 0) {
        labels[i + 1] = id; queue[tail++] = i + 1;
      }
      if (x > 0 && mask[i - 1] === 1 && labels[i - 1] === 0) {
        labels[i - 1] = id; queue[tail++] = i - 1;
      }
      if (i + width < mask.length && mask[i + width] === 1 && labels[i + width] === 0) {
        labels[i + width] = id; queue[tail++] = i + width;
      }
      if (i >= width && mask[i - width] === 1 && labels[i - width] === 0) {
        labels[i - width] = id; queue[tail++] = i - width;
      }
    }
  }
  return { labels, count };
}
