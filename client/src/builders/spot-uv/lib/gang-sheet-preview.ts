import type { BezierPath } from "./contour-worker-manager";
import {
  getGangSheetImageRectInches,
  getGangSheetImageSizeInches,
  mapContourPointToSheetTopLeft,
  type GangSheetItem,
  type GangSheetSettings,
  type PackResult,
} from "./gang-sheet";
import { createSpotOverlayCanvas, overlayCacheKey } from "./spot-overlay";

const gangSpotOverlayCache = new WeakMap<GangSheetItem, { key: string; canvas: HTMLCanvasElement }>();

function gangSheetSpotOverlay(item: GangSheetItem): HTMLCanvasElement | null {
  if (!item.spotColors?.some(c => c.spotWhite || c.spotGloss)) return null;
  const key = overlayCacheKey(item.spotColors);
  const hit = gangSpotOverlayCache.get(item);
  if (hit?.key === key) return hit.canvas;
  const canvas = createSpotOverlayCanvas(item.imageElement, item.spotColors, item.spotPixelMap);
  if (!canvas) return null;
  gangSpotOverlayCache.set(item, { key, canvas });
  return canvas;
}

export function drawGangSheetPreview(
  ctx: CanvasRenderingContext2D,
  args: {
    items: GangSheetItem[];
    settings: GangSheetSettings;
    packResult: PackResult;
    displayWidth: number;
    displayHeight: number;
    getImage?: (item: GangSheetItem) => CanvasImageSource | undefined;
  },
): void {
  const { items, settings, packResult, displayWidth, displayHeight } = args;
  const scaleX = displayWidth / settings.sheetWidth;
  const scaleY = displayHeight / settings.sheetHeight;

  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, displayWidth, displayHeight);

  ctx.strokeStyle = "#94a3b8";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(0.5, 0.5, displayWidth - 1, displayHeight - 1);

  const padX = settings.edgePadding * scaleX;
  const padY = settings.edgePadding * scaleY;
  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 0.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(padX, padY, displayWidth - padX * 2, displayHeight - padY * 2);
  ctx.setLineDash([]);

  for (const placement of packResult.placements) {
    const item = items.find((i) => i.id === placement.itemId);
    if (!item) continue;

    const rx = placement.x * scaleX;
    const ry = placement.y * scaleY;
    const rw = placement.width * scaleX;
    const rh = placement.height * scaleY;

    const fillColor = item.shapeSettings?.fillColor || item.contourData.backgroundColor || "#ffffff";
    const bleedColor = item.shapeSettings?.bleedEnabled ? (item.shapeSettings.bleedColor || "#ffffff") : null;
    const origW = item.contourData.widthInches;
    const origH = item.contourData.heightInches;
    const isShape = !!item.shapeSettings?.enabled;
    const isRotated = !!placement.rotated;

    const mapPt = (pt: { x: number; y: number }) => {
      const sheet = mapContourPointToSheetTopLeft(
        pt,
        origW,
        origH,
        placement.x,
        placement.y,
        isRotated,
        isShape,
      );
      return { px: sheet.x * scaleX, py: sheet.y * scaleY };
    };

    const mapBezierPath = (bp: BezierPath) => {
      const start = mapPt(bp.start);
      const segs = bp.segments.map((seg) =>
        seg.type === "line"
          ? { type: "line" as const, to: mapPt(seg.to) }
          : { type: "cubic" as const, cp1: mapPt(seg.cp1), cp2: mapPt(seg.cp2), to: mapPt(seg.to) },
      );
      return { start, segs };
    };

    const isZeroHero = item.strokeSettings.width === 0;
    const bezierPaths = isZeroHero ? item.contourData.allBezierPaths : undefined;
    const hasBezier = !!(bezierPaths && bezierPaths.length > 0);
    const allPaths = item.contourData.allPathPoints && item.contourData.allPathPoints.length > 0
      ? item.contourData.allPathPoints
      : (item.contourData.pathPoints ? [item.contourData.pathPoints] : []);
    const holeStart = item.contourData.holePathStartIndex;
    const outerPolylines = holeStart != null ? allPaths.slice(0, holeStart) : allPaths;
    const holePolylines = holeStart != null ? allPaths.slice(holeStart) : [];
    const hasOuterGeom =
      (hasBezier && bezierPaths!.length > 0) ||
      (outerPolylines.length > 0 && outerPolylines[0].length >= 3);

    const traceBezierPath = (bp: BezierPath) => {
      const { start, segs } = mapBezierPath(bp);
      ctx.moveTo(start.px, start.py);
      for (const seg of segs) {
        if (seg.type === "line") {
          ctx.lineTo(seg.to.px, seg.to.py);
        } else {
          ctx.bezierCurveTo(seg.cp1.px, seg.cp1.py, seg.cp2.px, seg.cp2.py, seg.to.px, seg.to.py);
        }
      }
      ctx.closePath();
    };

    const tracePolyline = (path: Array<{ x: number; y: number }>) => {
      if (path.length < 2) return;
      for (let i = 0; i < path.length; i++) {
        const { px, py } = mapPt(path[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    };

    const traceAllForFill = () => {
      ctx.beginPath();
      if (hasBezier) {
        for (const bp of bezierPaths!) traceBezierPath(bp);
      } else {
        for (const p of outerPolylines) tracePolyline(p);
      }
      for (const hp of holePolylines) tracePolyline(hp);
    };

    if (hasOuterGeom && origW > 0 && origH > 0) {
      if (bleedColor) {
        const bleed = item.contourData.bleedInches || 0.10;
        ctx.fillStyle = bleedColor;
        ctx.strokeStyle = bleedColor;
        ctx.lineWidth = bleed * Math.min(scaleX, scaleY) * 2;
        ctx.lineJoin = "round";
        traceAllForFill();
        ctx.stroke();
        ctx.fill("evenodd");
      }
      ctx.fillStyle = fillColor;
      traceAllForFill();
      ctx.fill("evenodd");
    } else {
      ctx.fillStyle = fillColor;
      ctx.fillRect(rx, ry, rw, rh);
    }

    const source = args.getImage?.(item) ?? item.imageElement;
    const canDrawImage = source instanceof HTMLImageElement
      ? source.complete && source.naturalWidth > 0
      : !!source;
    if (canDrawImage) {
      const imageRect = getGangSheetImageRectInches(item, placement);
      const imageSize = getGangSheetImageSizeInches(item);
      const ix = imageRect.x * scaleX;
      const iy = imageRect.y * scaleY;
      const iw = imageRect.w * scaleX;
      const ih = imageRect.h * scaleY;
      const unrotW = imageSize.w * scaleX;
      const unrotH = imageSize.h * scaleY;

      const drawImg = () => {
        const spotOverlay = gangSheetSpotOverlay(item);
        if (isRotated) {
          ctx.save();
          ctx.translate(ix + iw / 2, iy + ih / 2);
          ctx.rotate(-Math.PI / 2);
          try { ctx.drawImage(source, -unrotW / 2, -unrotH / 2, unrotW, unrotH); } catch { /* ignore */ }
          if (spotOverlay) {
            ctx.save();
            ctx.globalAlpha = 0.85;
            try { ctx.drawImage(spotOverlay, -unrotW / 2, -unrotH / 2, unrotW, unrotH); } catch { /* ignore */ }
            ctx.restore();
          }
          ctx.restore();
        } else {
          try { ctx.drawImage(source, ix, iy, iw, ih); } catch { /* ignore */ }
          if (spotOverlay) {
            ctx.save();
            ctx.globalAlpha = 0.85;
            try { ctx.drawImage(spotOverlay, ix, iy, iw, ih); } catch { /* ignore */ }
            ctx.restore();
          }
        }
      };

      if (hasOuterGeom && origW > 0 && origH > 0) {
        ctx.save();
        ctx.beginPath();
        if (hasBezier) {
          for (const bp of bezierPaths!) traceBezierPath(bp);
        } else {
          for (const p of outerPolylines) tracePolyline(p);
        }
        for (const hp of holePolylines) tracePolyline(hp);
        ctx.clip("evenodd");
        drawImg();
        ctx.restore();
      } else {
        drawImg();
      }
    }

    if (!item.noCutPath) {
      ctx.strokeStyle = "#FF00FF";
      ctx.lineWidth = 1;
      ctx.lineJoin = "round";
      if (hasOuterGeom && origW > 0 && origH > 0) {
        if (hasBezier) {
          for (const bp of bezierPaths!) {
            ctx.beginPath();
            traceBezierPath(bp);
            ctx.stroke();
          }
        } else {
          for (const p of outerPolylines) {
            ctx.beginPath();
            tracePolyline(p);
            ctx.stroke();
          }
        }
        for (const hp of holePolylines) {
          ctx.beginPath();
          tracePolyline(hp);
          ctx.stroke();
        }
      } else {
        ctx.strokeRect(rx, ry, rw, rh);
      }
    }
  }

  ctx.fillStyle = "#64748b";
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(
    `${settings.sheetWidth}" x ${settings.sheetHeight}"`,
    displayWidth / 2,
    displayHeight - 4,
  );
}
