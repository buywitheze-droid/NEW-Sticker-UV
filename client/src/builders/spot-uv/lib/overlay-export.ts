import { PDFArray, PDFDict, PDFDocument, PDFName, PDFPage } from "pdf-lib";
import { pdfName, pdfNameToken, cutContourMetadata } from "@/lib/pdf-name";
import { transformOverlayPaths, type PrintBounds } from "./overlay-align";
import {
  overlayByRole,
  overlayInkBox,
  overlayPathsToPolylines,
  type ImportedVectorOverlay,
  type OverlayPath,
} from "./imported-overlay";

export function alignedOverlayPaths(
  overlay: ImportedVectorOverlay,
  print: PrintBounds,
): OverlayPath[] {
  return transformOverlayPaths(overlay.paths, overlay, print);
}

export function overlayPageUnion(
  print: PrintBounds,
  overlays: ImportedVectorOverlay[],
  bleedInches = 0,
): { widthInches: number; heightInches: number; imageOffsetX: number; imageOffsetY: number } {
  let minX = 0;
  let minY = 0;
  let maxX = print.widthInches;
  let maxY = print.heightInches;
  for (const overlay of overlays) {
    const box = overlayInkBox(alignedOverlayPaths(overlay, print));
    if (!box) continue;
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
  }
  minX -= bleedInches;
  minY -= bleedInches;
  maxX += bleedInches;
  maxY += bleedInches;
  return {
    widthInches: Math.max(0.05, maxX - minX),
    heightInches: Math.max(0.05, maxY - minY),
    imageOffsetX: -minX,
    imageOffsetY: -minY,
  };
}

export function offsetOverlayPaths(paths: OverlayPath[], dx: number, dy: number): OverlayPath[] {
  return paths.map((path) => ({
    closed: path.closed,
    segs: path.segs.map((seg) => {
      if (seg.op === "h") return seg;
      if (seg.op === "c") {
        return {
          ...seg,
          x1: seg.x1 + dx,
          y1: seg.y1 + dy,
          x2: seg.x2 + dx,
          y2: seg.y2 + dy,
          x: seg.x + dx,
          y: seg.y + dy,
        };
      }
      return { ...seg, x: seg.x + dx, y: seg.y + dy };
    }),
  }));
}

export function overlayPathsToPDFOps(
  paths: OverlayPath[],
  pageHeightInches: number,
  colorName: string,
  mode: "stroke" | "fill",
): string {
  let ops = "q\n";
  ops += mode === "stroke"
    ? `${pdfNameToken(colorName)} CS 1 SCN\n0.5 w\n1 J\n1 j\n`
    : `${pdfNameToken(colorName)} cs 1 scn\n`;

  for (const path of paths) {
    for (const seg of path.segs) {
      if (seg.op === "m") {
        ops += `${(seg.x * 72).toFixed(4)} ${((pageHeightInches - seg.y) * 72).toFixed(4)} m\n`;
      } else if (seg.op === "l") {
        ops += `${(seg.x * 72).toFixed(4)} ${((pageHeightInches - seg.y) * 72).toFixed(4)} l\n`;
      } else if (seg.op === "c") {
        ops += `${(seg.x1 * 72).toFixed(4)} ${((pageHeightInches - seg.y1) * 72).toFixed(4)} ${(seg.x2 * 72).toFixed(4)} ${((pageHeightInches - seg.y2) * 72).toFixed(4)} ${(seg.x * 72).toFixed(4)} ${((pageHeightInches - seg.y) * 72).toFixed(4)} c\n`;
      } else {
        ops += "h\n";
      }
    }
  }
  ops += mode === "stroke" ? "S\nQ\n" : "f*\nQ\n";
  return ops;
}

export function registerOverlaySeparation(pdfDoc: PDFDocument, page: PDFPage, name: string): void {
  const context = pdfDoc.context;
  const tintFunction = context.obj({
    FunctionType: 2,
    Domain: [0, 1],
    C0: [0, 0, 0, 0],
    C1: [0, 1, 0, 0],
    N: 1,
  });
  const tintRef = context.register(tintFunction);
  const sep = context.obj([
    PDFName.of("Separation"),
    pdfName(name),
    PDFName.of("DeviceCMYK"),
    tintRef,
  ]);
  const sepRef = context.register(sep);
  let resources = page.node.Resources();
  if (!resources) {
    resources = context.obj({});
    page.node.set(PDFName.of("Resources"), resources);
  }
  let colorSpace = resources.get(PDFName.of("ColorSpace"));
  if (!colorSpace) {
    colorSpace = context.obj({});
    (resources as PDFDict).set(PDFName.of("ColorSpace"), colorSpace);
  }
  (colorSpace as PDFDict).set(pdfName(name), sepRef);
}

export function appendOverlayOps(pdfDoc: PDFDocument, page: PDFPage, ops: string): void {
  if (!ops) return;
  const context = pdfDoc.context;
  const stream = context.stream(ops);
  const ref = context.register(stream);
  const existing = page.node.Contents();
  if (!existing) {
    page.node.set(PDFName.of("Contents"), ref);
    return;
  }
  if (existing instanceof PDFArray) {
    existing.push(ref);
    return;
  }
  page.node.set(PDFName.of("Contents"), context.obj([existing, ref]));
}

export function emitOverlayOnPage(
  pdfDoc: PDFDocument,
  page: PDFPage,
  overlay: ImportedVectorOverlay,
  print: PrintBounds,
  pageHeightInches: number,
  imageOffsetX: number,
  imageOffsetY: number,
  mode: "stroke" | "fill",
): void {
  const aligned = offsetOverlayPaths(alignedOverlayPaths(overlay, print), imageOffsetX, imageOffsetY);
  registerOverlaySeparation(pdfDoc, page, overlay.label);
  appendOverlayOps(pdfDoc, page, overlayPathsToPDFOps(aligned, pageHeightInches, overlay.label, mode));
}

export function overlayExportSubject(
  cutLabel: string,
  whiteName: string,
  glossName: string,
  singleArtboard: boolean,
): string {
  return singleArtboard
    ? `Single artboard with Design + ${cutLabel} + ${whiteName} + ${glossName} ${cutContourMetadata([cutLabel])}`
    : `Page 1: Raster + ${cutLabel}, Page 2: ${whiteName}, Page 3: ${glossName} ${cutContourMetadata([cutLabel])}`;
}

export function customCutOverlay(overlays: ImportedVectorOverlay[] | undefined): ImportedVectorOverlay | undefined {
  return overlayByRole(overlays, "cutline");
}

export function customCutOverlays(overlays: ImportedVectorOverlay[] | undefined): ImportedVectorOverlay[] {
  return (overlays ?? []).filter((overlay) => overlay.visible && overlay.role === "cutline");
}

export function customSpotOverlays(overlays: ImportedVectorOverlay[] | undefined): ImportedVectorOverlay[] {
  return (overlays ?? []).filter((overlay) => overlay.visible && (overlay.role === "spotWhite" || overlay.role === "spotGloss"));
}

export function overlayPolylinesForPreview(
  overlay: ImportedVectorOverlay,
  print: PrintBounds,
): Array<Array<{ x: number; y: number }>> {
  return overlayPathsToPolylines(alignedOverlayPaths(overlay, print), overlay.role === "cutline" ? 6 : 3);
}

export function filterTracedSpotColors<T extends { spotWhite?: boolean; spotGloss?: boolean }>(
  spotColors: T[] | undefined,
  overlays: ImportedVectorOverlay[] | undefined,
): T[] | undefined {
  if (!spotColors?.length) return spotColors;
  const hasWhite = !!overlayByRole(overlays, "spotWhite");
  const hasGloss = !!overlayByRole(overlays, "spotGloss");
  if (!hasWhite && !hasGloss) return spotColors;
  const next = spotColors.map((color) => ({
    ...color,
    spotWhite: hasWhite ? false : color.spotWhite,
    spotGloss: hasGloss ? false : color.spotGloss,
  }));
  return next.some((color) => color.spotWhite || color.spotGloss) ? next : [];
}

export function snapshotOverlayForGang(
  overlay: ImportedVectorOverlay,
  print: PrintBounds,
  imageOffsetX: number,
  imageOffsetY: number,
): { role: ImportedVectorOverlay["role"]; label: string; paths: OverlayPath[] } {
  return {
    role: overlay.role,
    label: overlay.label,
    paths: offsetOverlayPaths(alignedOverlayPaths(overlay, print), imageOffsetX, imageOffsetY),
  };
}

export function remapOverlayPathsByPoint(
  paths: OverlayPath[],
  map: (x: number, y: number) => { x: number; y: number },
): OverlayPath[] {
  return paths.map((path) => ({
    closed: path.closed,
    segs: path.segs.map((seg) => {
      if (seg.op === "h") return seg;
      if (seg.op === "c") {
        const p1 = map(seg.x1, seg.y1);
        const p2 = map(seg.x2, seg.y2);
        const p = map(seg.x, seg.y);
        return { op: "c" as const, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y };
      }
      const p = map(seg.x, seg.y);
      return { ...seg, x: p.x, y: p.y };
    }),
  }));
}

export function overlayToContourSnapshot(
  overlay: ImportedVectorOverlay | ImportedVectorOverlay[],
  print: PrintBounds,
  backgroundColor = "transparent",
): {
  pathPoints: Array<{ x: number; y: number }>;
  previewPathPoints: Array<{ x: number; y: number }>;
  allPathPoints: Array<Array<{ x: number; y: number }>>;
  allPreviewPathPoints: Array<Array<{ x: number; y: number }>>;
  widthInches: number;
  heightInches: number;
  imageOffsetX: number;
  imageOffsetY: number;
  backgroundColor: string;
  effectiveDPI: number;
  minPathX: number;
  minPathY: number;
  bleedInches: number;
} {
  const list = Array.isArray(overlay) ? overlay : [overlay];
  const union = overlayPageUnion(print, list, 0.05);
  const polylines = list.flatMap((item) =>
    overlayPathsToPolylines(offsetOverlayPaths(alignedOverlayPaths(item, print), union.imageOffsetX, union.imageOffsetY), 8)
  );
  const pathPoints = polylines[0] ?? [
    { x: 0, y: 0 },
    { x: union.widthInches, y: 0 },
    { x: union.widthInches, y: union.heightInches },
    { x: 0, y: union.heightInches },
    { x: 0, y: 0 },
  ];
  return {
    pathPoints,
    previewPathPoints: pathPoints,
    allPathPoints: polylines.length ? polylines : [pathPoints],
    allPreviewPathPoints: polylines.length ? polylines : [pathPoints],
    widthInches: union.widthInches,
    heightInches: union.heightInches,
    imageOffsetX: union.imageOffsetX,
    imageOffsetY: union.imageOffsetY,
    backgroundColor,
    effectiveDPI: 300,
    minPathX: 0,
    minPathY: 0,
    bleedInches: 0.05,
  };
}

export function emitImportedSpotOverlays(
  pdfDoc: PDFDocument,
  page: PDFPage,
  overlays: ImportedVectorOverlay[],
  print: PrintBounds,
  pageHeightInches: number,
  imageOffsetX: number,
  imageOffsetY: number,
  singleArtboard: boolean,
  pageWidthPts: number,
  pageHeightPts: number,
): void {
  for (const overlay of customSpotOverlays(overlays)) {
    const target = singleArtboard ? page : pdfDoc.addPage([pageWidthPts, pageHeightPts]);
    emitOverlayOnPage(pdfDoc, target, overlay, print, pageHeightInches, imageOffsetX, imageOffsetY, "fill");
  }
}
