export type OverlayRole = "cutline" | "spotWhite" | "spotGloss";
export type OverlaySourceKind = "eps" | "pdf" | "svg";

export type OverlaySeg =
  | { op: "m"; x: number; y: number }
  | { op: "l"; x: number; y: number }
  | { op: "c"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: "h" };

export interface OverlayPath {
  segs: OverlaySeg[];
  closed: boolean;
}

export interface OverlayNativePage {
  widthInches: number;
  heightInches: number;
}

export interface OverlayAlignment {
  offsetXInches: number;
  offsetYInches: number;
  scale: number;
  rotationDeg: number;
  locked: boolean;
}

export interface OverlayAutoFit {
  mode: "artboard" | "contain" | "source";
  scale: number;
  offsetXInches: number;
  offsetYInches: number;
  printWidthInches: number;
  printHeightInches: number;
  warnings: string[];
}

export interface OverlayParseResult {
  kind: OverlaySourceKind;
  filename: string;
  nativePage: OverlayNativePage;
  paths: OverlayPath[];
  detectedLabel: string | null;
  warnings: string[];
  pageCount: number;
}

export interface OverlayPreviewStyle {
  color: string;
  mode: "fill" | "stroke";
  dashed: boolean;
  opacity: number;
}

export function defaultOverlayPreviewStyle(role: OverlayRole): OverlayPreviewStyle {
  if (role === "cutline") return { color: "#FF00FF", mode: "stroke", dashed: false, opacity: 1 };
  if (role === "spotWhite") return { color: "#f97316", mode: "fill", dashed: false, opacity: 0.55 };
  return { color: "#14b8a6", mode: "fill", dashed: false, opacity: 0.55 };
}

export interface ImportedVectorOverlay {
  id: string;
  role: OverlayRole;
  label: string;
  source: {
    filename: string;
    kind: OverlaySourceKind;
    assetId?: number;
  };
  nativePage: OverlayNativePage;
  paths: OverlayPath[];
  alignment: OverlayAlignment;
  autoFit: OverlayAutoFit;
  visible: boolean;
  warnings: string[];
  previewStyle?: OverlayPreviewStyle;
  sourceFile?: File;
}

export const DEFAULT_OVERLAY_ALIGNMENT: OverlayAlignment = {
  offsetXInches: 0,
  offsetYInches: 0,
  scale: 1,
  rotationDeg: 0,
  locked: false,
};

export function defaultLabelForRole(role: OverlayRole): string {
  if (role === "cutline") return "CutContour";
  if (role === "spotWhite") return "RDG_WHITE";
  return "RDG_GLOSS";
}

export function overlayInkBox(paths: OverlayPath[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const seg of path.segs) {
      if (seg.op === "h") continue;
      minX = Math.min(minX, seg.x);
      minY = Math.min(minY, seg.y);
      maxX = Math.max(maxX, seg.x);
      maxY = Math.max(maxY, seg.y);
      if (seg.op === "c") {
        minX = Math.min(minX, seg.x1, seg.x2);
        minY = Math.min(minY, seg.y1, seg.y2);
        maxX = Math.max(maxX, seg.x1, seg.x2);
        maxY = Math.max(maxY, seg.y1, seg.y2);
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function overlayHasClosedPath(paths: OverlayPath[]): boolean {
  return paths.some((path) => path.closed || path.segs.some((seg) => seg.op === "h"));
}

export function countOverlaySegments(paths: OverlayPath[]): number {
  return paths.reduce((sum, path) => sum + path.segs.length, 0);
}

export function overlayPathsToPolylines(paths: OverlayPath[], samplesPerCurve = 4): Array<Array<{ x: number; y: number }>> {
  const out: Array<Array<{ x: number; y: number }>> = [];
  for (const path of paths) {
    const pts: Array<{ x: number; y: number }> = [];
    let cx = 0;
    let cy = 0;
    for (const seg of path.segs) {
      if (seg.op === "m" || seg.op === "l") {
        cx = seg.x;
        cy = seg.y;
        pts.push({ x: cx, y: cy });
      } else if (seg.op === "c") {
        for (let i = 1; i <= samplesPerCurve; i++) {
          const t = i / samplesPerCurve;
          pts.push(cubicPoint(cx, cy, seg.x1, seg.y1, seg.x2, seg.y2, seg.x, seg.y, t));
        }
        cx = seg.x;
        cy = seg.y;
      } else if (seg.op === "h" && pts.length > 0) {
        pts.push({ ...pts[0] });
      }
    }
    if (pts.length >= 2) out.push(pts);
  }
  return out;
}

function cubicPoint(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  t: number,
): { x: number; y: number } {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * x0 + b * x1 + c * x2 + d * x3,
    y: a * y0 + b * y1 + c * y2 + d * y3,
  };
}

export function closeNearlyOpenPaths(paths: OverlayPath[], epsilonInches = 0.01): OverlayPath[] {
  return paths.map((path) => {
    const first = path.segs.find((seg) => seg.op === "m" || seg.op === "l" || seg.op === "c");
    let last: OverlaySeg | undefined;
    for (let i = path.segs.length - 1; i >= 0; i--) {
      if (path.segs[i].op !== "h") {
        last = path.segs[i];
        break;
      }
    }
    if (!first || !last || last.op === "h") return path;
    const dx = first.x - last.x;
    const dy = first.y - last.y;
    if (Math.hypot(dx, dy) <= epsilonInches && !path.closed) {
      return { segs: [...path.segs, { op: "h" as const }], closed: true };
    }
    return path;
  });
}

export function overlayByRole(
  overlays: ImportedVectorOverlay[] | undefined,
  role: OverlayRole,
): ImportedVectorOverlay | undefined {
  return overlays?.find((overlay) => overlay.role === role && overlay.visible);
}

export function overlaysByRole(
  overlays: ImportedVectorOverlay[] | undefined,
  role: OverlayRole,
): ImportedVectorOverlay[] {
  return (overlays ?? []).filter((overlay) => overlay.visible && overlay.role === role);
}

export function overlayById(
  overlays: ImportedVectorOverlay[] | undefined,
  id: string | null | undefined,
): ImportedVectorOverlay | undefined {
  if (!id) return undefined;
  return overlays?.find((overlay) => overlay.id === id);
}

export function cloneOverlayPaths(paths: OverlayPath[]): OverlayPath[] {
  return paths.map((path) => ({
    closed: path.closed,
    segs: path.segs.map((seg) => ({ ...seg })),
  }));
}

export function cloneImportedOverlay(overlay: ImportedVectorOverlay): ImportedVectorOverlay {
  return {
    ...overlay,
    source: { ...overlay.source },
    nativePage: { ...overlay.nativePage },
    paths: cloneOverlayPaths(overlay.paths),
    alignment: { ...overlay.alignment },
    autoFit: { ...overlay.autoFit, warnings: [...overlay.autoFit.warnings] },
    previewStyle: overlay.previewStyle ? { ...overlay.previewStyle } : undefined,
    warnings: [...overlay.warnings],
  };
}

export function overlayToDocument(overlay: ImportedVectorOverlay) {
  return {
    id: overlay.id,
    role: overlay.role,
    label: overlay.label,
    source: { ...overlay.source },
    nativePage: { ...overlay.nativePage },
    paths: cloneOverlayPaths(overlay.paths),
    alignment: { ...overlay.alignment },
    autoFit: { ...overlay.autoFit, warnings: [...overlay.autoFit.warnings] },
    visible: overlay.visible,
    previewStyle: overlay.previewStyle ? { ...overlay.previewStyle } : undefined,
    warnings: [...overlay.warnings],
  };
}

export function replaceOverlay(
  overlays: ImportedVectorOverlay[],
  next: ImportedVectorOverlay,
  replaceId?: string | null,
): ImportedVectorOverlay[] {
  if (replaceId) {
    const index = overlays.findIndex((overlay) => overlay.id === replaceId);
    if (index >= 0) {
      const copy = overlays.slice();
      copy[index] = { ...next, id: replaceId };
      return copy;
    }
  }
  if (next.role === "cutline") {
    return [...overlays, next];
  }
  const without = overlays.filter((overlay) => overlay.role !== next.role);
  return [...without, next];
}
