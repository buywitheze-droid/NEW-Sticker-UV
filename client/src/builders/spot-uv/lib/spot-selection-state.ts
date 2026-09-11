import type { ExtractedColor } from './color-extractor';

/**
 * Region detection enriches an already displayed palette. Its snapshot predates
 * user edits, so only geometry comes from the worker; live selections win.
 * Call only for the same extraction run (not across different artwork).
 */
export function mergeDetectedColorRegions(
  current: ExtractedColor[],
  detected: ExtractedColor[],
): ExtractedColor[] {
  return current.map((color, index) => {
    const geometry = detected[index];
    if (!geometry || geometry.hex !== color.hex) return color;
    const existingRegions = new Map(color.regions?.map(region => [region.id, region]));
    return {
      ...geometry,
      ...color,
      regionMap: geometry.regionMap,
      regions: geometry.regions?.map(region => {
        const existing = existingRegions.get(region.id);
        return {
          ...region,
          selected: existing?.selected ?? region.selected,
          spotWhite: existing?.spotWhite ?? color.spotWhite,
          spotGloss: existing?.spotGloss ?? color.spotGloss,
        };
      }) ?? color.regions,
    };
  });
}