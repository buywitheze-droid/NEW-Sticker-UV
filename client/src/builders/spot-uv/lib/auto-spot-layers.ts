import type { ColorRegion, ExtractedColor } from './color-extractor';

const MAX_PIXELS = 1_000_000;

export interface AutoSpotSettings {
  white: 'keep' | 'solid' | 'light' | 'dark' | 'clear';
  gloss: 'keep' | 'relief' | 'detail' | 'highlights' | 'clear';
  whiteThreshold: number;
  glossThreshold: number;
  invertGloss: boolean;
  regionCoverage: number;
}

export interface AutoSpotSelectionsInput {
  imageData: {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  };
  colors: ExtractedColor[];
  pixelMap: Int16Array;
  settings: AutoSpotSettings;
}

export interface AutoSpotSelections {
  colors: ExtractedColor[];
  whiteMask: Uint8ClampedArray;
  glossMask: Uint8ClampedArray;
  width: number;
  height: number;
  whitePixels: number;
  glossPixels: number;
}

type WhiteMode = AutoSpotSettings['white'];
type GlossMode = AutoSpotSettings['gloss'];
type Channel = 'spotWhite' | 'spotGloss';

interface RegionStats {
  total: number;
  whiteGuide: number;
  glossGuide: number;
}

interface ColorStats {
  total: number;
  whiteGuide: number;
  glossGuide: number;
}

interface DomainAtPixel {
  colorIndex: number;
  regionId: number | null;
}

function invalid(message: string): never {
  throw new Error(`Invalid auto spot layers input: ${message}`);
}

function validateMode(value: unknown, allowed: readonly string[], name: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    invalid(`${name} must be one of ${allowed.join(', ')}`);
  }
}

function validateUnitInterval(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${name} must be finite and in the range 0..1`);
  }
}

function validateInput(input: AutoSpotSelectionsInput): {
  width: number;
  height: number;
  pixelCount: number;
} {
  if (!input || typeof input !== 'object') invalid('input is required');

  const imageData = input.imageData;
  if (!imageData || typeof imageData !== 'object') invalid('imageData is required');
  if (!(imageData.data instanceof Uint8ClampedArray)) {
    invalid('imageData.data must be a Uint8ClampedArray');
  }

  const { width, height } = imageData;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    invalid('imageData width and height must be positive integers');
  }

  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount)) {
    invalid('image dimensions are too large');
  }
  if (pixelCount > MAX_PIXELS) {
    invalid(`image has ${pixelCount} pixels; the maximum is ${MAX_PIXELS} pixels`);
  }
  if (imageData.data.length !== pixelCount * 4) {
    invalid(`imageData.data length must be exactly ${pixelCount * 4} (RGBA)`);
  }

  if (!(input.pixelMap instanceof Int16Array)) {
    invalid('pixelMap must be an Int16Array');
  }
  if (input.pixelMap.length !== pixelCount) {
    invalid(`pixelMap length must be exactly ${pixelCount}`);
  }

  if (!Array.isArray(input.colors)) invalid('colors must be an array');
  if (!input.settings || typeof input.settings !== 'object') invalid('settings is required');
  validateMode(input.settings.white, ['keep', 'solid', 'light', 'dark', 'clear'], 'settings.white');
  validateMode(input.settings.gloss, ['keep', 'relief', 'detail', 'highlights', 'clear'], 'settings.gloss');
  validateUnitInterval(input.settings.whiteThreshold, 'settings.whiteThreshold');
  validateUnitInterval(input.settings.glossThreshold, 'settings.glossThreshold');
  validateUnitInterval(input.settings.regionCoverage, 'settings.regionCoverage');
  if (typeof input.settings.invertGloss !== 'boolean') {
    invalid('settings.invertGloss must be boolean');
  }

  input.colors.forEach((color, colorIndex) => {
    if (!color || typeof color !== 'object') invalid(`colors[${colorIndex}] must be an object`);
    if (!color.rgb || typeof color.rgb !== 'object') {
      invalid(`colors[${colorIndex}].rgb is required`);
    }
    for (const component of ['r', 'g', 'b'] as const) {
      const value = color.rgb[component];
      if (!Number.isFinite(value) || value < 0 || value > 255) {
        invalid(`colors[${colorIndex}].rgb.${component} must be finite and in the range 0..255`);
      }
    }

    if (color.regions !== undefined && !Array.isArray(color.regions)) {
      invalid(`colors[${colorIndex}].regions must be an array when present`);
    }
    const regions = color.regions ?? [];
    const ids = new Set<number>();
    regions.forEach((region, regionIndex) => {
      if (!region || typeof region !== 'object' || !Number.isSafeInteger(region.id)) {
        invalid(`colors[${colorIndex}].regions[${regionIndex}].id must be an integer`);
      }
      if (ids.has(region.id)) {
        invalid(`colors[${colorIndex}] has duplicate region id ${region.id}`);
      }
      ids.add(region.id);
    });

    if (color.regionMap !== undefined) {
      if (!(color.regionMap instanceof Int32Array)) {
        invalid(`colors[${colorIndex}].regionMap must be an Int32Array`);
      }
      if (color.regionMap.length !== pixelCount) {
        invalid(`colors[${colorIndex}].regionMap length must be exactly ${pixelCount}`);
      }
    }
  });

  for (let pixelIndex = 0; pixelIndex < input.pixelMap.length; pixelIndex++) {
    const colorIndex = input.pixelMap[pixelIndex];
    if (colorIndex !== -1 && (colorIndex < 0 || colorIndex >= input.colors.length)) {
      invalid(`pixelMap[${pixelIndex}] has invalid color index ${colorIndex}`);
    }
  }

  return { width, height, pixelCount };
}

function luminance(data: Uint8ClampedArray, pixelIndex: number): number {
  const offset = pixelIndex * 4;
  // Rec. 709 luma is useful for tonal separations and remains exactly
  // normalized for greyscale artwork.
  return (
    (0.2126 * data[offset] +
      0.7152 * data[offset + 1] +
      0.0722 * data[offset + 2]) / 255
  );
}

function buildLocalContrast(
  gray: Float64Array,
  visible: Uint8Array,
  width: number,
  height: number,
): Float64Array {
  const contrast = new Float64Array(gray.length);

  for (let index = 0; index < gray.length; index++) {
    if (!visible[index]) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    let strongest = 0;
    // Transparency is not black artwork. Do not manufacture an edge at an
    // alpha boundary, and do not let transparent pixels affect the guide.
    if (x > 0 && visible[index - 1]) {
      strongest = Math.max(strongest, Math.abs(gray[index] - gray[index - 1]));
    }
    if (x + 1 < width && visible[index + 1]) {
      strongest = Math.max(strongest, Math.abs(gray[index] - gray[index + 1]));
    }
    if (y > 0 && visible[index - width]) {
      strongest = Math.max(strongest, Math.abs(gray[index] - gray[index - width]));
    }
    if (y + 1 < height && visible[index + width]) {
      strongest = Math.max(strongest, Math.abs(gray[index] - gray[index + width]));
    }
    contrast[index] = strongest;
  }
  return contrast;
}

function guideForWhite(
  mode: WhiteMode,
  value: number,
  threshold: number,
): boolean {
  if (mode === 'solid') return true;
  if (mode === 'light') return value >= threshold;
  if (mode === 'dark') return value <= threshold;
  return false;
}

function guideForGloss(
  mode: GlossMode,
  gray: number,
  contrast: number,
  threshold: number,
  invert: boolean,
): boolean {
  if (mode === 'relief' || mode === 'highlights') {
    const guide = invert ? 1 - gray : gray;
    return guide >= threshold;
  }
  if (mode === 'detail') {
    const guide = invert ? 1 - contrast : contrast;
    return guide >= threshold;
  }
  return false;
}

function qualifies(total: number, positive: number, coverage: number): boolean {
  // A domain with no mapped visible pixels is never a selected domain, even
  // when coverage is zero. This is what keeps missing region IDs harmless.
  return total > 0 && positive >= total * coverage;
}

function isExplicitlyRegionSelected(
  color: ExtractedColor,
  region: ColorRegion,
  channel: Channel,
): boolean {
  const regions = color.regions ?? [];
  const anyExplicit = regions.some(r => r.spotWhite !== undefined || r.spotGloss !== undefined);
  if (anyExplicit) return !!region[channel];
  return !!(region[channel] ?? color[channel]);
}

function effectiveRegionFlag(
  color: ExtractedColor,
  region: ColorRegion,
  channel: Channel,
): boolean {
  return isExplicitlyRegionSelected(color, region, channel);
}

function keepColorFlag(
  color: ExtractedColor,
  channel: Channel,
): boolean {
  const regions = color.regions;
  if (!regions || regions.length === 0) return !!color[channel];
  return regions.some(region => effectiveRegionFlag(color, region, channel));
}

function allTagged(
  colors: ExtractedColor[],
  channel: Channel,
): boolean {
  return colors.length > 0 && colors.every(color => {
    if (color.regions && color.regions.length > 0) {
      // This intentionally mirrors isColorAllWhite/isColorAllGloss used by
      // the exporter: an all-tagged region layer is allowed to use the source
      // alpha silhouette, including pixels not present in a region map.
      return color.regions.every(region => !!region[channel]);
    }
    return !!color[channel];
  });
}

function hasRegions(color: ExtractedColor): boolean {
  return !!(color.regions && color.regions.length > 0);
}

/**
 * Selects existing color/connected-region domains for white and gloss spot
 * layers. The operation is deliberately pure: all source objects and typed
 * arrays are treated as read-only, while the returned color and region
 * records are shallow copies with updated spot flags.
 */
export function generateAutoSpotSelections(
  input: AutoSpotSelectionsInput,
): AutoSpotSelections {
  const { width, height, pixelCount } = validateInput(input);
  const { imageData, colors, pixelMap, settings } = input;

  const visible = new Uint8Array(pixelCount);
  const gray = new Float64Array(pixelCount);
  for (let index = 0; index < pixelCount; index++) {
    const alpha = imageData.data[index * 4 + 3];
    if (alpha < 1) continue;
    visible[index] = 1;
    gray[index] = luminance(imageData.data, index);
  }

  const contrast = settings.gloss === 'detail'
    ? buildLocalContrast(gray, visible, width, height)
    : new Float64Array(pixelCount);
  const whiteGuide = new Uint8Array(pixelCount);
  const glossGuide = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index++) {
    if (!visible[index]) continue;
    if (settings.white !== 'keep' && settings.white !== 'clear') {
      if (guideForWhite(settings.white, gray[index], settings.whiteThreshold)) {
        whiteGuide[index] = 1;
      }
    }
    if (settings.gloss !== 'keep' && settings.gloss !== 'clear') {
      if (guideForGloss(
        settings.gloss,
        gray[index],
        contrast[index],
        settings.glossThreshold,
        settings.invertGloss,
      )) {
        glossGuide[index] = 1;
      }
    }
  }

  const colorStats: ColorStats[] = colors.map(() => ({
    total: 0,
    whiteGuide: 0,
    glossGuide: 0,
  }));
  const regionLookup = colors.map(color => new Map(
    (color.regions ?? []).map(region => [region.id, region] as const),
  ));
  const regionStats = colors.map(() => new Map<number, RegionStats>());
  const domains: Array<DomainAtPixel | null> = new Array(pixelCount).fill(null);

  for (let index = 0; index < pixelCount; index++) {
    if (!visible[index]) continue;
    const colorIndex = pixelMap[index];
    if (colorIndex < 0) continue;

    const color = colors[colorIndex];
    if (hasRegions(color)) {
      // A color with regions is never silently downgraded to a whole-color
      // selection. Unknown and orphan region IDs remain outside every domain.
      const regionId = color.regionMap?.[index];
      if (regionId === undefined || regionId < 0) continue;
      const region = regionLookup[colorIndex].get(regionId);
      if (!region) continue;
      domains[index] = { colorIndex, regionId };
      const stats = regionStats[colorIndex].get(regionId) ?? {
        total: 0,
        whiteGuide: 0,
        glossGuide: 0,
      };
      stats.total++;
      stats.whiteGuide += whiteGuide[index];
      stats.glossGuide += glossGuide[index];
      regionStats[colorIndex].set(regionId, stats);
    } else {
      domains[index] = { colorIndex, regionId: null };
      const stats = colorStats[colorIndex];
      stats.total++;
      stats.whiteGuide += whiteGuide[index];
      stats.glossGuide += glossGuide[index];
    }
  }

  const selectedColorWhite = colorStats.map(stats =>
    qualifies(stats.total, stats.whiteGuide, settings.regionCoverage)
  );
  const selectedColorGloss = colorStats.map(stats =>
    qualifies(stats.total, stats.glossGuide, settings.regionCoverage)
  );
  const selectedRegionWhite = colors.map((color, colorIndex) => {
    const selections = new Map<number, boolean>();
    for (const region of color.regions ?? []) {
      const stats = regionStats[colorIndex].get(region.id);
      selections.set(
        region.id,
        qualifies(stats?.total ?? 0, stats?.whiteGuide ?? 0, settings.regionCoverage),
      );
    }
    return selections;
  });
  const selectedRegionGloss = colors.map((color, colorIndex) => {
    const selections = new Map<number, boolean>();
    for (const region of color.regions ?? []) {
      const stats = regionStats[colorIndex].get(region.id);
      selections.set(
        region.id,
        qualifies(stats?.total ?? 0, stats?.glossGuide ?? 0, settings.regionCoverage),
      );
    }
    return selections;
  });

  const selectedForGeneratedMode = (
    channel: Channel,
    colorIndex: number,
    regionId: number | null,
  ): boolean => {
    const mode = channel === 'spotWhite' ? settings.white : settings.gloss;
    if (mode === 'clear') return false;
    if (mode === 'keep') {
      const color = colors[colorIndex];
      if (regionId === null || !hasRegions(color)) return !!color[channel];
      const region = regionLookup[colorIndex].get(regionId);
      return !!region && isExplicitlyRegionSelected(color, region, channel);
    }
    if (regionId === null) {
      return channel === 'spotWhite'
        ? selectedColorWhite[colorIndex]
        : selectedColorGloss[colorIndex];
    }
    return channel === 'spotWhite'
      ? selectedRegionWhite[colorIndex].get(regionId) === true
      : selectedRegionGloss[colorIndex].get(regionId) === true;
  };

  const outputColors = colors.map((color, colorIndex) => {
    const regions = color.regions;
    const copiedRegions = regions?.map(region => {
      const copied: ColorRegion = { ...region };
      if (settings.white === 'clear') {
        copied.spotWhite = false;
      } else if (settings.white !== 'keep' && regions && regions.length > 0) {
        copied.spotWhite = selectedRegionWhite[colorIndex].get(region.id) === true;
      }
      if (settings.gloss === 'clear') {
        copied.spotGloss = false;
      } else if (settings.gloss !== 'keep' && regions && regions.length > 0) {
        copied.spotGloss = selectedRegionGloss[colorIndex].get(region.id) === true;
      }
      return copied;
    });

    const next: ExtractedColor = {
      ...color,
      ...(regions === undefined ? {} : { regions: copiedRegions }),
    };

    if (settings.white === 'clear') {
      next.spotWhite = false;
    } else if (settings.white === 'keep') {
      next.spotWhite = keepColorFlag(color, 'spotWhite');
    } else if (regions && regions.length > 0) {
      next.spotWhite = copiedRegions!.some(region => !!region.spotWhite);
    } else {
      next.spotWhite = selectedColorWhite[colorIndex];
    }

    if (settings.gloss === 'clear') {
      next.spotGloss = false;
    } else if (settings.gloss === 'keep') {
      next.spotGloss = keepColorFlag(color, 'spotGloss');
    } else if (regions && regions.length > 0) {
      next.spotGloss = copiedRegions!.some(region => !!region.spotGloss);
    } else {
      next.spotGloss = selectedColorGloss[colorIndex];
    }
    return next;
  });

  const whiteMask = new Uint8ClampedArray(pixelCount);
  const glossMask = new Uint8ClampedArray(pixelCount);
  const useFullWhiteAlpha = allTagged(outputColors, 'spotWhite');
  const useFullGlossAlpha = allTagged(outputColors, 'spotGloss');

  for (let index = 0; index < pixelCount; index++) {
    if (!visible[index]) continue;
    const domain = domains[index];
    if (useFullWhiteAlpha || (
      domain !== null &&
      selectedForGeneratedMode('spotWhite', domain.colorIndex, domain.regionId)
    )) {
      whiteMask[index] = 255;
    }
    if (useFullGlossAlpha || (
      domain !== null &&
      selectedForGeneratedMode('spotGloss', domain.colorIndex, domain.regionId)
    )) {
      glossMask[index] = 255;
    }
  }

  let whitePixels = 0;
  let glossPixels = 0;
  for (let index = 0; index < pixelCount; index++) {
    if (whiteMask[index] === 255) whitePixels++;
    if (glossMask[index] === 255) glossPixels++;
  }

  return {
    colors: outputColors,
    whiteMask,
    glossMask,
    width,
    height,
    whitePixels,
    glossPixels,
  };
}