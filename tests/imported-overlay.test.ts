import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PDFDocument, PDFName } from "pdf-lib";

import {
  DEFAULT_OVERLAY_ALIGNMENT,
  closeNearlyOpenPaths,
  countOverlaySegments,
  overlayHasClosedPath,
  overlayInkBox,
  replaceOverlay,
  type ImportedVectorOverlay,
} from "../client/src/builders/spot-uv/lib/imported-overlay.ts";
import {
  OverlayParseError,
  parseOverlayEps,
  parseOverlayPdf,
  parseOverlaySvg,
  svgPathToOverlay,
} from "../client/src/builders/spot-uv/lib/overlay-parser.ts";
import { applyOverlayUserScale, computeOverlayAutoFit, transformOverlayPaths } from "../client/src/builders/spot-uv/lib/overlay-align.ts";
import { bestSpotTranslation } from "../client/src/builders/spot-uv/lib/overlay-register.ts";
import {
  emitOverlayOnPage,
  filterTracedSpotColors,
  overlayExportSubject,
  overlayPageUnion,
  overlayPathsToPDFOps,
  remapOverlayPathsByPoint,
  snapshotOverlayForGang,
} from "../client/src/builders/spot-uv/lib/overlay-export.ts";
import { cloneOverlayPaths } from "../client/src/builders/spot-uv/lib/imported-overlay.ts";
import { serializedDesignSchema } from "../shared/design-document.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "overlays");

test("EPS cutline parser reads the Boba contour and page size", () => {
  const parsed = parseOverlayEps(readFixture("Boba-Contour-Cutline.eps"), "Boba-Contour-Cutline.eps");
  assert.equal(parsed.kind, "eps");
  assert.ok(parsed.nativePage.widthInches > 1.8 && parsed.nativePage.widthInches < 2.1);
  assert.ok(parsed.nativePage.heightInches > 2.9 && parsed.nativePage.heightInches < 3.2);
  assert.ok(parsed.paths.length >= 1);
  assert.ok(overlayHasClosedPath(parsed.paths));
  const cubics = parsed.paths.flatMap((p) => p.segs).filter((s) => s.op === "c");
  assert.ok(cubics.length > 10, "cutline should keep cubic segments");
});

test("EPS gloss parser reads Boba RDG_GLOSS cubics", () => {
  const parsed = parseOverlayEps(readFixture("Boba-UV-Spot.eps"), "Boba-UV-Spot.eps");
  assert.ok(parsed.paths.length > 10);
  assert.ok(countOverlaySegments(parsed.paths) > 50);
  const box = overlayInkBox(parsed.paths);
  assert.ok(box && box.width > 0.5 && box.height > 1);
});

test("empty EPS is rejected", () => {
  const empty = Buffer.from("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n%%EndComments\n");
  assert.throws(
    () => parseOverlayEps(empty.buffer.slice(empty.byteOffset, empty.byteOffset + empty.byteLength), "empty.eps"),
    OverlayParseError,
  );
});

test("SVG path parser keeps cubics and page size", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2in" height="3in" viewBox="0 0 144 216">
    <path d="M 10 10 C 20 0 40 0 50 10 L 50 50 Z"/>
  </svg>`;
  const parsed = parseOverlaySvg(svg, "cut.svg");
  assert.equal(parsed.nativePage.widthInches, 2);
  assert.equal(parsed.nativePage.heightInches, 3);
  assert.ok(parsed.paths.length >= 1);
  assert.ok(parsed.paths[0].segs.some((s) => s.op === "c"));
  assert.ok(overlayHasClosedPath(parsed.paths));
});

test("svgPathToOverlay handles relative commands", () => {
  const paths = svgPathToOverlay("m 1 1 l 2 0 l 0 2 z", 0, 0, 1, 1);
  assert.equal(paths.length, 1);
  assert.equal(paths[0].closed, true);
  assert.equal(paths[0].segs[0].op, "m");
});

function readFixture(name: string): ArrayBuffer {
  const buf = readFileSync(join(fixtures, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test("auto-fit maps matching artboards and centers mismatched ones", () => {
  const cut = parseOverlayEps(readFixture("Boba-Contour-Cutline.eps"), "cut.eps");
  const print = { widthInches: cut.nativePage.widthInches, heightInches: cut.nativePage.heightInches };
  const fit = computeOverlayAutoFit(cut.nativePage, cut.paths, print);
  assert.equal(fit.mode, "artboard");
  assert.ok(Math.abs(fit.scale - 1) < 0.02);

  const gloss = parseOverlayEps(readFixture("Boba-UV-Spot.eps"), "Boba-UV-Spot.eps");
  const glossFit = computeOverlayAutoFit(gloss.nativePage, gloss.paths, print);
  const aligned = transformOverlayPaths(gloss.paths, {
    alignment: DEFAULT_OVERLAY_ALIGNMENT,
    autoFit: glossFit,
  }, print);
  const box = overlayInkBox(aligned);
  assert.ok(box);
  assert.ok(box.minX >= -0.05);
  assert.ok(box.maxX <= print.widthInches + 0.05);
});

test("spot gloss keeps native size on a resized square PNG instead of filling the sticker", () => {
  const cut = parseOverlayEps(readFixture("Boba-Contour-Cutline.eps"), "cut.eps");
  const gloss = parseOverlayEps(readFixture("Boba-UV-Spot.eps"), "Boba-UV-Spot.eps");
  const sourcePage = { widthInches: 975 / 300, heightInches: 975 / 300 };
  const print = { widthInches: 4, heightInches: 4, sourcePage };
  const cutFit = computeOverlayAutoFit(cut.nativePage, cut.paths, print, { role: "cutline" });
  const glossFit = computeOverlayAutoFit(gloss.nativePage, gloss.paths, print, {
    role: "spotGloss",
    siblings: [{ role: "cutline", nativePage: cut.nativePage, paths: cut.paths, autoFit: cutFit }],
  });
  assert.equal(cutFit.mode, "source");
  assert.equal(glossFit.mode, "source");
  assert.ok(glossFit.scale > cutFit.scale);

  const cutBox = overlayInkBox(transformOverlayPaths(cut.paths, {
    alignment: DEFAULT_OVERLAY_ALIGNMENT,
    autoFit: cutFit,
  }, print))!;
  const glossBox = overlayInkBox(transformOverlayPaths(gloss.paths, {
    alignment: DEFAULT_OVERLAY_ALIGNMENT,
    autoFit: glossFit,
  }, print))!;
  const resize = 4 / sourcePage.widthInches;
  assert.ok(Math.abs(cutBox.height - cut.nativePage.heightInches * resize) < 0.08);
  assert.ok(Math.abs(glossBox.height - cutBox.height) < 0.2);
  assert.ok(Math.abs((glossBox.minX + glossBox.width / 2) - (cutBox.minX + cutBox.width / 2)) < 0.08);
});

test("spot gloss nests inside an origin-aligned cutline instead of the PNG center", () => {
  const cut = parseOverlayEps(readFixture("Boba-Contour-Cutline.eps"), "cut.eps");
  const gloss = parseOverlayEps(readFixture("Boba-UV-Spot.eps"), "Boba-UV-Spot.eps");
  const print = {
    widthInches: cut.nativePage.widthInches,
    heightInches: cut.nativePage.heightInches,
    sourcePage: { ...cut.nativePage },
  };
  const cutFit = computeOverlayAutoFit(cut.nativePage, cut.paths, print, { role: "cutline" });
  const glossFit = computeOverlayAutoFit(gloss.nativePage, gloss.paths, print, {
    role: "spotGloss",
    siblings: [{ role: "cutline", nativePage: cut.nativePage, paths: cut.paths, autoFit: cutFit }],
  });
  assert.equal(cutFit.mode, "artboard");
  assert.ok(Math.abs(cutFit.offsetXInches) < 1e-6);
  assert.ok(glossFit.scale > cutFit.scale);

  const cutBox = overlayInkBox(transformOverlayPaths(cut.paths, {
    alignment: DEFAULT_OVERLAY_ALIGNMENT,
    autoFit: cutFit,
  }, print))!;
  const glossBox = overlayInkBox(transformOverlayPaths(gloss.paths, {
    alignment: DEFAULT_OVERLAY_ALIGNMENT,
    autoFit: glossFit,
  }, print))!;
  assert.ok(Math.abs(glossBox.width - cutBox.width) < 0.15);
  assert.ok(Math.abs(glossBox.height - cutBox.height) < 0.15);
  assert.ok(Math.abs((cutBox.minX + cutBox.width / 2) - (glossBox.minX + glossBox.width / 2)) < 0.04);
  assert.ok(Math.abs((cutBox.minY + cutBox.height / 2) - (glossBox.minY + glossBox.height / 2)) < 0.04);
});

test("spot translation search recovers a known offset", () => {
  const reference = [{
    closed: true,
    segs: [
      { op: "m" as const, x: 0, y: 0 },
      { op: "l" as const, x: 2, y: 0 },
      { op: "l" as const, x: 2, y: 3 },
      { op: "l" as const, x: 0.4, y: 2.4 },
      { op: "l" as const, x: 0, y: 3 },
      { op: "h" as const },
    ],
  }];
  const spot = [{
    closed: true,
    segs: [
      { op: "m" as const, x: 0.12, y: 0.08 },
      { op: "l" as const, x: 2.12, y: 0.08 },
      { op: "l" as const, x: 2.12, y: 3.08 },
      { op: "l" as const, x: 0.52, y: 2.48 },
      { op: "l" as const, x: 0.12, y: 3.08 },
      { op: "h" as const },
    ],
  }];
  const found = bestSpotTranslation(spot, 1, 0, 0, reference, 1, 0, 0);
  assert.ok(Math.abs(found.offsetXInches + 0.12) < 0.02, `x ${found.offsetXInches}`);
  assert.ok(Math.abs(found.offsetYInches + 0.08) < 0.02, `y ${found.offsetYInches}`);
});

test("user scale keeps the cutline centered", () => {
  const paths = [{
    closed: true,
    segs: [
      { op: "m" as const, x: 0, y: 0 },
      { op: "l" as const, x: 2, y: 0 },
      { op: "l" as const, x: 2, y: 2 },
      { op: "l" as const, x: 0, y: 2 },
      { op: "h" as const },
    ],
  }];
  const print = { widthInches: 2, heightInches: 2 };
  const overlay = {
    id: "cut",
    role: "cutline" as const,
    label: "CutContour",
    source: { filename: "cut.eps", kind: "eps" as const },
    nativePage: { widthInches: 2, heightInches: 2 },
    paths,
    alignment: DEFAULT_OVERLAY_ALIGNMENT,
    autoFit: computeOverlayAutoFit({ widthInches: 2, heightInches: 2 }, paths, print),
    visible: true,
    warnings: [],
  };
  const before = overlayInkBox(transformOverlayPaths(paths, overlay, print))!;
  const scaled = { ...overlay, alignment: applyOverlayUserScale(overlay, print, 1.4) };
  const after = overlayInkBox(transformOverlayPaths(paths, scaled, print))!;
  assert.ok(Math.abs((before.minX + before.width / 2) - (after.minX + after.width / 2)) < 0.01);
  assert.ok(Math.abs((before.minY + before.height / 2) - (after.minY + after.height / 2)) < 0.01);
  assert.ok(after.width > before.width);
});

test("resize coupling scales overlay with the print", () => {
  const paths = [{
    closed: true,
    segs: [
      { op: "m" as const, x: 0, y: 0 },
      { op: "l" as const, x: 1, y: 0 },
      { op: "l" as const, x: 1, y: 2 },
      { op: "l" as const, x: 0, y: 2 },
      { op: "h" as const },
    ],
  }];
  const autoFit = computeOverlayAutoFit({ widthInches: 1, heightInches: 2 }, paths, { widthInches: 1, heightInches: 2 });
  const grown = transformOverlayPaths(paths, {
    alignment: DEFAULT_OVERLAY_ALIGNMENT,
    autoFit,
  }, { widthInches: 2, heightInches: 4 });
  const box = overlayInkBox(grown);
  assert.ok(box);
  assert.ok(Math.abs(box.width - 2) < 0.01);
  assert.ok(Math.abs(box.height - 4) < 0.01);
});

test("nudge then export keeps matching page sizes and spot names", async () => {
  const cut = parseOverlayEps(readFixture("Boba-Contour-Cutline.eps"), "Boba-Contour-Cutline.eps");
  const gloss = parseOverlayEps(readFixture("Boba-UV-Spot.eps"), "Boba-UV-Spot.eps");
  const print = { widthInches: cut.nativePage.widthInches, heightInches: cut.nativePage.heightInches };
  const cutOverlay = {
    id: "cut",
    role: "cutline" as const,
    label: "CutContour",
    source: { filename: cut.filename, kind: cut.kind },
    nativePage: cut.nativePage,
    paths: cut.paths,
    alignment: { ...DEFAULT_OVERLAY_ALIGNMENT, offsetXInches: 0.05 },
    autoFit: computeOverlayAutoFit(cut.nativePage, cut.paths, print),
    visible: true,
    warnings: [],
  };
  const glossOverlay = {
    id: "gloss",
    role: "spotGloss" as const,
    label: "RDG_GLOSS",
    source: { filename: gloss.filename, kind: gloss.kind },
    nativePage: gloss.nativePage,
    paths: gloss.paths,
    alignment: DEFAULT_OVERLAY_ALIGNMENT,
    autoFit: computeOverlayAutoFit(gloss.nativePage, gloss.paths, print),
    visible: true,
    warnings: [],
  };

  const page = overlayPageUnion(print, [cutOverlay, glossOverlay]);
  assert.ok(Math.abs(page.widthInches - page.widthInches) < 1e-9);
  const pdf = await PDFDocument.create();
  const p1 = pdf.addPage([page.widthInches * 72, page.heightInches * 72]);
  const p2 = pdf.addPage([page.widthInches * 72, page.heightInches * 72]);
  emitOverlayOnPage(pdf, p1, cutOverlay, print, page.heightInches, page.imageOffsetX, page.imageOffsetY, "stroke");
  emitOverlayOnPage(pdf, p2, glossOverlay, print, page.heightInches, page.imageOffsetX, page.imageOffsetY, "fill");
  pdf.setSubject(overlayExportSubject("CutContour", "RDG_WHITE", "RDG_GLOSS", false));
  const bytes = await pdf.save();
  const loaded = await PDFDocument.load(bytes);
  assert.equal(loaded.getPageCount(), 2);
  const sizes = loaded.getPages().map((p) => p.getSize());
  assert.equal(sizes[0].width, sizes[1].width);
  assert.equal(sizes[0].height, sizes[1].height);
  const names1 = [...(loaded.getPages()[0].node.Resources()?.get(PDFName.of("ColorSpace")) as any)?.keys?.() ?? []].map(String);
  const names2 = [...(loaded.getPages()[1].node.Resources()?.get(PDFName.of("ColorSpace")) as any)?.keys?.() ?? []].map(String);
  assert.ok(names1.some((n: string) => n.includes("CutContour")));
  assert.ok(names2.some((n: string) => n.includes("RDG_GLOSS")));
  assert.match(loaded.getSubject() ?? "", /CutContourLabels:/);
  assert.match(overlayPathsToPDFOps(cut.paths, print.heightInches, "CutContour", "stroke"), /CS 1 SCN/);
});

test("design document v2 round-trips imported overlays", () => {
  const doc = {
    version: 2 as const,
    source: { assetId: 1, kind: "image" as const, originalWidth: 100, originalHeight: 100, dpi: 300 },
    strokeSettings: {
      width: 0,
      color: "#fff",
      enabled: false,
      alphaThreshold: 128,
      backgroundColor: "#fff",
      useCustomBackground: true,
      cornerMode: "balanced" as const,
      autoBridging: true,
      autoBridgingThreshold: 0.02,
    },
    resizeSettings: { widthInches: 2, heightInches: 3, maintainAspectRatio: true, outputDPI: 300 },
    shapeSettings: {
      enabled: false,
      type: "square" as const,
      offset: 0.25,
      fillColor: "#fff",
      strokeEnabled: false,
      strokeWidth: 2,
      strokeColor: "#000",
    },
    strokeMode: "none" as const,
    stickerSize: 4,
    cutContourLabel: "CutContour",
    spotColors: { enabled: false, tags: [] },
    segmentation: { enabled: false, mode: "colors" as const, layers: [] },
    importedOverlays: [{
      id: "cut-1",
      role: "cutline" as const,
      label: "CutContour",
      source: { filename: "cut.eps", kind: "eps" as const },
      nativePage: { widthInches: 2, heightInches: 3 },
      paths: closeNearlyOpenPaths([{
        closed: false,
        segs: [
          { op: "m" as const, x: 0, y: 0 },
          { op: "l" as const, x: 1, y: 0 },
          { op: "l" as const, x: 1, y: 1 },
          { op: "l" as const, x: 0, y: 1 },
        ],
      }]),
      alignment: DEFAULT_OVERLAY_ALIGNMENT,
      autoFit: {
        mode: "artboard" as const,
        scale: 1,
        offsetXInches: 0,
        offsetYInches: 0,
        printWidthInches: 2,
        printHeightInches: 3,
        warnings: [],
      },
      visible: true,
      warnings: [],
    }],
  };
  const parsed = serializedDesignSchema.parse(doc);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.importedOverlays?.[0].role, "cutline");
});

test("v1 design documents still parse", () => {
  const doc = {
    version: 1,
    source: { assetId: 1, kind: "image", originalWidth: 10, originalHeight: 10, dpi: 300 },
    strokeSettings: {
      width: 0.14,
      color: "#fff",
      enabled: true,
      alphaThreshold: 128,
      backgroundColor: "#fff",
      useCustomBackground: true,
      cornerMode: "balanced",
      autoBridging: true,
      autoBridgingThreshold: 0.02,
    },
    resizeSettings: { widthInches: 2, heightInches: 2, maintainAspectRatio: true, outputDPI: 300 },
    shapeSettings: {
      enabled: false,
      type: "square",
      offset: 0.25,
      fillColor: "#fff",
      strokeEnabled: false,
      strokeWidth: 2,
      strokeColor: "#000",
    },
    strokeMode: "contour",
    stickerSize: 4,
    cutContourLabel: "CutContour",
    spotColors: { enabled: false, tags: [] },
    segmentation: { enabled: false, mode: "colors", layers: [] },
  };
  assert.equal(serializedDesignSchema.parse(doc).version, 1);
});

test("empty SVG and pathless PDF are rejected", async () => {
  assert.throws(() => parseOverlaySvg("<svg xmlns='http://www.w3.org/2000/svg'></svg>", "empty.svg"), OverlayParseError);
  const emptyPdf = await PDFDocument.create();
  emptyPdf.addPage([72, 72]);
  const bytes = await emptyPdf.save();
  await assert.rejects(
    () => parseOverlayPdf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "empty.pdf"),
    OverlayParseError,
  );
});

test("huge SVG expansion is rejected", () => {
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs>`;
  svg += `<g id="p0"><rect width="1" height="1"/></g>`;
  for (let i = 1; i < 18; i++) {
    svg += `<g id="p${i}"><use href="#p${i - 1}"/><use href="#p${i - 1}"/></g>`;
  }
  svg += `</defs><use href="#p17"/></svg>`;
  assert.throws(() => parseOverlaySvg(svg, "bomb.svg"));
});

test("traced spots are suppressed when an upload exists for that channel", () => {
  const overlays = [{
    id: "g",
    role: "spotGloss" as const,
    label: "RDG_GLOSS",
    source: { filename: "g.eps", kind: "eps" as const },
    nativePage: { widthInches: 1, heightInches: 1 },
    paths: [],
    alignment: DEFAULT_OVERLAY_ALIGNMENT,
    autoFit: {
      mode: "artboard" as const,
      scale: 1,
      offsetXInches: 0,
      offsetYInches: 0,
      printWidthInches: 1,
      printHeightInches: 1,
      warnings: [],
    },
    visible: true,
    warnings: [],
  }];
  const filtered = filterTracedSpotColors([
    { hex: "#fff", spotWhite: true, spotGloss: true },
  ], overlays);
  assert.deepEqual(filtered, [{ hex: "#fff", spotWhite: true, spotGloss: false }]);
});

test("replaceOverlay appends cutlines and keeps one white or gloss", () => {
  const stub = (id: string, role: ImportedVectorOverlay["role"]): ImportedVectorOverlay => ({
    id,
    role,
    label: id,
    source: { filename: `${id}.eps`, kind: "eps" },
    nativePage: { widthInches: 1, heightInches: 1 },
    paths: [],
    alignment: DEFAULT_OVERLAY_ALIGNMENT,
    autoFit: {
      mode: "artboard",
      scale: 1,
      offsetXInches: 0,
      offsetYInches: 0,
      printWidthInches: 1,
      printHeightInches: 1,
      warnings: [],
    },
    visible: true,
    warnings: [],
  });
  const firstCut = stub("cut-1", "cutline");
  const secondCut = stub("cut-2", "cutline");
  const white = stub("white-1", "spotWhite");
  const white2 = stub("white-2", "spotWhite");
  const gloss = stub("gloss-1", "spotGloss");
  let overlays = replaceOverlay([], firstCut);
  overlays = replaceOverlay(overlays, secondCut);
  overlays = replaceOverlay(overlays, white);
  overlays = replaceOverlay(overlays, gloss);
  overlays = replaceOverlay(overlays, white2);
  assert.deepEqual(overlays.map((overlay) => overlay.id), ["cut-1", "cut-2", "gloss-1", "white-2"]);
  overlays = replaceOverlay(overlays, stub("cut-1b", "cutline"), "cut-1");
  assert.equal(overlays[0].id, "cut-1");
  assert.equal(overlays[0].label, "cut-1b");
  assert.equal(overlays.filter((overlay) => overlay.role === "cutline").length, 2);
  assert.equal(overlays.filter((overlay) => overlay.role === "spotWhite").length, 1);
});

test("gang snapshot remapping does not mutate stored paths", () => {
  const overlay = {
    id: "cut",
    role: "cutline" as const,
    label: "CutContour",
    source: { filename: "cut.eps", kind: "eps" as const },
    nativePage: { widthInches: 2, heightInches: 2 },
    paths: [{
      closed: true,
      segs: [
        { op: "m" as const, x: 0, y: 0 },
        { op: "c" as const, x1: 0.5, y1: 0, x2: 1, y2: 0.5, x: 1, y: 1 },
        { op: "h" as const },
      ],
    }],
    alignment: DEFAULT_OVERLAY_ALIGNMENT,
    autoFit: {
      mode: "artboard" as const,
      scale: 1,
      offsetXInches: 0,
      offsetYInches: 0,
      printWidthInches: 2,
      printHeightInches: 2,
      warnings: [],
    },
    visible: true,
    warnings: [],
  };
  const snap = snapshotOverlayForGang(overlay, { widthInches: 2, heightInches: 2 }, 0.1, 0.2);
  const original = cloneOverlayPaths(snap.paths);
  const remapped = remapOverlayPathsByPoint(snap.paths, (x, y) => ({ x: x + 3, y: y + 4 }));
  assert.deepEqual(snap.paths, original);
  assert.equal(remapped[0].segs[0].op, "m");
  if (remapped[0].segs[0].op === "m") assert.equal(remapped[0].segs[0].x, original[0].segs[0].op === "m" ? original[0].segs[0].x + 3 : -1);
  const rotated = remapOverlayPathsByPoint(snap.paths, (x, y) => ({ x: 2 - y, y: x }));
  assert.deepEqual(snap.paths, original);
  assert.ok(rotated[0].segs.length === snap.paths[0].segs.length);
});
