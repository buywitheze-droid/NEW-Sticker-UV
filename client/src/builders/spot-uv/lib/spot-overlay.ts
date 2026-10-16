/**
 * Shared spot-selection paint used by the designer preview, gangsheet
 * preview, and PDF trace. One pixel-in / pixel-out rule so the orange/teal
 * overlay is the same silhouette the download traces.
 */

export interface SpotOverlayRegion {
  id: number;
  spotWhite?: boolean;
  spotGloss?: boolean;
}

export interface SpotOverlayColor {
  rgb: { r: number; g: number; b: number };
  hex?: string;
  spotWhite?: boolean;
  spotGloss?: boolean;
  spotFluorY?: boolean;
  spotFluorM?: boolean;
  spotFluorG?: boolean;
  spotFluorOrange?: boolean;
  regions?: SpotOverlayRegion[];
  regionMap?: Int32Array;
}

export interface SpotPixelMapData {
  pixelMap: Int16Array;
  mapWidth: number;
  mapHeight: number;
}

export function isColorAllWhite(c: SpotOverlayColor): boolean {
  return c.regions && c.regions.length > 0 ? c.regions.every(r => r.spotWhite) : !!c.spotWhite;
}

export function isColorAllGloss(c: SpotOverlayColor): boolean {
  return c.regions && c.regions.length > 0 ? c.regions.every(r => r.spotGloss) : !!c.spotGloss;
}

export function hasAnySpotFlag(c: SpotOverlayColor): boolean {
  return !!(
    c.spotWhite || c.spotGloss ||
    c.spotFluorY || c.spotFluorM || c.spotFluorG || c.spotFluorOrange ||
    c.regions?.some(r => r.spotWhite || r.spotGloss)
  );
}

/** White / gloss flags for one pixel in pixelMap space (same rules as the on-canvas overlay). */
export function pixelSpotChannels(
  color: SpotOverlayColor,
  pixelIndex: number,
): { white: boolean; gloss: boolean } {
  const hasRegions = !!(color.regions && color.regions.length > 0);
  const hasPerRegionSpot = hasRegions && color.regions!.some(r => r.spotWhite || r.spotGloss);
  if (!color.spotWhite && !color.spotGloss && !hasPerRegionSpot) {
    return { white: false, gloss: false };
  }

  if (color.regionMap && hasRegions) {
    const regionId = color.regionMap[pixelIndex];
    if (regionId < 0) return { white: false, gloss: false };
    const region = color.regions!.find(r => r.id === regionId);
    if (!region) return { white: false, gloss: false };
    const anyExplicit = color.regions!.some(r => r.spotWhite !== undefined || r.spotGloss !== undefined);
    if (anyExplicit) {
      return { white: !!region.spotWhite, gloss: !!region.spotGloss };
    }
    return {
      white: !!(region.spotWhite ?? color.spotWhite),
      gloss: !!(region.spotGloss ?? color.spotGloss),
    };
  }

  return { white: !!color.spotWhite, gloss: !!color.spotGloss };
}

function overlayRgb(white: boolean, gloss: boolean): { r: number; g: number; b: number } | null {
  if (white && gloss) return { r: 234, g: 179, b: 8 };
  if (white) return { r: 249, g: 115, b: 22 };
  if (gloss) return { r: 20, g: 184, b: 166 };
  return null;
}

function paintFromSourceAlpha(
  out: Uint8ClampedArray,
  source: Uint8ClampedArray,
  rgb: { r: number; g: number; b: number },
): void {
  for (let i = 0, p = 0; i < source.length / 4; i++, p += 4) {
    if (source[p + 3] >= 1) {
      out[p] = rgb.r;
      out[p + 1] = rgb.g;
      out[p + 2] = rgb.b;
      out[p + 3] = 255;
    }
  }
}

function sampleSourcePixels(
  source: HTMLImageElement | HTMLCanvasElement,
  w: number,
  h: number,
): Uint8ClampedArray | null {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(source, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
}

/**
 * Paints the same orange / teal / yellow overlay the designer shows.
 * Returns null when nothing is tagged.
 */
export function createSpotOverlayCanvas(
  source: HTMLImageElement | HTMLCanvasElement,
  colors: SpotOverlayColor[],
  pixelMap?: SpotPixelMapData,
  skipChannels?: { white?: boolean; gloss?: boolean },
): HTMLCanvasElement | null {
  if (skipChannels?.white && skipChannels?.gloss) return null;
  const effective = skipChannels
    ? colors.map((color) => ({
        ...color,
        spotWhite: skipChannels.white ? false : color.spotWhite,
        spotGloss: skipChannels.gloss ? false : color.spotGloss,
        regions: color.regions?.map((region) => ({
          ...region,
          spotWhite: skipChannels.white ? false : region.spotWhite,
          spotGloss: skipChannels.gloss ? false : region.spotGloss,
        })),
      }))
    : colors;
  if (!effective.some(hasAnySpotFlag)) return null;
  colors = effective;

  const mapW = pixelMap?.mapWidth ?? 0;
  const mapH = pixelMap?.mapHeight ?? 0;
  const w = mapW || ('naturalWidth' in source ? source.naturalWidth : source.width) || source.width;
  const h = mapH || ('naturalHeight' in source ? source.naturalHeight : source.height) || source.height;
  if (w <= 0 || h <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const imageData = ctx.createImageData(w, h);
  const out = imageData.data;

  const allWhite = colors.length > 0 && colors.every(isColorAllWhite);
  const allGloss = colors.length > 0 && colors.every(isColorAllGloss);
  if (allWhite || allGloss) {
    const rgb = overlayRgb(allWhite, allGloss);
    const src = sampleSourcePixels(source, w, h);
    if (rgb && src) {
      paintFromSourceAlpha(out, src, rgb);
      ctx.putImageData(imageData, 0, 0);
      return canvas;
    }
  }

  const map = pixelMap?.pixelMap;
  if (map && map.length === w * h) {
    for (let i = 0; i < map.length; i++) {
      const ci = map[i];
      if (ci < 0 || ci >= colors.length) continue;
      const ch = pixelSpotChannels(colors[ci], i);
      const rgb = overlayRgb(ch.white, ch.gloss);
      if (!rgb) continue;
      const off = i * 4;
      out[off] = rgb.r;
      out[off + 1] = rgb.g;
      out[off + 2] = rgb.b;
      out[off + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  const src = sampleSourcePixels(source, w, h);
  if (!src) return null;
  const tol = 36;
  for (let idx = 0; idx < src.length; idx += 4) {
    if (src[idx + 3] < 128) continue;
    const r = src[idx], g = src[idx + 1], b = src[idx + 2];
    const pixelIndex = idx / 4;
    for (let ci = 0; ci < colors.length; ci++) {
      const c = colors[ci];
      if (!hasAnySpotFlag(c)) continue;
      if (Math.abs(r - c.rgb.r) > tol || Math.abs(g - c.rgb.g) > tol || Math.abs(b - c.rgb.b) > tol) continue;
      const ch = pixelSpotChannels(c, pixelIndex);
      const rgb = overlayRgb(ch.white, ch.gloss);
      if (!rgb) break;
      out[idx] = rgb.r;
      out[idx + 1] = rgb.g;
      out[idx + 2] = rgb.b;
      out[idx + 3] = 255;
      break;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export function overlayCacheKey(colors: SpotOverlayColor[], skipChannels?: { white?: boolean; gloss?: boolean }): string {
  const skip = `${skipChannels?.white ? 'W' : ''}${skipChannels?.gloss ? 'G' : ''}`;
  return skip + ':' + colors.map(c => {
    const regions = c.regions
      ? c.regions.map(r => `${r.spotWhite ? 'w' : ''}${r.spotGloss ? 'g' : ''}`).join('')
      : '';
    return `${c.hex ?? ''}:${c.spotWhite ? 'W' : ''}${c.spotGloss ? 'G' : ''}:${regions}`;
  }).join(',');
}
