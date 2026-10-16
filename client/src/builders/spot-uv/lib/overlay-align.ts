import {
  defaultLabelForRole,
  defaultOverlayPreviewStyle,
  overlayInkBox,
  type ImportedVectorOverlay,
  type OverlayAlignment,
  type OverlayAutoFit,
  type OverlayNativePage,
  type OverlayPath,
  type OverlayRole,
  type OverlaySeg,
} from "./imported-overlay";

export interface PrintBounds {
  widthInches: number;
  heightInches: number;
  ink?: { x: number; y: number; width: number; height: number };
  /** Original print-file page in inches, before the builder's sticker-size resize. */
  sourcePage?: { widthInches: number; heightInches: number };
}

export interface OverlayFitHint {
  role?: OverlayRole;
  siblings?: Array<Pick<ImportedVectorOverlay, "role" | "nativePage" | "paths" | "autoFit">>;
}

const ASPECT_MATCH = 0.05;
const PAGE_FIT_SLACK = 1.25;

function pageAspect(width: number, height: number): number {
  return width / Math.max(height, 1e-6);
}

function aspectDelta(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(a, b, 1e-6);
}

function fitDestination(print: PrintBounds): { widthInches: number; heightInches: number } {
  if (print.sourcePage && print.sourcePage.widthInches > 0 && print.sourcePage.heightInches > 0) {
    return print.sourcePage;
  }
  return { widthInches: print.widthInches, heightInches: print.heightInches };
}

function mapBoxToPage(
  box: { x: number; y: number; width: number; height: number },
  from: { widthInches: number; heightInches: number },
  to: { widthInches: number; heightInches: number },
) {
  return {
    x: box.x * to.widthInches / Math.max(from.widthInches, 1e-6),
    y: box.y * to.heightInches / Math.max(from.heightInches, 1e-6),
    width: box.width * to.widthInches / Math.max(from.widthInches, 1e-6),
    height: box.height * to.heightInches / Math.max(from.heightInches, 1e-6),
  };
}

function centeredNativeFit(
  overlayPage: OverlayNativePage,
  dest: { widthInches: number; heightInches: number },
  scale: number,
  warnings: string[],
): OverlayAutoFit {
  return {
    mode: "source",
    scale,
    offsetXInches: (dest.widthInches - overlayPage.widthInches * scale) / 2,
    offsetYInches: (dest.heightInches - overlayPage.heightInches * scale) / 2,
    printWidthInches: dest.widthInches,
    printHeightInches: dest.heightInches,
    warnings,
  };
}

function artboardFit(
  overlayPage: OverlayNativePage,
  dest: { widthInches: number; heightInches: number },
  warnings: string[],
): OverlayAutoFit {
  return {
    mode: "artboard",
    scale: dest.widthInches / Math.max(overlayPage.widthInches, 1e-6),
    offsetXInches: 0,
    offsetYInches: 0,
    printWidthInches: dest.widthInches,
    printHeightInches: dest.heightInches,
    warnings,
  };
}

function containPageFit(
  overlayPage: OverlayNativePage,
  dest: { widthInches: number; heightInches: number },
  warnings: string[],
): OverlayAutoFit {
  const scale = Math.min(
    dest.widthInches / Math.max(overlayPage.widthInches, 1e-6),
    dest.heightInches / Math.max(overlayPage.heightInches, 1e-6),
  );
  return centeredNativeFit(overlayPage, dest, scale, warnings);
}

function containInkFit(
  overlayPage: OverlayNativePage,
  overlayPaths: OverlayPath[],
  dest: { widthInches: number; heightInches: number },
  destInk: { x: number; y: number; width: number; height: number },
  warnings: string[],
): OverlayAutoFit {
  const ink = overlayInkBox(overlayPaths) ?? {
    minX: 0,
    minY: 0,
    width: overlayPage.widthInches,
    height: overlayPage.heightInches,
    maxX: overlayPage.widthInches,
    maxY: overlayPage.heightInches,
  };
  const scale = Math.min(
    destInk.width / Math.max(ink.width, 1e-6),
    destInk.height / Math.max(ink.height, 1e-6),
  );
  return {
    mode: "contain",
    scale,
    offsetXInches: destInk.x + (destInk.width - ink.width * scale) / 2 - ink.minX * scale,
    offsetYInches: destInk.y + (destInk.height - ink.height * scale) / 2 - ink.minY * scale,
    printWidthInches: dest.widthInches,
    printHeightInches: dest.heightInches,
    warnings,
  };
}

function sameFitPage(
  autoFit: OverlayAutoFit,
  dest: { widthInches: number; heightInches: number },
): boolean {
  return Math.abs(autoFit.printWidthInches - dest.widthInches) < 0.03
    && Math.abs(autoFit.printHeightInches - dest.heightInches) < 0.03;
}

function referenceOverlay(
  hint: OverlayFitHint | undefined,
  dest: { widthInches: number; heightInches: number },
  print: PrintBounds,
): Pick<ImportedVectorOverlay, "nativePage" | "paths" | "autoFit"> | undefined {
  if (!hint || hint.role === "cutline") return undefined;
  const sibling = hint.siblings?.find((item) => item.role === "cutline")
    ?? hint.siblings?.[0];
  if (!sibling) return undefined;
  const autoFit = sibling.autoFit && sameFitPage(sibling.autoFit, dest)
    ? sibling.autoFit
    : computeOverlayAutoFit(sibling.nativePage, sibling.paths, print, { role: sibling.role });
  return { nativePage: sibling.nativePage, paths: sibling.paths, autoFit };
}

/**
 * Spot EPS/PDFs are usually the same sticker as the cutline with a tighter
 * crop. Mapping that page onto the cutline frame keeps the artwork registered.
 * A much smaller file is treated as a local island and only recentered.
 */
function nestInReference(
  overlayPage: OverlayNativePage,
  overlayPaths: OverlayPath[],
  reference: Pick<ImportedVectorOverlay, "nativePage" | "paths" | "autoFit">,
  warnings: string[],
): OverlayAutoFit {
  const refScale = reference.autoFit.scale;
  const widthRatio = overlayPage.widthInches / Math.max(reference.nativePage.widthInches, 1e-6);
  const heightRatio = overlayPage.heightInches / Math.max(reference.nativePage.heightInches, 1e-6);
  const frameDelta = aspectDelta(
    pageAspect(reference.nativePage.widthInches, reference.nativePage.heightInches),
    pageAspect(overlayPage.widthInches, overlayPage.heightInches),
  );
  const similarFrame = widthRatio >= 0.72 && heightRatio >= 0.72 && frameDelta <= 0.15;

  if (similarFrame) {
    const pageScale = (1 / Math.max(widthRatio, 1e-6) + 1 / Math.max(heightRatio, 1e-6)) / 2;
    const scale = pageScale * refScale;
    const mappedW = overlayPage.widthInches * scale;
    const mappedH = overlayPage.heightInches * scale;
    const refW = reference.nativePage.widthInches * refScale;
    const refH = reference.nativePage.heightInches * refScale;
    warnings.push("Spot file uses a tighter crop, so it was scaled to the cutline.");
    return {
      mode: "source",
      scale,
      offsetXInches: reference.autoFit.offsetXInches + (refW - mappedW) / 2,
      offsetYInches: reference.autoFit.offsetYInches + (refH - mappedH) / 2,
      printWidthInches: reference.autoFit.printWidthInches,
      printHeightInches: reference.autoFit.printHeightInches,
      warnings,
    };
  }

  const scale = refScale;
  const refInk = overlayInkBox(reference.paths);
  const spotInk = overlayInkBox(overlayPaths);
  const refCx = refInk ? refInk.minX + refInk.width / 2 : reference.nativePage.widthInches / 2;
  const refCy = refInk ? refInk.minY + refInk.height / 2 : reference.nativePage.heightInches / 2;
  const spotCx = spotInk ? spotInk.minX + spotInk.width / 2 : overlayPage.widthInches / 2;
  const spotCy = spotInk ? spotInk.minY + spotInk.height / 2 : overlayPage.heightInches / 2;
  warnings.push("Spot layer is sized with the cutline and centered on that cut path.");
  return {
    mode: "source",
    scale,
    offsetXInches: reference.autoFit.offsetXInches + (refCx - spotCx) * scale,
    offsetYInches: reference.autoFit.offsetYInches + (refCy - spotCy) * scale,
    printWidthInches: reference.autoFit.printWidthInches,
    printHeightInches: reference.autoFit.printHeightInches,
    warnings,
  };
}

/**
 * Register an uploaded vector to the print.
 *
 * Spot white/gloss files are usually a tighter crop than the PNG or cutline.
 * Fitting each layer's ink box independently stretches gloss to the full
 * sticker. Instead we keep overlay inches 1:1 with the original PNG page
 * (or a shared cutline scale), then the sticker resize is applied once.
 */
export function computeOverlayAutoFit(
  overlayPage: { widthInches: number; heightInches: number },
  overlayPaths: OverlayPath[],
  print: PrintBounds,
  hint?: OverlayFitHint,
): OverlayAutoFit {
  const dest = fitDestination(print);
  const destInk = print.ink
    ? mapBoxToPage(print.ink, print, dest)
    : { x: 0, y: 0, width: dest.widthInches, height: dest.heightInches };
  const warnings: string[] = [];
  const pageDelta = aspectDelta(
    pageAspect(dest.widthInches, dest.heightInches),
    pageAspect(overlayPage.widthInches, overlayPage.heightInches),
  );
  const pageFitsDest = overlayPage.widthInches <= dest.widthInches * PAGE_FIT_SLACK
    && overlayPage.heightInches <= dest.heightInches * PAGE_FIT_SLACK;
  const reference = referenceOverlay(hint, dest, print);
  if (reference) {
    return nestInReference(overlayPage, overlayPaths, reference, warnings);
  }

  if (pageDelta <= ASPECT_MATCH) {
    return artboardFit(overlayPage, dest, warnings);
  }

  if (pageFitsDest) {
    warnings.push("Placed at the original vector size on the print file, then resized with the design.");
    return centeredNativeFit(overlayPage, dest, 1, warnings);
  }

  warnings.push("The uploaded artboard is a different shape than the print. It was centered to fit.");
  if (hint?.role === "spotWhite" || hint?.role === "spotGloss") {
    return containPageFit(overlayPage, dest, warnings);
  }

  const sizeRatio = (overlayPage.widthInches * overlayPage.heightInches)
    / Math.max(dest.widthInches * dest.heightInches, 1e-6);
  if (sizeRatio > 1.35 || sizeRatio < 0.4) {
    warnings.push("The uploaded artwork is a very different size than the print. Check the preview alignment.");
  }
  return containInkFit(overlayPage, overlayPaths, dest, destInk, warnings);
}

export function overlayTransform(
  overlay: Pick<ImportedVectorOverlay, "alignment" | "autoFit">,
  print: PrintBounds,
): { scaleX: number; scaleY: number; offsetX: number; offsetY: number; rotationDeg: number } {
  const sizeX = print.widthInches / Math.max(overlay.autoFit.printWidthInches, 1e-6);
  const sizeY = print.heightInches / Math.max(overlay.autoFit.printHeightInches, 1e-6);
  const user = overlay.alignment.scale || 1;
  return {
    scaleX: overlay.autoFit.scale * user * sizeX,
    scaleY: overlay.autoFit.scale * user * sizeY,
    offsetX: (overlay.autoFit.offsetXInches + overlay.alignment.offsetXInches) * sizeX,
    offsetY: (overlay.autoFit.offsetYInches + overlay.alignment.offsetYInches) * sizeY,
    rotationDeg: overlay.alignment.rotationDeg || 0,
  };
}

export function transformOverlayPaths(
  paths: OverlayPath[],
  overlay: Pick<ImportedVectorOverlay, "alignment" | "autoFit">,
  print: PrintBounds,
): OverlayPath[] {
  const { scaleX, scaleY, offsetX, offsetY, rotationDeg } = overlayTransform(overlay, print);
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = print.widthInches / 2;
  const cy = print.heightInches / 2;
  const map = (x: number, y: number) => {
    let px = x * scaleX + offsetX;
    let py = y * scaleY + offsetY;
    if (rotationDeg) {
      const dx = px - cx;
      const dy = py - cy;
      px = cx + dx * cos - dy * sin;
      py = cy + dx * sin + dy * cos;
    }
    return { x: px, y: py };
  };

  return paths.map((path) => ({
    closed: path.closed,
    segs: path.segs.map((seg) => mapSeg(seg, map)),
  }));
}

function mapSeg(seg: OverlaySeg, map: (x: number, y: number) => { x: number; y: number }): OverlaySeg {
  if (seg.op === "h") return seg;
  if (seg.op === "c") {
    const p1 = map(seg.x1, seg.y1);
    const p2 = map(seg.x2, seg.y2);
    const p = map(seg.x, seg.y);
    return { op: "c", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y };
  }
  const p = map(seg.x, seg.y);
  return { ...seg, x: p.x, y: p.y };
}

export function alignmentWarnings(
  overlay: ImportedVectorOverlay,
  print: PrintBounds,
): string[] {
  const transformed = transformOverlayPaths(overlay.paths, overlay, print);
  const box = overlayInkBox(transformed);
  const warnings = [...overlay.autoFit.warnings];
  if (!box) return warnings;
  const pad = 0.02;
  if (box.minX < -pad || box.minY < -pad || box.maxX > print.widthInches + pad || box.maxY > print.heightInches + pad) {
    warnings.push("Part of the uploaded vector hangs off the print page.");
  }
  return warnings;
}

export function resetOverlayAlignment(alignment: OverlayAlignment): OverlayAlignment {
  return { ...alignment, offsetXInches: 0, offsetYInches: 0, scale: 1, rotationDeg: 0 };
}

export function applyOverlayUserNudge(
  overlay: Pick<ImportedVectorOverlay, "alignment" | "autoFit">,
  print: PrintBounds,
  deltaXInches: number,
  deltaYInches: number,
): OverlayAlignment {
  const sizeX = print.widthInches / Math.max(overlay.autoFit.printWidthInches, 1e-6);
  const sizeY = print.heightInches / Math.max(overlay.autoFit.printHeightInches, 1e-6);
  return {
    ...overlay.alignment,
    offsetXInches: overlay.alignment.offsetXInches + deltaXInches / sizeX,
    offsetYInches: overlay.alignment.offsetYInches + deltaYInches / sizeY,
  };
}

/** Change user scale while keeping the visible ink box centered. */
export function applyOverlayUserScale(
  overlay: ImportedVectorOverlay,
  print: PrintBounds,
  nextUserScale: number,
): OverlayAlignment {
  const scale = Math.min(4, Math.max(0.1, nextUserScale));
  const before = overlayInkBox(transformOverlayPaths(overlay.paths, overlay, print));
  const nextAlignment = { ...overlay.alignment, scale };
  const after = overlayInkBox(transformOverlayPaths(overlay.paths, { ...overlay, alignment: nextAlignment }, print));
  if (!before || !after) return nextAlignment;
  const sizeX = print.widthInches / Math.max(overlay.autoFit.printWidthInches, 1e-6);
  const sizeY = print.heightInches / Math.max(overlay.autoFit.printHeightInches, 1e-6);
  const beforeCx = before.minX + before.width / 2;
  const beforeCy = before.minY + before.height / 2;
  const afterCx = after.minX + after.width / 2;
  const afterCy = after.minY + after.height / 2;
  return {
    ...nextAlignment,
    offsetXInches: nextAlignment.offsetXInches + (beforeCx - afterCx) / sizeX,
    offsetYInches: nextAlignment.offsetYInches + (beforeCy - afterCy) / sizeY,
  };
}

export function createImportedOverlay(
  role: ImportedVectorOverlay["role"],
  parsed: {
    kind: ImportedVectorOverlay["source"]["kind"];
    filename: string;
    nativePage: ImportedVectorOverlay["nativePage"];
    paths: OverlayPath[];
    detectedLabel: string | null;
    warnings: string[];
  },
  print: PrintBounds,
  label?: string,
  extras?: { assetId?: number; sourceFile?: File; siblings?: OverlayFitHint["siblings"] },
): ImportedVectorOverlay {
  const autoFit = computeOverlayAutoFit(parsed.nativePage, parsed.paths, print, {
    role,
    siblings: extras?.siblings,
  });
  return {
    id: (globalThis.crypto?.randomUUID?.() ?? `ov-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    role,
    label: label || parsed.detectedLabel || defaultLabelForRole(role),
    source: {
      filename: parsed.filename,
      kind: parsed.kind,
      assetId: extras?.assetId,
    },
    nativePage: parsed.nativePage,
    paths: parsed.paths,
    alignment: { offsetXInches: 0, offsetYInches: 0, scale: 1, rotationDeg: 0, locked: false },
    autoFit,
    visible: true,
    previewStyle: defaultOverlayPreviewStyle(role),
    warnings: [...parsed.warnings, ...autoFit.warnings],
    sourceFile: extras?.sourceFile,
  };
}

export function refitUnlockedOverlays(
  overlays: ImportedVectorOverlay[],
  print: PrintBounds,
): { overlays: ImportedVectorOverlay[]; resetCount: number } {
  let resetCount = 0;
  const cutlines = overlays.filter((overlay) => overlay.role === "cutline");
  const next = overlays.map((overlay) => {
    const autoFit = computeOverlayAutoFit(overlay.nativePage, overlay.paths, print, {
      role: overlay.role,
      siblings: overlay.role === "cutline" ? undefined : cutlines,
    });
    if (overlay.alignment.locked) {
      return { ...overlay, autoFit, warnings: [...autoFit.warnings] };
    }
    resetCount += 1;
    return {
      ...overlay,
      autoFit,
      alignment: resetOverlayAlignment(overlay.alignment),
      warnings: [...autoFit.warnings],
    };
  });
  return { overlays: next, resetCount };
}
