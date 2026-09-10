import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { register } from "node:module";
import { test } from "node:test";

import "../vps/src/canvas-shim.ts";
import { createCanvas } from "@napi-rs/canvas";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFStream,
} from "pdf-lib";

register(new URL("./gangsheet-worker-loader.mjs", import.meta.url));

const [{ processContour }, gangSheet] = await Promise.all([
  import("../client/src/builders/spot-uv/lib/contour-trace-core.ts"),
  import("../client/src/builders/spot-uv/lib/gang-sheet.ts"),
]);

type GangSheetItem = import("../client/src/builders/spot-uv/lib/gang-sheet.ts").GangSheetItem;
type GangSheetSettings = import("../client/src/builders/spot-uv/lib/gang-sheet.ts").GangSheetSettings;
type CachedContourData = GangSheetItem["contourData"];

const quiet = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const methods = ["log", "warn", "error", "table"] as const;
  const original = methods.map(method => [method, console[method]] as const);
  for (const [method] of original) (console as any)[method] = () => undefined;
  try {
    return await fn();
  } finally {
    for (const [method, value] of original) (console as any)[method] = value;
  }
};

let clickedLinks = 0;

function installDocumentShim() {
  const documentShim = {
    createElement(tagName: string) {
      if (tagName === "canvas") {
        return createCanvas(1, 1);
      }
      if (tagName === "a") {
        return {
          href: "",
          download: "",
          click: () => { clickedLinks++; },
        };
      }
      throw new Error(`Unsupported test document element: ${tagName}`);
    },
    body: {
      appendChild: () => undefined,
      removeChild: () => undefined,
    },
  };

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentShim,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { hardwareConcurrency: 2, userAgent: "node", maxTouchPoints: 0 },
  });
}

installDocumentShim();

const strokeSettings = {
  width: 0.01,
  color: "#000000",
  enabled: true,
  alphaThreshold: 128,
  backgroundColor: "#ffffff",
  useCustomBackground: true,
  autoBridging: false,
  autoBridgingThreshold: 0.01,
  contourMode: "smooth" as const,
  includeHoles: false,
};

function makeNotchedArt(width = 96, height = 72) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  // A narrow, deep inlet: the export bleed should fill the mouth without
  // changing the outer bounds.
  ctx.moveTo(8, 8);
  ctx.lineTo(width - 8, 8);
  ctx.lineTo(width - 8, height - 8);
  ctx.lineTo(width / 2 + 6, height - 8);
  ctx.lineTo(width / 2 + 6, 30);
  ctx.lineTo(width / 2 - 6, 30);
  ctx.lineTo(width / 2 - 6, height - 8);
  ctx.lineTo(8, height - 8);
  ctx.closePath();
  ctx.fill();
  return canvas;
}

function makeSpotArt(width = 96, height = 72) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(12, 12, width - 24, height - 24);
  return canvas;
}

function imageDataOf(canvas: ReturnType<typeof createCanvas>) {
  return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
}

function asImageElement(canvas: ReturnType<typeof createCanvas>): HTMLImageElement {
  return canvas as unknown as HTMLImageElement;
}

function contourFrom(
  canvas: ReturnType<typeof createCanvas>,
  settings: typeof strokeSettings = strokeSettings,
  detectedShapeType?: "rectangle",
  detectedShapeBBox?: { x: number; y: number; width: number; height: number },
  previewMode = false,
): Promise<CachedContourData> {
  return quiet(() => processContour(
    imageDataOf(canvas),
    settings,
    300,
    previewMode,
    detectedShapeType,
    detectedShapeBBox,
  )).then(result => result.contourData);
}

function centerBandDepth(points: Array<{ x: number; y: number }>): number {
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const centerX = (minX + maxX) / 2;
  const halfBand = (maxX - minX) * 0.08;
  const centerBand = points.filter(point => Math.abs(point.x - centerX) <= halfBand);
  assert.ok(centerBand.length > 0, "narrow-inlet contour should retain center-band points");
  return Math.max(...centerBand.map(point => point.y))
    - Math.min(...centerBand.map(point => point.y));
}

function itemSnapshot(item: GangSheetItem): string {
  return JSON.stringify({
    contourData: item.contourData,
    resizeSettings: item.resizeSettings,
    strokeSettings: item.strokeSettings,
    shapeSettings: item.shapeSettings,
    cutContourLabel: item.cutContourLabel,
    noCutPath: item.noCutPath,
    quantity: item.quantity,
    spotColors: item.spotColors,
    spotPixelMap: item.spotPixelMap
      ? {
          mapWidth: item.spotPixelMap.mapWidth,
          mapHeight: item.spotPixelMap.mapHeight,
          pixelMap: Array.from(item.spotPixelMap.pixelMap),
        }
      : undefined,
  });
}

function makeItem(
  id: string,
  canvas: ReturnType<typeof createCanvas>,
  contourData: CachedContourData,
  quantity: number,
  options: {
    shape?: GangSheetItem["shapeSettings"];
    spotColors?: GangSheetItem["spotColors"];
    resize?: { widthInches: number; heightInches: number };
  } = {},
): GangSheetItem {
  const resize = options.resize ?? {
    widthInches: contourData.widthInches,
    heightInches: contourData.heightInches,
  };
  return {
    id,
    thumbnail: "",
    imageElement: asImageElement(canvas),
    contourData,
    resizeSettings: {
      widthInches: resize.widthInches,
      heightInches: resize.heightInches,
      maintainAspectRatio: false,
      outputDPI: 300,
    },
    strokeSettings: { ...strokeSettings },
    shapeSettings: options.shape,
    cutContourLabel: "CutContour",
    quantity,
    spotColors: options.spotColors,
  };
}

function streamContents(pdf: PDFDocument, value: unknown): string {
  const stream = pdf.context.lookup(value as any) as PDFStream;
  const raw = stream.getContents();
  const filter = stream.dict.get(PDFName.of("Filter"));
  if (filter instanceof PDFName && filter.asString() === "FlateDecode") {
    return inflateSync(Buffer.from(raw)).toString("latin1");
  }
  return Buffer.from(raw).toString("latin1");
}

function pageContent(pdf: PDFDocument, page: ReturnType<PDFDocument["getPages"]>[number]) {
  const contents = page.node.Contents();
  if (!contents) return "";
  const entries = contents instanceof PDFArray ? contents.asArray() : [contents];
  return entries.map(entry => streamContents(pdf, entry)).join("\n");
}

function separationNames(pdf: PDFDocument, page: ReturnType<PDFDocument["getPages"]>[number]) {
  const resources = page.node.Resources();
  assert.ok(resources, "export page should have PDF resources");
  const colorSpaces = resources.lookupMaybe(PDFName.of("ColorSpace"), PDFDict);
  assert.ok(colorSpaces, "export page should register color spaces");
  return colorSpaces.keys().map(name => name.asString().replace(/^\/+/, ""));
}

function assertPlacementGeometry(
  placements: ReturnType<typeof gangSheet.packGangSheet>["placements"],
  items: GangSheetItem[],
  settings: GangSheetSettings,
) {
  const byId = new Map(items.map(item => [item.id, item]));
  for (const placement of placements) {
    const item = byId.get(placement.itemId);
    assert.ok(item, `placement references known item ${placement.itemId}`);
    const contourW = item.contourData.widthInches;
    const contourH = item.contourData.heightInches;
    const expectedW = placement.rotated ? contourH : contourW;
    const expectedH = placement.rotated ? contourW : contourH;
    assert.ok(Math.abs(placement.width - expectedW) < 1e-8);
    assert.ok(Math.abs(placement.height - expectedH) < 1e-8);
    assert.ok(placement.x >= settings.edgePadding - 1e-7);
    assert.ok(placement.y >= settings.edgePadding - 1e-7);
    assert.ok(placement.x + placement.width <= settings.sheetWidth - settings.edgePadding + 1e-7);
    assert.ok(placement.y + placement.height <= settings.sheetHeight - settings.edgePadding + 1e-7);
  }

  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i], b = placements[j];
      const separatedX = a.x + a.width + settings.gap <= b.x + 1e-6
        || b.x + b.width + settings.gap <= a.x + 1e-6;
      const separatedY = a.y + a.height + settings.gap <= b.y + 1e-6
        || b.y + b.height + settings.gap <= a.y + 1e-6;
      assert.ok(separatedX || separatedY, `placements ${i} and ${j} must keep the nesting gap`);
    }
  }
}

test("actual contour results pack and export one bounded gang-sheet page", async () => {
  const notchedCanvas = makeNotchedArt();
  const spotCanvas = makeSpotArt();
  const notchedPreview = await contourFrom(notchedCanvas, strokeSettings, undefined, undefined, true);
  const notchedContour = await contourFrom(notchedCanvas);
  const zeroHeroContour = await contourFrom(notchedCanvas, { ...strokeSettings, width: 0 });
  const shapeContour = await contourFrom(
    spotCanvas,
    strokeSettings,
    "rectangle",
    { x: 12, y: 12, width: 72, height: 48 },
  );

  assert.ok(notchedContour.pathPoints.length >= 3);
  assert.ok(zeroHeroContour.pathPoints.length >= 3);
  assert.ok(shapeContour.pathPoints.length >= 3);
  assert.ok(
    notchedContour.widthInches > 0 && notchedContour.heightInches > 0,
    "the narrow-inlet export must produce real inch bounds",
  );
  const previewInletDepth = centerBandDepth(notchedPreview.previewPathPoints);
  const exportInletDepth = centerBandDepth(notchedContour.previewPathPoints);
  assert.ok(
    previewInletDepth > exportInletDepth + 0.5,
    `export bleed should close the representative narrow inlet (${previewInletDepth} vs ${exportInletDepth})`,
  );
  assert.ok(
    centerBandDepth(zeroHeroContour.previewPathPoints) > exportInletDepth + 0.5,
    "Zero Hero should retain the source inlet instead of applying bleed closure",
  );
  assert.ok(
    zeroHeroContour.widthInches > 0 && shapeContour.widthInches > 0,
    "zero-hero and shape contours must be real processContour results",
  );

  const narrow = makeItem("narrow", notchedCanvas, notchedContour, 2);
  const zeroHero = makeItem("zero-hero", notchedCanvas, zeroHeroContour, 1);
  const shape = makeItem("shape", spotCanvas, shapeContour, 1, {
    shape: {
      enabled: true,
      type: "rectangle",
      offset: 0,
      fillColor: "#ffffff",
      strokeEnabled: false,
      strokeWidth: 0,
      strokeColor: "#000000",
    },
    resize: { widthInches: shapeContour.widthInches, heightInches: shapeContour.heightInches },
  });
  const items = [narrow, zeroHero, shape];
  const snapshots = items.map(itemSnapshot);
  const settings = {
    sheetWidth: 0.7,
    sheetHeight: 3,
    gap: 0.25,
    edgePadding: 0.1,
  };
  const pack = gangSheet.packGangSheet(items, settings);

  assert.equal(pack.overflow, 0, JSON.stringify(pack));
  assert.equal(pack.placements.length, 4);
  assertPlacementGeometry(pack.placements, items, settings);
  assert.ok(
    pack.placements.some(placement => placement.rotated),
    `the constrained representative gang should exercise quarter-turn placement: ${JSON.stringify(pack.placements)}`,
  );

  clickedLinks = 0;
  const blob = await quiet(() =>
    gangSheet.downloadGangSheetPDF(items, settings, pack.placements),
  );
  assert.equal(blob.type, "application/pdf");
  assert.ok(blob.size > 500, "export should be a real non-empty PDF blob");
  assert.equal(clickedLinks, 1, "a successful export should click exactly one download link");

  const pdf = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(pdf.getPageCount(), 1);
  const page = pdf.getPages()[0];
  assert.ok(Math.abs(page.getWidth() - settings.sheetWidth * 72) < 1e-6);
  assert.ok(Math.abs(page.getHeight() - settings.sheetHeight * 72) < 1e-6);

  const names = separationNames(pdf, page);
  assert.ok(names.includes("CutContour"), "page must register the CutContour separation");
  const content = pageContent(pdf, page);
  assert.match(content, /\/CutContour\s+CS\s+1\s+SCN/);
  assert.match(content, /\sS\s/);

  assert.deepEqual(items.map(itemSnapshot), snapshots, "PDF export must not mutate item snapshots");
});

test("all-tagged White and Gloss snapshots produce actual tiled separation pages", async () => {
  const canvas = makeSpotArt();
  const contour = await contourFrom(canvas);
  const spotColors = [{
    hex: "#ff0000",
    rgb: { r: 255, g: 0, b: 0 },
    spotWhite: true,
    spotGloss: true,
    spotWhiteName: "RDG_WHITE",
    spotGlossName: "RDG_GLOSS",
    spotFluorY: false,
    spotFluorM: false,
    spotFluorG: false,
    spotFluorOrange: false,
  }];
  const item = makeItem("white-gloss", canvas, contour, 2, { spotColors });
  const before = itemSnapshot(item);
  const settings = { sheetWidth: 2.5, sheetHeight: 1.5, gap: 0.25, edgePadding: 0.1 };
  const pack = gangSheet.packGangSheet([item], settings);

  assert.equal(pack.overflow, 0);
  assert.equal(pack.placements.length, 2);
  const blob = await quiet(() =>
    gangSheet.downloadGangSheetPDF([item], settings, pack.placements),
  );
  const pdf = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(pdf.getPageCount(), 3, "base + one page per requested separation");

  const pageNames = pdf.getPages().map(page => separationNames(pdf, page));
  assert.ok(pageNames[0].includes("CutContour"), JSON.stringify(pageNames));
  assert.ok(pageNames.some(names => names.includes("RDG_WHITE")));
  assert.ok(pageNames.some(names => names.includes("RDG_GLOSS")));
  assert.deepEqual(itemSnapshot(item), before, "spot snapshots must survive multi-page export");
});

test("requested separation failure rejects before creating a download", async () => {
  const canvas = makeSpotArt();
  const contour = await contourFrom(canvas);
  const item = makeItem("failing-spot", canvas, contour, 1, {
    spotColors: [{
      hex: "#ff0000",
      rgb: { r: 255, g: 0, b: 0 },
      spotWhite: true,
      spotGloss: false,
      spotWhiteName: "RDG_WHITE",
      spotGlossName: "RDG_GLOSS",
      spotFluorY: false,
      spotFluorM: false,
      spotFluorG: false,
      spotFluorOrange: false,
    }],
  });
  const settings = { sheetWidth: 2.5, sheetHeight: 1.5, gap: 0.25, edgePadding: 0.1 };
  const pack = gangSheet.packGangSheet([item], settings);

  clickedLinks = 0;
  const originalAddPage = PDFDocument.prototype.addPage;
  let addPageCalls = 0;
  PDFDocument.prototype.addPage = function (...args) {
    addPageCalls++;
    if (addPageCalls === 2) throw new Error("intentional separation page failure");
    return originalAddPage.apply(this, args);
  };
  try {
    await assert.rejects(
      quiet(() => gangSheet.downloadGangSheetPDF([item], settings, pack.placements)),
      /Could not generate the gang sheet spot-color layers/,
    );
  } finally {
    PDFDocument.prototype.addPage = originalAddPage;
  }
  assert.equal(clickedLinks, 0, "a failed spot export must not click a download link");
});