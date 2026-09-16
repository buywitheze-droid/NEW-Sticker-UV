import { PDFDocument, PDFName, PDFDict, PDFArray } from 'pdf-lib';
import {
  contourPointsToPDFPathOps,
  bezierPathToPDFPathOps,
  type CachedContourData,
  type SpotColorInput,
} from './contour-outline';
import type { BezierPath } from './contour-worker-manager';
import type { ResizeSettings, StrokeSettings, ShapeSettings } from './types';
import { renderImageWithCrispQRs } from './qr';
import { addGangSheetSpotColorsToPDF, type SpotPixelMapData } from './spot-color-vectors';
import { runArrange } from '@/lib/arrange-core';
import { planLadderJump } from '@/lib/sheet-fit';

const MAX_CANVAS_DIM = 16384;
const MAX_CANVAS_PIXELS = 268_435_456; // ~16384²; Chrome's hard limit

function clampCanvasDims(w: number, h: number): { w: number; h: number; scale: number } {
  let scale = 1;
  if (w > MAX_CANVAS_DIM) { scale = MAX_CANVAS_DIM / w; }
  if (h * scale > MAX_CANVAS_DIM) { scale = MAX_CANVAS_DIM / h; }
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);
  if (cw * ch > MAX_CANVAS_PIXELS) {
    const pixelScale = Math.sqrt(MAX_CANVAS_PIXELS / (cw * ch));
    return { w: Math.round(cw * pixelScale), h: Math.round(ch * pixelScale), scale: scale * pixelScale };
  }
  return { w: cw, h: ch, scale };
}

// ─── Types ───

export interface GangSheetItem {
  id: string;
  thumbnail: string;
  imageElement: HTMLImageElement;
  contourData: CachedContourData;
  resizeSettings: ResizeSettings;
  strokeSettings: StrokeSettings;
  shapeSettings?: ShapeSettings;
  cutContourLabel: string;
  /**
   * When true, this item should be placed and printed without any cut
   * path drawn (no magenta CutContour line in the PDF). Used for clients
   * who only want the spot color separations + design — no cutting.
   * The contourData still holds a rectangular bounding box so packing
   * and placement work normally.
   */
  noCutPath?: boolean;
  quantity: number;
  /**
   * QR codes detected in `imageElement` (in source pixel coords).
   * The PDF rasteriser uses this to replace QR regions with crisp re-renders
   * at the target print resolution so they survive aggressive downscaling
   * (a 1000px QR scaled to 200px via Lanczos becomes unscannable).
   * Empty array / undefined = no QRs / detection still pending → skip pass.
   */
  qrCodes?: import('./qr').DetectedQR[];
  /** User opt-IN for crisp re-render (default off — preserves source QR as-is). */
  qrRerenderEnabled?: boolean;
  /**
   * Snapshot of the design's spot color extraction at the moment it was
   * added to the gang sheet. When any of the spot flags (white / gloss /
   * fluorescent) are enabled, the gang sheet PDF export traces this design
   * and emits the matching vector spot color separations on every placement
   * — the same separations a single-design export would produce, just tiled.
   */
  spotColors?: SpotColorInput[];
  /** Pixel-exact selection map (matches the on-canvas overlay) for spot color tracing. */
  spotPixelMap?: SpotPixelMapData;
}

export interface GangSheetSettings {
  sheetWidth: number;
  sheetHeight: number;
  gap: number;
  edgePadding: number;
}

export interface PlacedItem {
  itemId: string;
  instanceIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotated?: boolean;
}

export interface PackResult {
  placements: PlacedItem[];
  overflow: number;
  utilization: number;
}

export interface GangSheetImageSize {
  w: number;
  h: number;
  isShapeMode: boolean;
}

/** Artwork size in unrotated item inches — same formula as the PDF design draw. */
export function getGangSheetImageSizeInches(item: GangSheetItem): GangSheetImageSize {
  const imgNatW = item.imageElement.naturalWidth || item.imageElement.width;
  const imgNatH = item.imageElement.naturalHeight || item.imageElement.height;
  const isShapeMode = !!item.shapeSettings?.enabled
    || (item.contourData.minPathX === 0 && item.contourData.minPathY === 0
      && item.contourData.effectiveDPI === 300);
  if (isShapeMode) {
    return { w: item.resizeSettings.widthInches, h: item.resizeSettings.heightInches, isShapeMode };
  }
  const safeNatH = imgNatH || 1;
  const safeResH = item.resizeSettings.heightInches || 1;
  const natAR = imgNatW / safeNatH;
  const resAR = item.resizeSettings.widthInches / safeResH;
  if (natAR <= resAR) {
    return {
      w: item.resizeSettings.widthInches,
      h: natAR > 0 ? item.resizeSettings.widthInches / natAR : item.resizeSettings.heightInches,
      isShapeMode,
    };
  }
  return {
    w: item.resizeSettings.heightInches * natAR,
    h: item.resizeSettings.heightInches,
    isShapeMode,
  };
}

/**
 * Design image rectangle in sheet inches, top-left origin (preview Y-down).
 * Matches the PDF `imgXPts` / `imgYPts` placement including rotation + contour offsets.
 */
export function getGangSheetImageRectInches(
  item: GangSheetItem,
  placement: Pick<PlacedItem, "x" | "y" | "rotated">,
): { x: number; y: number; w: number; h: number } {
  const size = getGangSheetImageSizeInches(item);
  const ox = item.contourData.imageOffsetX || 0;
  const oy = item.contourData.imageOffsetY || 0;
  if (placement.rotated) {
    return { x: placement.x + oy, y: placement.y + ox, w: size.h, h: size.w };
  }
  return { x: placement.x + ox, y: placement.y + oy, w: size.w, h: size.h };
}

/** Contour point → sheet inches, top-left origin. Same affine as PDF `remapPathToSheet`. */
export function mapContourPointToSheetTopLeft(
  pt: { x: number; y: number },
  itemWidthInches: number,
  itemHeightInches: number,
  placementX: number,
  placementY: number,
  rotated: boolean,
  isShape: boolean,
): { x: number; y: number } {
  if (rotated) {
    if (isShape) {
      return { x: placementX + pt.y, y: placementY + (itemWidthInches - pt.x) };
    }
    return { x: placementX + (itemHeightInches - pt.y), y: placementY + (itemWidthInches - pt.x) };
  }
  return {
    x: placementX + pt.x,
    y: placementY + (isShape ? pt.y : itemHeightInches - pt.y),
  };
}

/** Minimum space between cut-contour lines, matching AnyNest's default nest gap. */
export const MIN_CONTOUR_GAP = 0.25;

export const GANG_SHEET_PRESETS = Array.from({ length: (60 - 12) / 2 + 1 }, (_, i) => {
  const height = 12 + i * 2;
  return { label: `48 x ${height}`, width: 48, height };
});

export const DEFAULT_GANG_SHEET_SETTINGS: GangSheetSettings = {
  sheetWidth: 48,
  sheetHeight: 12,
  gap: MIN_CONTOUR_GAP,
  edgePadding: 0.25,
};

// ─── Bin packer ───
/** Hard cap so pathological quantities cannot freeze the tab (each copy is one pack entry). */
export const MAX_GANG_SHEET_USER_QUANTITY = 100_000;

/** Theoretical grid count for one w×h sticker on an empty sheet (upper bound for search / caps). */
function gridPlacementUpperBound(
  usableW: number,
  usableH: number,
  gap: number,
  w: number,
  h: number
): number {
  if (usableW <= 0 || usableH <= 0 || w <= 0 || h <= 0) return 0;
  const ew = w + gap;
  const eh = h + gap;
  const cols = Math.floor((usableW + gap) / ew);
  const rows = Math.floor((usableH + gap) / eh);
  return Math.max(0, cols * rows);
}

/** Clamp gang sheet line quantity to a safe integer (avoids string concat bugs from `<input type="number">`). */
export function clampGangSheetQuantity(q: unknown): number {
  const n = Math.floor(Number(q));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_GANG_SHEET_USER_QUANTITY);
}

function isQuarterTurn(rotation: number): boolean {
  const norm = ((rotation % 360) + 360) % 360;
  const steps = Math.round(norm / 90);
  return steps % 4 === 1 || steps % 4 === 3;
}

export function packGangSheet(
  items: GangSheetItem[],
  settings: GangSheetSettings
): PackResult {
  const { sheetWidth, sheetHeight, edgePadding } = settings;
  const gap = Math.max(MIN_CONTOUR_GAP, settings.gap);
  if (sheetWidth <= 0 || sheetHeight <= 0) {
    return { placements: [], overflow: 0, utilization: 0 };
  }
  const usableWidth = sheetWidth - edgePadding * 2;
  const usableHeight = sheetHeight - edgePadding * 2;
  if (usableWidth <= 0 || usableHeight <= 0) {
    return { placements: [], overflow: items.reduce((s, i) => s + clampGangSheetQuantity(i.quantity), 0), utilization: 0 };
  }

  const copies: Array<{
    id: string;
    itemId: string;
    instanceIndex: number;
    w: number;
    h: number;
  }> = [];

  for (const item of items) {
    const qty = clampGangSheetQuantity(item.quantity);
    const w = item.contourData.widthInches;
    const h = item.contourData.heightInches;
    if (!(w > 0) || !(h > 0)) continue;
    for (let i = 0; i < qty; i++) {
      copies.push({
        id: `${item.id}#${i}`,
        itemId: item.id,
        instanceIndex: i,
        w,
        h,
      });
    }
  }

  if (copies.length === 0) {
    return { placements: [], overflow: 0, utilization: 0 };
  }

  // Bounding-box pack only. Silhouette nesting lets concave / sparse contour
  // masks interlock so magenta cut paths sit on top of each other. Shop
  // gangsheets need a hard 0.25" gap between each sticker's full footprint.
  const arranged = runArrange({
    type: 'arrange',
    requestId: 0,
    items: copies.map((c) => ({
      id: c.id,
      w: c.w,
      h: c.h,
      fill: 1,
      duplicateKey: c.itemId,
    })),
    usableW: usableWidth,
    usableH: usableHeight,
    artboardWidth: usableWidth,
    artboardHeight: usableHeight,
    isAggressive: true,
    customGap: gap,
  });

  const byId = new Map(copies.map((c) => [c.id, c]));
  const placements: PlacedItem[] = [];
  let overflow = 0;
  for (const p of arranged.result) {
    const meta = byId.get(p.id);
    if (!meta) continue;
    if (p.overflows) {
      overflow++;
      continue;
    }
    const rotated = isQuarterTurn(p.rotation);
    const pw = rotated ? meta.h : meta.w;
    const ph = rotated ? meta.w : meta.h;
    placements.push({
      itemId: meta.itemId,
      instanceIndex: meta.instanceIndex,
      x: p.nx * usableWidth - pw / 2 + edgePadding,
      y: p.ny * usableHeight - ph / 2 + edgePadding,
      width: pw,
      height: ph,
      rotated,
    });
  }

  const totalArea = sheetWidth * sheetHeight;
  const usedArea = placements.reduce((sum, p) => sum + p.width * p.height, 0);
  const utilization = totalArea > 0 ? usedArea / totalArea : 0;

  return { placements, overflow, utilization };
}

/** Largest quantity for `itemId` that packs with zero overflow (others keep their current quantities). */
export function maxQuantityForItem(
  items: GangSheetItem[],
  settings: GangSheetSettings,
  itemId: string,
  hiCap: number = MAX_GANG_SHEET_USER_QUANTITY
): number {
  const { sheetWidth, sheetHeight, edgePadding } = settings;
  const gap = Math.max(MIN_CONTOUR_GAP, settings.gap);
  const usableW = sheetWidth - edgePadding * 2;
  const usableH = sheetHeight - edgePadding * 2;
  const target = items.find((i) => i.id === itemId);
  if (!target) return 1;
  const w0 = target.contourData.widthInches;
  const h0 = target.contourData.heightInches;
  const soloGrid = Math.max(
    gridPlacementUpperBound(usableW, usableH, gap, w0, h0),
    gridPlacementUpperBound(usableW, usableH, gap, h0, w0)
  );
  const sumOtherQty = items
    .filter((i) => i.id !== itemId)
    .reduce((s, i) => s + clampGangSheetQuantity(i.quantity), 0);
  const derivedHi = Math.max(1, soloGrid + sumOtherQty + 64);
  const mk = (q: number) =>
    items.map((i) => (i.id === itemId ? { ...i, quantity: q } : i));
  let lo = 1;
  let hi = Math.max(1, Math.min(hiCap, derivedHi, MAX_GANG_SHEET_USER_QUANTITY));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const pack = packGangSheet(mk(mid), settings);
    if (pack.overflow === 0) lo = mid;
    else hi = mid - 1;
  }
  while (lo > 1 && packGangSheet(mk(lo), settings).overflow > 0) lo--;
  return Math.max(1, lo);
}

export function gangSheetHeights(): number[] {
  return GANG_SHEET_PRESETS.map((p) => p.height);
}

/**
 * Grow sheet height along the 48×12 … 48×60 ladder (AnyNest `planLadderJump`)
 * until every requested copy packs with zero overflow, or the max height is reached.
 */
export function expandSettingsToFit(
  items: GangSheetItem[],
  settings: GangSheetSettings,
): { settings: GangSheetSettings; expanded: boolean; overflow: number } {
  let current: GangSheetSettings = { ...settings };
  let pack = packGangSheet(items, current);
  if (pack.overflow === 0) {
    return { settings: current, expanded: false, overflow: 0 };
  }

  const heights = gangSheetHeights();
  let expanded = false;
  for (let step = 0; step < heights.length && pack.overflow > 0; step++) {
    const nextH = planLadderJump({
      currentHeight: current.sheetHeight,
      minRequiredHeight: 0,
      heights,
    });
    if (nextH == null) break;
    current = { ...current, sheetHeight: nextH };
    expanded = true;
    pack = packGangSheet(items, current);
  }
  return { settings: current, expanded, overflow: pack.overflow };
}

// ─── Coordinate transform ───
// Each item's contourData.pathPoints are in local inches with Y flipped
// relative to that item's own page (heightInches). We need to remap
// them to the gang sheet's coordinate system.

function remapPathToSheet(
  localPath: Array<{ x: number; y: number }>,
  itemWidthInches: number,
  itemHeightInches: number,
  placementX: number,
  placementY: number,
  sheetHeightInches: number,
  rotated: boolean,
  isShape: boolean
): Array<{ x: number; y: number }> {
  return localPath.map(p => {
    const top = mapContourPointToSheetTopLeft(
      p, itemWidthInches, itemHeightInches, placementX, placementY, rotated, isShape
    );
    return { x: top.x, y: sheetHeightInches - top.y };
  });
}

// Remap a Bezier path the same way `remapPathToSheet` remaps a polyline:
// transform every anchor and every control point. Anchors and control points
// share the same coordinate space (item-local PDF inches), so the same affine
// transform applies. Used by the gang-sheet Zero Hero export so smooth curves
// survive the placement transform.
function remapBezierPathToSheet(
  bp: BezierPath,
  itemWidthInches: number,
  itemHeightInches: number,
  placementX: number,
  placementY: number,
  sheetHeightInches: number,
  rotated: boolean,
  isShape: boolean
): BezierPath {
  const tx = (p: { x: number; y: number }): { x: number; y: number } => {
    const top = mapContourPointToSheetTopLeft(
      p, itemWidthInches, itemHeightInches, placementX, placementY, rotated, isShape
    );
    return { x: top.x, y: sheetHeightInches - top.y };
  };
  return {
    start: tx(bp.start),
    segments: bp.segments.map(seg =>
      seg.type === 'line'
        ? { type: 'line', to: tx(seg.to) }
        : { type: 'cubic', cp1: tx(seg.cp1), cp2: tx(seg.cp2), to: tx(seg.to) }
    ),
    closed: true,
  };
}

// ─── Gang Sheet PDF Export ───

/** Export one saved design, without repacking or retracing its locked outline. */
export async function downloadGangSheetItemPDF(item: GangSheetItem): Promise<Blob> {
  const { widthInches: width, heightInches: height } = item.contourData;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("This design has invalid saved dimensions and cannot be downloaded.");
  }
  const safeId = item.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "sticker";
  return downloadGangSheetPDF(
    [{ ...item, quantity: 1 }],
    { sheetWidth: width, sheetHeight: height, gap: 0, edgePadding: 0 },
    [{ itemId: item.id, instanceIndex: 0, x: 0, y: 0, width, height, rotated: false }],
    { filename: `design_${safeId}_${width.toFixed(2)}x${height.toFixed(2)}.pdf`, singleDesign: true },
  );
}

// Also returns the generated Blob so a caller can persist it via "Save Gang Sheet" — same bytes.
export async function downloadGangSheetPDF(
  items: GangSheetItem[],
  settings: GangSheetSettings,
  placements: PlacedItem[],
  options: { filename?: string; singleDesign?: boolean } = {},
): Promise<Blob> {
  const { sheetWidth, sheetHeight } = settings;
  const widthPts = sheetWidth * 72;
  const heightPts = sheetHeight * 72;

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([widthPts, heightPts]);
  const context = pdfDoc.context;

  pdfDoc.setTitle(options.singleDesign ? 'Saved Design' : 'Gang Sheet');
  pdfDoc.setSubject(options.singleDesign
    ? 'Individual saved design with its original contour and print settings'
    : 'Gang sheet with multiple sticker designs and CutContour paths');

  const itemMap = new Map<string, GangSheetItem>();
  for (const item of items) itemMap.set(item.id, item);

  // --- Background fill (raster at 150 DPI) ---
  const bgDPI = 150;
  const rawBgW = Math.round(sheetWidth * bgDPI);
  const rawBgH = Math.round(sheetHeight * bgDPI);
  const bgClamped = clampCanvasDims(rawBgW, rawBgH);
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = bgClamped.w;
  bgCanvas.height = bgClamped.h;
  const bgCtx = bgCanvas.getContext('2d', { alpha: true });
  if (!bgCtx) throw new Error('Failed to create background canvas context');

  const effectiveBgDPI = bgDPI * bgClamped.scale;

  // Transparent sheet; only sticker fills/bleeds are painted (gaps stay clear in the PNG alpha).
  bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);

  for (const placement of placements) {
    const item = itemMap.get(placement.itemId);
    if (!item) continue;
    // Spot-color-only items: no shape fill / bleed background — just leave
    // the area transparent so the image (and its spot color separations)
    // are the only thing rendered.
    if (item.noCutPath) continue;
    const { contourData } = item;
    const fillColor = contourData.backgroundColor || '#ffffff';
    const bleedColor = item.shapeSettings?.bleedEnabled
      ? (item.shapeSettings.bleedColor || '#ffffff')
      : fillColor;
    const paths = contourData.allPathPoints && contourData.allPathPoints.length > 0
      ? contourData.allPathPoints
      : [contourData.pathPoints];

    const itemBleedInches = 0.10;
    bgCtx.lineJoin = 'round';
    bgCtx.lineCap = 'round';
    bgCtx.lineWidth = itemBleedInches * effectiveBgDPI * 2;

    const holeStart = contourData.holePathStartIndex;
    const outerPaths = holeStart != null ? paths.slice(0, holeStart) : paths;
    const holePaths = holeStart != null ? paths.slice(holeStart) : [];

    const isShapeFill = !!item.shapeSettings?.enabled;
    for (const path of outerPaths) {
      if (path.length === 0) continue;
      const sheetPath = remapPathToSheet(
        path, contourData.widthInches, contourData.heightInches,
        placement.x, placement.y, sheetHeight,
        !!placement.rotated, isShapeFill
      );

      // Draw bleed area first (stroke extends beyond cut line)
      if (bleedColor !== fillColor) {
        bgCtx.fillStyle = bleedColor;
        bgCtx.strokeStyle = bleedColor;
        bgCtx.beginPath();
        bgCtx.moveTo(sheetPath[0].x * effectiveBgDPI, sheetPath[0].y * effectiveBgDPI);
        for (let i = 1; i < sheetPath.length; i++) {
          bgCtx.lineTo(sheetPath[i].x * effectiveBgDPI, sheetPath[i].y * effectiveBgDPI);
        }
        bgCtx.closePath();
        bgCtx.stroke();
        bgCtx.fill();
      }

      // Draw fill area (inside cut line)
      bgCtx.fillStyle = fillColor;
      bgCtx.strokeStyle = fillColor;
      bgCtx.beginPath();
      bgCtx.moveTo(sheetPath[0].x * effectiveBgDPI, sheetPath[0].y * effectiveBgDPI);
      for (let i = 1; i < sheetPath.length; i++) {
        bgCtx.lineTo(sheetPath[i].x * effectiveBgDPI, sheetPath[i].y * effectiveBgDPI);
      }
      bgCtx.closePath();
      bgCtx.stroke();
      bgCtx.fill();
    }

    if (holePaths.length > 0) {
      bgCtx.save();
      bgCtx.globalCompositeOperation = 'destination-out';
      bgCtx.fillStyle = 'rgba(0,0,0,1)';
      for (const hp of holePaths) {
        if (hp.length === 0) continue;
        const sheetPath = remapPathToSheet(
          hp, contourData.widthInches, contourData.heightInches,
          placement.x, placement.y, sheetHeight,
          !!placement.rotated, isShapeFill
        );
        bgCtx.beginPath();
        bgCtx.moveTo(sheetPath[0].x * effectiveBgDPI, sheetPath[0].y * effectiveBgDPI);
        for (let i = 1; i < sheetPath.length; i++) {
          bgCtx.lineTo(sheetPath[i].x * effectiveBgDPI, sheetPath[i].y * effectiveBgDPI);
        }
        bgCtx.closePath();
        bgCtx.fill();
      }
      bgCtx.restore();
    }
  }

  // Flip background for PDF (canvas Y-down -> PDF Y-up)
  const flippedBg = document.createElement('canvas');
  flippedBg.width = bgCanvas.width;
  flippedBg.height = bgCanvas.height;
  const flippedCtx = flippedBg.getContext('2d', { alpha: true });
  if (!flippedCtx) throw new Error('Failed to create flipped background canvas context');
  flippedCtx.clearRect(0, 0, flippedBg.width, flippedBg.height);
  flippedCtx.translate(0, bgCanvas.height);
  flippedCtx.scale(1, -1);
  flippedCtx.drawImage(bgCanvas, 0, 0);

  const bgBlob = await new Promise<Blob>((resolve, reject) => {
    flippedBg.toBlob(b => b ? resolve(b) : reject(new Error('bg blob failed')), 'image/png');
  });
  const bgBytes = new Uint8Array(await bgBlob.arrayBuffer());
  const bgImage = await pdfDoc.embedPng(bgBytes);
  page.drawImage(bgImage, { x: 0, y: 0, width: widthPts, height: heightPts });

  // --- Design images (with shape clipping) ---
  const imageCache = new Map<string, Awaited<ReturnType<typeof pdfDoc.embedPng>>>();

  for (const placement of placements) {
    const item = itemMap.get(placement.itemId);
    if (!item) continue;

    const imgNatW = item.imageElement.naturalWidth || item.imageElement.width;
    const imgNatH = item.imageElement.naturalHeight || item.imageElement.height;

    let pdfImage = imageCache.get(item.id);
    if (!pdfImage) {
      const imgClamped = clampCanvasDims(imgNatW, imgNatH);
      // QR-safe rasterise: if the design has detected QRs and the user
      // hasn't opted out, replace each QR's pixel region with a freshly
      // rendered, integer-pixel-aligned QR at the destination scale.
      // Otherwise fall back to a plain drawImage. Same output shape either
      // way (a canvas at imgClamped.w × imgClamped.h).
      const useQRFix = item.qrRerenderEnabled === true && item.qrCodes && item.qrCodes.length > 0;
      const canvas = useQRFix
        ? await renderImageWithCrispQRs(item.imageElement, {
            destWidth: imgClamped.w,
            destHeight: imgClamped.h,
            qrCodes: item.qrCodes!,
          })
        : (() => {
            const c = document.createElement('canvas');
            c.width = imgClamped.w;
            c.height = imgClamped.h;
            const cx = c.getContext('2d');
            if (!cx) throw new Error(`Failed to create design canvas context for ${item.id}`);
            cx.drawImage(item.imageElement, 0, 0, imgClamped.w, imgClamped.h);
            return c;
          })();

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('design blob failed')), 'image/png');
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      pdfImage = await pdfDoc.embedPng(bytes);
      imageCache.set(item.id, pdfImage);
    }

    const imageSize = getGangSheetImageSizeInches(item);
    const imgWidthPts = imageSize.w * 72;
    const imgHeightPts = imageSize.h * 72;
    const isRotated = !!placement.rotated;

    let drawImgWidthPts = imgWidthPts;
    let drawImgHeightPts = imgHeightPts;
    let drawPdfImage = pdfImage;

    if (isRotated) {
      const rotKey = item.id + '_rot';
      let rotImg = imageCache.get(rotKey);
      if (!rotImg) {
        const rotCanvas = document.createElement('canvas');
        const rotClamped = clampCanvasDims(imgNatH, imgNatW);
        rotCanvas.width = rotClamped.w;
        rotCanvas.height = rotClamped.h;
        const rotCtx = rotCanvas.getContext('2d');
        if (rotCtx) {
          // QR-safe: rasterise the un-rotated design at full target resolution
          // first (with crisp QR overlays), then rotate that. Keeps the QR's
          // module grid integer-aligned in the un-rotated canvas before the
          // 90° turn — the rotation is exact (no resampling), so crispness
          // survives.
          const srcClamped = clampCanvasDims(imgNatW, imgNatH);
          const useQRFix = item.qrRerenderEnabled === true && item.qrCodes && item.qrCodes.length > 0;
          const sourceForRotation: CanvasImageSource = useQRFix
            ? await renderImageWithCrispQRs(item.imageElement, {
                destWidth: srcClamped.w,
                destHeight: srcClamped.h,
                qrCodes: item.qrCodes!,
              })
            : item.imageElement;
          rotCtx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
          rotCtx.rotate(-Math.PI / 2);
          rotCtx.drawImage(sourceForRotation, -srcClamped.w / 2, -srcClamped.h / 2, srcClamped.w, srcClamped.h);
          const rotBlob = await new Promise<Blob>((resolve, reject) => {
            rotCanvas.toBlob(b => b ? resolve(b) : reject(new Error('rot blob failed')), 'image/png');
          });
          const rotBytes = new Uint8Array(await rotBlob.arrayBuffer());
          rotImg = await pdfDoc.embedPng(rotBytes);
          imageCache.set(rotKey, rotImg);
        }
      }
      if (rotImg) {
        drawPdfImage = rotImg;
        drawImgWidthPts = imgHeightPts;
        drawImgHeightPts = imgWidthPts;
      }
    }

    const imageRect = getGangSheetImageRectInches(item, placement);
    const imgXPts = imageRect.x * 72;
    const imgYPts = heightPts - imageRect.y * 72 - drawImgHeightPts;

    // Clip image to contour path for shapes (circle, oval, rounded shapes)
    const needsClip = imageSize.isShapeMode && item.shapeSettings
      && ['circle', 'oval', 'rounded-square', 'rounded-rectangle'].includes(item.shapeSettings.type);

    if (needsClip) {
      const { contourData } = item;
      const paths = contourData.allPathPoints && contourData.allPathPoints.length > 0
        ? contourData.allPathPoints : [contourData.pathPoints];
      const outerPaths = contourData.holePathStartIndex != null
        ? paths.slice(0, contourData.holePathStartIndex) : paths;

      let clipOps = 'q\n';
      for (const path of outerPaths) {
        if (path.length < 3) continue;
        const sheetPath = remapPathToSheet(
          path, contourData.widthInches, contourData.heightInches,
          placement.x, placement.y, sheetHeight,
          isRotated, !!item.shapeSettings?.enabled
        );
        clipOps += `${sheetPath[0].x * 72} ${sheetPath[0].y * 72} m\n`;
        for (let i = 1; i < sheetPath.length; i++) {
          clipOps += `${sheetPath[i].x * 72} ${sheetPath[i].y * 72} l\n`;
        }
        clipOps += 'h\n';
      }
      clipOps += 'W n\n';

      const imgName = `Img_${item.id.replace(/[^a-zA-Z0-9]/g, '_')}_${placement.instanceIndex}`;
      const resources = page.node.Resources();
      if (resources) {
        let xObjDict = resources.get(PDFName.of('XObject'));
        if (!xObjDict) { xObjDict = context.obj({}); resources.set(PDFName.of('XObject'), xObjDict); }
        (xObjDict as PDFDict).set(PDFName.of(imgName), drawPdfImage.ref);
      }

      clipOps += `${drawImgWidthPts} 0 0 ${drawImgHeightPts} ${imgXPts} ${imgYPts} cm\n`;
      clipOps += `/${imgName} Do\n`;
      clipOps += 'Q\n';

      const clipStream = context.stream(clipOps);
      const clipRef = context.register(clipStream);
      const existing = page.node.Contents();
      if (existing instanceof PDFArray) { existing.push(clipRef); }
      else if (existing) { page.node.set(PDFName.of('Contents'), context.obj([existing, clipRef])); }
    } else {
      page.drawImage(drawPdfImage, {
        x: imgXPts,
        y: imgYPts,
        width: drawImgWidthPts,
        height: drawImgHeightPts,
      });
    }
  }

  // --- Spot color cut paths (per-label) ---

  const usedLabels = new Set<string>();
  for (const item of items) usedLabels.add(item.cutContourLabel);

  const registerSeparation = (label: string) => {
    const tintFn = context.obj({
      FunctionType: 2,
      Domain: [0, 1],
      C0: [0, 0, 0, 0],
      C1: [0, 1, 0, 0],
      N: 1,
    });
    const tintRef = context.register(tintFn);
    const sepCS = context.obj([
      PDFName.of('Separation'),
      PDFName.of(label),
      PDFName.of('DeviceCMYK'),
      tintRef,
    ]);
    const sepRef = context.register(sepCS);

    const resources = page.node.Resources();
    if (resources) {
      let csDict = resources.get(PDFName.of('ColorSpace'));
      if (!csDict) {
        csDict = context.obj({});
        resources.set(PDFName.of('ColorSpace'), csDict);
      }
      (csDict as PDFDict).set(PDFName.of(label), sepRef);
    }
  };

  for (const label of usedLabels) registerSeparation(label);

  let allPathOps = '';
  for (const placement of placements) {
    const item = itemMap.get(placement.itemId);
    if (!item) continue;
    // Spot-color-only items: skip cut path emission entirely. The design
    // and any spot color separations are still drawn elsewhere; we just
    // don't add a magenta CutContour line for these items.
    if (item.noCutPath) continue;
    const { contourData } = item;
    const label = item.cutContourLabel;
    const isShapeCut = !!item.shapeSettings?.enabled;
    // Zero Hero items have `strokeSettings.width === 0` AND carry the
    // `allBezierPaths` field produced by the corner-aware Bezier
    // reconstruction in the worker. When present, we emit those directly
    // as smooth `c` operators (preview-≡-PDF parity); otherwise fall
    // back to the polyline emit path.
    const isZeroHero = item.strokeSettings.width === 0;
    const useBezier = isZeroHero
      && contourData.allBezierPaths
      && contourData.allBezierPaths.length > 0;

    if (useBezier) {
      for (const bp of contourData.allBezierPaths!) {
        const remappedBp = remapBezierPathToSheet(
          bp, contourData.widthInches, contourData.heightInches,
          placement.x, placement.y, sheetHeight,
          !!placement.rotated, isShapeCut
        );
        allPathOps += bezierPathToPDFPathOps(remappedBp, sheetHeight, label);
      }
    } else {
      const paths = contourData.allPathPoints && contourData.allPathPoints.length > 0
        ? contourData.allPathPoints
        : [contourData.pathPoints];
      for (const path of paths) {
        const remapped = remapPathToSheet(
          path, contourData.widthInches, contourData.heightInches,
          placement.x, placement.y, sheetHeight,
          !!placement.rotated, isShapeCut
        );
        allPathOps += contourPointsToPDFPathOps(remapped, sheetHeight, label, true);
      }
    }
  }

  if (allPathOps.length > 0) {
    const contentStream = context.stream(allPathOps);
    const contentStreamRef = context.register(contentStream);
    const existingContents = page.node.Contents();
    if (existingContents) {
      if (existingContents instanceof PDFArray) {
        existingContents.push(contentStreamRef);
      } else {
        const newContents = context.obj([existingContents, contentStreamRef]);
        page.node.set(PDFName.of('Contents'), newContents);
      }
    }
  }

  // --- Spot color vector layers (RDG_WHITE / RDG_GLOSS / fluorescent) ---
  // Build per-item spot data using the SAME image draw dims & offsets as
  // the design draw loop above (lines 619-688) — otherwise the spot color
  // paths get scaled to the contour bounds (typically larger than the
  // image) and offset to the contour origin instead of the image origin.
  //
  // Multi-page emission, matching the single-design `singleArtboard=false`
  // convention: page 1 keeps the design + cuts, then one NEW page per
  // separation label (RDG_WHITE / RDG_GLOSS / fluor*) is added to the same
  // PDF document containing only that separation's tiled paths.
  const spotItems = items
    .filter(item => item.spotColors && item.spotColors.length > 0)
    .map(item => {
      const itemPlacements = placements
        .filter(p => p.itemId === item.id)
        .map(p => ({ x: p.x, y: p.y, rotated: !!p.rotated }));
      if (itemPlacements.length === 0) return null;

      const imageSize = getGangSheetImageSizeInches(item);

      return {
        imageElement: item.imageElement,
        spotColors: item.spotColors!,
        spotPixelMap: item.spotPixelMap,
        imageWidthInches: imageSize.w,
        imageHeightInches: imageSize.h,
        imageOffsetX: item.contourData.imageOffsetX || 0,
        imageOffsetY: item.contourData.imageOffsetY || 0,
        placements: itemPlacements,
      };
    })
    .filter((it): it is NonNullable<typeof it> => it !== null);

  if (spotItems.length > 0) {
    try {
      await addGangSheetSpotColorsToPDF(pdfDoc, page, spotItems, sheetWidth, sheetHeight, true);
    } catch (err) {
      console.error('[GangSheet] Spot color emission failed:', err);
      // A PDF missing requested production plates is not a successful export.
      // Let the panel display the error before any download/save is attempted.
      throw new Error('Could not generate the gang sheet spot-color layers. Please try again.', { cause: err });
    }
  }

  // --- Download ---
  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = options.filename ?? `gang_sheet_${sheetWidth}x${sheetHeight}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    URL.revokeObjectURL(url);
  }

  return blob;
}
