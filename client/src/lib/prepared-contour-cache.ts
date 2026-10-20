/**
 * One prepared artwork per engine. Compare pixels, not ImageData identity:
 * worker messages clone buffers, and edits can keep the same file/URL.
 * Only vector geometry is retained by callers, never supersampled masks.
 */
export class PreparedContourCache {
  private entry?: { key: string; pixels: Uint8ClampedArray; value: unknown };
  readonly stats = { hits: 0, misses: 0 };

  clear() {
    this.entry = undefined;
    this.stats.hits = this.stats.misses = 0;
  }

  getOrCreate<T>(pixels: Uint8ClampedArray, key: string, build: () => T): T {
    const entry = this.entry;
    if (entry?.key === key && entry.pixels.length === pixels.length) {
      let equal = true;
      for (let i = 0; i < pixels.length; i++) {
        if (pixels[i] !== entry.pixels[i]) { equal = false; break; }
      }
      if (equal) {
        this.stats.hits++;
        return entry.value as T;
      }
    }
    this.stats.misses++;
    // Release the old artwork before allocating the next preparation.
    this.entry = undefined;
    const value = build();
    // Bound retained source memory; oversized direct callers still work.
    if (pixels.byteLength <= 64 * 1024 * 1024) {
      this.entry = { key, pixels: pixels.slice(), value };
    }
    return value;
  }
}
