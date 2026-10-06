/** Exact circular binary dilation via a separable squared Euclidean distance
 * transform. Linear in output pixels, rather than ink pixels × disk area. */
export function dilateDisk(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const w = width + radius * 2, h = height + radius * 2;
  const distances = new Int32Array(w * h);
  const infinity = 0x3fffffff;
  distances.fill(infinity);
  // Vertical distance to the closest ink pixel in each source column.
  for (let x = 0; x < width; x++) {
    let last = -h;
    for (let y = 0; y < h; y++) {
      if (y >= radius && y < height + radius && mask[(y - radius) * width + x] === 1) last = y;
      if (last >= 0) distances[y * w + x + radius] = (y - last) ** 2;
    }
    last = h * 2;
    for (let y = h - 1; y >= 0; y--) {
      if (y >= radius && y < height + radius && mask[(y - radius) * width + x] === 1) last = y;
      if (last < h) {
        const i = y * w + x + radius;
        distances[i] = Math.min(distances[i], (last - y) ** 2);
      }
    }
  }
  const result = new Uint8Array(w * h);
  const sites = new Int32Array(w);
  const boundaries = new Float64Array(w + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let k = -1;
    // Lower envelope of parabolas: f(q) + (x-q)^2.
    for (let q = 0; q < w; q++) {
      if (distances[row + q] === infinity) continue;
      let intersection = -Infinity;
      while (k >= 0) {
        const v = sites[k];
        intersection = (distances[row + q] + q * q - distances[row + v] - v * v) / (2 * (q - v));
        if (intersection > boundaries[k]) break;
        k--;
      }
      k++;
      sites[k] = q;
      boundaries[k] = k === 0 ? -Infinity : intersection;
      boundaries[k + 1] = Infinity;
    }
    if (k < 0) continue;
    let active = 0;
    for (let x = 0; x < w; x++) {
      while (active < k && boundaries[active + 1] < x) active++;
      const q = sites[active];
      if ((x - q) ** 2 + distances[row + q] <= radius * radius) result[row + x] = 1;
    }
  }
  return result;
}
