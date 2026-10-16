import { overlayInkBox, overlayPathsToPolylines, type OverlayPath } from "./imported-overlay";

export interface OverlayMaskGrid {
  width: number;
  height: number;
  cell: number;
  originX: number;
  originY: number;
  fill: Uint8Array;
  edge: Uint8Array;
}

export function rasterizeOverlayMask(
  paths: OverlayPath[],
  scale: number,
  offsetX: number,
  offsetY: number,
  grid: { width: number; height: number; cell: number; originX: number; originY: number },
): OverlayMaskGrid {
  const fill = new Uint8Array(grid.width * grid.height);
  const polylines = overlayPathsToPolylines(paths, 5);
  for (const raw of polylines) {
    if (raw.length < 3) continue;
    const pts = raw.map((point) => ({
      x: (point.x * scale + offsetX - grid.originX) / grid.cell,
      y: (point.y * scale + offsetY - grid.originY) / grid.cell,
    }));
    fillEvenOdd(fill, grid.width, grid.height, pts);
  }
  return {
    width: grid.width,
    height: grid.height,
    cell: grid.cell,
    originX: grid.originX,
    originY: grid.originY,
    fill,
    edge: edgeFromFill(fill, grid.width, grid.height),
  };
}

function fillEvenOdd(
  mask: Uint8Array,
  width: number,
  height: number,
  pts: Array<{ x: number; y: number }>,
) {
  const minY = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...pts.map((p) => p.y))));
  for (let y = minY; y <= maxY; y++) {
    const ys = y + 0.5;
    const hits: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if ((a.y <= ys && b.y > ys) || (b.y <= ys && a.y > ys)) {
        const t = (ys - a.y) / Math.max(b.y - a.y, 1e-9);
        hits.push(a.x + t * (b.x - a.x));
      }
    }
    hits.sort((l, r) => l - r);
    for (let i = 0; i + 1 < hits.length; i += 2) {
      const x0 = Math.max(0, Math.floor(hits[i]));
      const x1 = Math.min(width - 1, Math.ceil(hits[i + 1]));
      const row = y * width;
      for (let x = x0; x <= x1; x++) mask[row + x] = 1;
    }
  }
}

function edgeFromFill(fill: Uint8Array, width: number, height: number): Uint8Array {
  const edge = new Uint8Array(fill.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!fill[i]) continue;
      if (
        x === 0 || y === 0 || x === width - 1 || y === height - 1
        || !fill[i - 1] || !fill[i + 1] || !fill[i - width] || !fill[i + width]
      ) {
        edge[i] = 1;
      }
    }
  }
  return edge;
}

function scoreAlignment(spot: OverlayMaskGrid, reference: OverlayMaskGrid, shiftX: number, shiftY: number): number {
  let inter = 0;
  let spotArea = 0;
  let refArea = 0;
  let edgeHit = 0;
  let edgeCount = 0;
  for (let y = 0; y < reference.height; y++) {
    const sy = y - shiftY;
    if (sy < 0 || sy >= spot.height) continue;
    for (let x = 0; x < reference.width; x++) {
      const i = y * reference.width + x;
      if (reference.fill[i]) refArea += 1;
      const sx = x - shiftX;
      if (sx < 0 || sx >= spot.width) continue;
      const si = sy * spot.width + sx;
      if (spot.fill[si]) {
        spotArea += 1;
        if (reference.fill[i]) inter += 1;
      }
      if (spot.edge[si]) {
        edgeCount += 1;
        if (nearEdge(reference.edge, reference.width, reference.height, x, y, 2)) edgeHit += 1;
      }
    }
  }
  const union = spotArea + refArea - inter;
  const iou = union > 0 ? inter / union : 0;
  const inside = spotArea > 0 ? inter / spotArea : 0;
  const edges = edgeCount > 0 ? edgeHit / edgeCount : 0;
  return iou * 2 + inside + edges;
}

function nearEdge(edge: Uint8Array, width: number, height: number, x: number, y: number, radius: number): boolean {
  for (let dy = -radius; dy <= radius; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= width) continue;
      if (edge[yy * width + xx]) return true;
    }
  }
  return false;
}

export function bestSpotTranslation(
  spotPaths: OverlayPath[],
  spotScale: number,
  seedOffsetX: number,
  seedOffsetY: number,
  referencePaths: OverlayPath[],
  referenceScale: number,
  referenceOffsetX: number,
  referenceOffsetY: number,
): { offsetXInches: number; offsetYInches: number; score: number } {
  const refBox = overlayInkBox(referencePaths);
  const pageW = Math.max(refBox?.maxX ?? 1, 1) * referenceScale + Math.abs(referenceOffsetX) + 0.4;
  const pageH = Math.max(refBox?.maxY ?? 1, 1) * referenceScale + Math.abs(referenceOffsetY) + 0.4;
  const cell = Math.max(0.012, Math.min(pageW, pageH) / 90);
  const grid = {
    width: Math.max(24, Math.ceil((pageW + 0.5) / cell)),
    height: Math.max(24, Math.ceil((pageH + 0.5) / cell)),
    cell,
    originX: Math.min(0, referenceOffsetX) - 0.25,
    originY: Math.min(0, referenceOffsetY) - 0.25,
  };
  const reference = rasterizeOverlayMask(referencePaths, referenceScale, referenceOffsetX, referenceOffsetY, grid);
  const spot = rasterizeOverlayMask(spotPaths, spotScale, 0, 0, grid);

  let best = { offsetXInches: seedOffsetX, offsetYInches: seedOffsetY, score: -Infinity };
  const consider = (ox: number, oy: number) => {
    const shiftX = Math.round(ox / cell);
    const shiftY = Math.round(oy / cell);
    const score = scoreAlignment(spot, reference, shiftX, shiftY);
    if (score > best.score + 1e-6) best = { offsetXInches: ox, offsetYInches: oy, score };
  };

  consider(seedOffsetX, seedOffsetY);
  consider(referenceOffsetX, referenceOffsetY);
  const spotBox = overlayInkBox(spotPaths);
  if (refBox && spotBox) {
    consider(
      referenceOffsetX + (refBox.minX * referenceScale - spotBox.minX * spotScale),
      referenceOffsetY + (refBox.minY * referenceScale - spotBox.minY * spotScale),
    );
    consider(
      referenceOffsetX + ((refBox.minX + refBox.width / 2) * referenceScale - (spotBox.minX + spotBox.width / 2) * spotScale),
      referenceOffsetY + ((refBox.minY + refBox.height / 2) * referenceScale - (spotBox.minY + spotBox.height / 2) * spotScale),
    );
  }
  const coarse = 0.02;
  for (let dy = -0.22; dy <= 0.22; dy += coarse) {
    for (let dx = -0.22; dx <= 0.22; dx += coarse) {
      consider(seedOffsetX + dx, seedOffsetY + dy);
    }
  }
  const fine = 0.004;
  const fineOriginX = best.offsetXInches;
  const fineOriginY = best.offsetYInches;
  for (let dy = -0.024; dy <= 0.024; dy += fine) {
    for (let dx = -0.024; dx <= 0.024; dx += fine) {
      consider(fineOriginX + dx, fineOriginY + dy);
    }
  }
  return best;
}

export function buildPrintMaskFromAlpha(
  alpha: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  destWidthInches: number,
  destHeightInches: number,
): OverlayMaskGrid {
  const cell = Math.max(0.012, Math.min(destWidthInches, destHeightInches) / 90);
  const width = Math.max(24, Math.ceil(destWidthInches / cell));
  const height = Math.max(24, Math.ceil(destHeightInches / cell));
  const fill = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const srcY = Math.min(imageHeight - 1, Math.floor((y + 0.5) * imageHeight / height));
    for (let x = 0; x < width; x++) {
      const srcX = Math.min(imageWidth - 1, Math.floor((x + 0.5) * imageWidth / width));
      if (alpha[srcY * imageWidth + srcX]) fill[y * width + x] = 1;
    }
  }
  return {
    width,
    height,
    cell,
    originX: 0,
    originY: 0,
    fill,
    edge: edgeFromFill(fill, width, height),
  };
}

export function bestSpotTranslationAgainstMask(
  spotPaths: OverlayPath[],
  spotScale: number,
  seedOffsetX: number,
  seedOffsetY: number,
  reference: OverlayMaskGrid,
): { offsetXInches: number; offsetYInches: number; score: number } {
  const spot = rasterizeOverlayMask(spotPaths, spotScale, 0, 0, reference);
  let best = { offsetXInches: seedOffsetX, offsetYInches: seedOffsetY, score: -Infinity };
  const consider = (ox: number, oy: number) => {
    const shiftX = Math.round((ox - reference.originX) / reference.cell);
    const shiftY = Math.round((oy - reference.originY) / reference.cell);
    const score = scoreAlignment(spot, reference, shiftX, shiftY);
    if (score > best.score + 1e-6) best = { offsetXInches: ox, offsetYInches: oy, score };
  };
  consider(seedOffsetX, seedOffsetY);
  const coarse = 0.02;
  for (let dy = -0.28; dy <= 0.28; dy += coarse) {
    for (let dx = -0.28; dx <= 0.28; dx += coarse) {
      consider(seedOffsetX + dx, seedOffsetY + dy);
    }
  }
  const fineX = best.offsetXInches;
  const fineY = best.offsetYInches;
  for (let dy = -0.024; dy <= 0.024; dy += 0.004) {
    for (let dx = -0.024; dx <= 0.024; dx += 0.004) {
      consider(fineX + dx, fineY + dy);
    }
  }
  return best;
}
