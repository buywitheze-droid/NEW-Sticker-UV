import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { createServer, type ViteDevServer } from "vite";
import { test } from "node:test";
import { Canvas, DOMMatrix, Image, ImageData as NapiImageData, Path2D, createCanvas } from "@napi-rs/canvas";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from "pdf-lib";

import "../vps/src/canvas-shim.ts";

/**
 * These tests deliberately exercise the browser exporters through Vite's
 * production module graph.  The worker shim still calls the real spot-color
 * tracing core, while pdf-lib parses the bytes emitted by the exporter.
 */
const downloads = new Map<string, Blob>();
let nextUrl = 1;
Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  writable: true,
  value: (blob: Blob) => {
    const url = `blob:custom-spot-${nextUrl++}`;
    downloads.set(url, blob);
    return url;
  },
});
Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });

class DownloadAnchor {
  href = "";
  download = "";
  click(): void {}
}

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    createElement(tag: string): any {
      if (tag === "canvas") return createCanvas(1, 1);
      if (tag === "a") return new DownloadAnchor();
      throw new Error(`custom-spot-names: unsupported element ${tag}`);
    },
    body: { appendChild: () => undefined, removeChild: () => undefined },
  },
});
Object.defineProperty(globalThis, "Image", { configurable: true, value: Image });
Object.defineProperty(globalThis, "ImageData", { configurable: true, value: NapiImageData });
Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, value: Canvas });
Object.defineProperty(globalThis, "DOMMatrix", { configurable: true, value: DOMMatrix });
Object.defineProperty(globalThis, "Path2D", { configurable: true, value: Path2D });
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { hardwareConcurrency: 1, maxTouchPoints: 0, userAgent: "custom-spot-names" },
});
if (!(Promise as any).withResolvers) {
  (Promise as any).withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

let spotCore: Record<string, any>;
let traceCalls = 0;
class InlineSpotWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private listeners = new Map<string, Set<(event: any) => void>>();

  postMessage(message: any): void {
    if (message?.type !== "trace") return;
    traceCalls++;
    queueMicrotask(() => {
      try {
        const pixels = new Uint8ClampedArray(message.imageBuffer);
        const fullAlpha = message.fullAlphaMask
          ? new Uint8Array(message.fullAlphaMask)
          : undefined;
        const region = spotCore.processOneSeparation(
          pixels,
          message.imageWidth,
          message.imageHeight,
          message.spotColors,
          message.markedColors,
          message.regionName,
          message.dpi,
          message.exactSelection,
          fullAlpha,
          message.allTaggedWhite,
          message.allTaggedGloss,
        );
        const event = { data: { type: "result", regions: region ? [region] : [] } };
        this.onmessage?.(event as MessageEvent);
        for (const listener of this.listeners.get("message") ?? []) listener(event);
      } catch (error) {
        const event = { message: String(error) };
        this.onerror?.(event as ErrorEvent);
        for (const listener of this.listeners.get("error") ?? []) listener(event);
      }
    });
  }

  terminate(): void {}
  addEventListener(type: string, listener: (event: any) => void): void {
    let entries = this.listeners.get(type);
    if (!entries) this.listeners.set(type, entries = new Set());
    entries.add(listener);
  }
  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
}
Object.defineProperty(globalThis, "Worker", { configurable: true, value: InlineSpotWorker });

const viteServer: ViteDevServer = await createServer({
  configFile: "./vite.config.ts",
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
});
spotCore = await viteServer.ssrLoadModule("/src/builders/spot-uv/lib/spot-color-trace-core.ts");
const shapeModule = await viteServer.ssrLoadModule("/src/builders/spot-uv/lib/shape-outline.ts");
const legacyShapeModule = await viteServer.ssrLoadModule("/src/lib/shape-outline.ts");
const contourModule = await viteServer.ssrLoadModule("/src/builders/spot-uv/lib/contour-outline.ts");
const legacyContourModule = await viteServer.ssrLoadModule("/src/lib/contour-outline.ts");
const gangModule = await viteServer.ssrLoadModule("/src/builders/spot-uv/lib/gang-sheet.ts");
const legacyGangModule = await viteServer.ssrLoadModule("/src/lib/gang-sheet.ts");
const vectorStrokeModule = await viteServer.ssrLoadModule("/src/lib/vector-stroke.ts");
const pdfParserModule = await viteServer.ssrLoadModule("/src/builders/spot-uv/lib/pdf-parser.ts");
const schemaModule = await import("../shared/design-document.ts");
const { pdfNameToken } = await import("../client/src/lib/pdf-name.ts");

test.after(async () => {
  await viteServer.close();
});

function streamText(pdf: PDFDocument, value: unknown): string {
  let stream = value as PDFStream;
  if (!(stream instanceof PDFStream)) stream = pdf.context.lookup(value as any) as PDFStream;
  const raw = stream.getContents();
  const filter = stream.dict.get(PDFName.of("Filter"));
  if (filter instanceof PDFName && filter.asString() === "FlateDecode") {
    return inflateSync(Buffer.from(raw)).toString("latin1");
  }
  return Buffer.from(raw).toString("latin1");
}

function pageContent(pdf: PDFDocument, page: ReturnType<PDFDocument["getPages"]>[number]): string {
  const contents = page.node.Contents();
  if (!contents) return "";
  const entries = contents instanceof PDFArray ? contents.asArray() : [contents];
  return entries.map(entry => streamText(pdf, entry)).join("\n");
}

function separationNames(pdf: PDFDocument, page: ReturnType<PDFDocument["getPages"]>[number]): string[] {
  const resources = page.node.Resources();
  assert.ok(resources);
  const colors = resources.lookupMaybe(PDFName.of("ColorSpace"), PDFDict);
  assert.ok(colors);
  return colors.keys().map(name => (name as PDFName).decodeText());
}

function makeSpotColors() {
  return [{
    hex: "#ff0000",
    rgb: { r: 255, g: 0, b: 0 },
    spotWhite: true,
    spotGloss: true,
    spotWhiteName: "White#20 / #2f",
    spotGlossName: "Varnish#2f #20",
    spotFluorY: false,
    spotFluorM: false,
    spotFluorG: false,
    spotFluorOrange: false,
  }];
}

function makeImage(): HTMLImageElement {
  const canvas = createCanvas(48, 36);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(4, 4, 40, 28);
  Object.defineProperty(canvas, "naturalWidth", { value: canvas.width });
  Object.defineProperty(canvas, "naturalHeight", { value: canvas.height });
  return canvas as unknown as HTMLImageElement;
}

const shapeSettings = {
  enabled: true,
  type: "rectangle" as const,
  offset: 0,
  fillColor: "#ffffff",
  strokeEnabled: false,
  strokeWidth: 0,
  strokeColor: "#000000",
};
const resizeSettings = {
  widthInches: 2,
  heightInches: 1.5,
  maintainAspectRatio: false,
  outputDPI: 300,
};

test("custom contour persistence accepts trimmed arbitrary names and rejects empty names", () => {
  const parsed = schemaModule.cutContourLabelSchema.safeParse("  Die / #20/#2f line  ");
  assert.equal(parsed.success, true);
  assert.equal(parsed.data, "Die / #20/#2f line");
  assert.equal(schemaModule.cutContourLabelSchema.safeParse("").success, false);
  assert.equal(schemaModule.cutContourLabelSchema.safeParse(" \t\n ").success, false);
});

test("base64 contour/shape PDF subjects carry the custom contour marker in both libraries", async () => {
  const label = "Email#20 / #2f";
  const shapeBase64s = await Promise.all([
    shapeModule.generateShapePDFBase64(makeImage(), shapeSettings, resizeSettings, label),
    legacyShapeModule.generateShapePDFBase64(makeImage(), shapeSettings, resizeSettings, label),
  ]);
  for (const base64 of shapeBase64s) {
    assert.ok(base64);
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const pdf = await PDFDocument.load(bytes);
    assert.match(pdf.getSubject() ?? "", /CutContourLabels:Email%2320%20%2F%20%232f/);
    assert.ok(separationNames(pdf, pdf.getPages()[0]).includes(label));
  }
  const contourData = {
    pathPoints: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1.5 }, { x: 0, y: 1.5 }],
    previewPathPoints: [],
    widthInches: 2,
    heightInches: 1.5,
    imageOffsetX: 0,
    imageOffsetY: 0,
    backgroundColor: "#fff",
    effectiveDPI: 300,
    minPathX: 0,
    minPathY: 0,
    bleedInches: 0,
  };
  const strokeSettings = { width: 0.01, color: "#000", enabled: true } as any;
  const contourBase64s = await Promise.all([
    contourModule.generateContourPDFBase64(makeImage(), strokeSettings, resizeSettings, contourData, label),
    legacyContourModule.generateContourPDFBase64(makeImage(), strokeSettings, resizeSettings, contourData, label),
  ]);
  for (const base64 of contourBase64s) {
    assert.ok(base64);
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const pdf = await PDFDocument.load(bytes);
    assert.match(pdf.getSubject() ?? "", /CutContourLabels:Email%2320%20%2F%20%232f/);
    assert.ok(separationNames(pdf, pdf.getPages()[0]).includes(label));
  }
});

test("shape PDF emits escaped custom CutContour, White, and Varnish names", async () => {
  downloads.clear();
  await shapeModule.downloadShapePDF(
    makeImage(),
    shapeSettings,
    resizeSettings,
    "custom.pdf",
    makeSpotColors(),
    true,
    "Die / #20/#2f line",
    {
      label: "Locked#20/#2f",
      pathPoints: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1.5 }, { x: 0, y: 1.5 }],
      widthInches: 2,
      heightInches: 1.5,
      imageOffsetX: 0,
      imageOffsetY: 0,
    },
  );
  const blob = [...downloads.values()].at(-1);
  assert.ok(blob);
  const pdf = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()));
  const page = pdf.getPages()[0];
  const names = separationNames(pdf, page);
  assert.deepEqual(names.sort(), ["Die / #20/#2f line", "Locked#20/#2f", "Varnish#2f #20", "White#20 / #2f"].sort());
  const content = pageContent(pdf, page);
  assert.match(content, new RegExp(`${pdfNameToken("Die / #20/#2f line")} CS`));
  assert.match(content, new RegExp(`${pdfNameToken("White#20 / #2f")} cs`));
  assert.match(content, new RegExp(`${pdfNameToken("Varnish#2f #20")} cs`));
  assert.match(content, new RegExp(`${pdfNameToken("Locked#20/#2f")} CS`));
  assert.doesNotMatch(content, /\/Die\s+\/\s+#\s+line/);
});

test("own custom CutContour PDF metadata round-trips through the PDF parser", async () => {
  downloads.clear();
  await shapeModule.downloadShapePDF(
    makeImage(),
    shapeSettings,
    resizeSettings,
    "custom-roundtrip.pdf",
    [],
    true,
    "Die / #20/#2f line",
  );
  const blob = [...downloads.values()].at(-1);
  assert.ok(blob);
  const parsed = await pdfParserModule.parsePDF({
    arrayBuffer: () => blob.arrayBuffer(),
  } as File);
  assert.equal(parsed.cutContourInfo.hasCutContour, true);
  assert.equal(parsed.cutContourInfo.detectedLabel, "Die / #20/#2f line");
});

test("gangsheet item-level White/Varnish names and custom cut label survive export", async () => {
  downloads.clear();
  const item = {
    id: "custom-item",
    thumbnail: "",
    imageElement: makeImage(),
    contourData: {
      pathPoints: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1.5 }, { x: 0, y: 1.5 }],
      previewPathPoints: [],
      widthInches: 2,
      heightInches: 1.5,
      imageOffsetX: 0,
      imageOffsetY: 0,
      backgroundColor: "#ffffff",
      effectiveDPI: 300,
      minPathX: 0,
      minPathY: 0,
      bleedInches: 0,
    },
    resizeSettings,
    strokeSettings: { width: 0.01, color: "#000", enabled: true, alphaThreshold: 128, backgroundColor: "#fff", useCustomBackground: true, autoBridging: false, autoBridgingThreshold: 0.01, cornerMode: "rounded" as const },
    cutContourLabel: "Gang#20 / #2f cut",
    quantity: 1,
    spotColors: [{ ...makeSpotColors()[0], spotWhiteName: undefined, spotGlossName: undefined }],
    spotWhiteName: "White#20 / #2f",
    spotGlossName: "Varnish#2f #20",
  };
  const blob = await gangModule.downloadGangSheetItemPDF(item);
  const pdf = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()));
  assert.ok(separationNames(pdf, pdf.getPages()[0]).includes("Gang#20 / #2f cut"));
  assert.ok(separationNames(pdf, pdf.getPages()[1]).includes("White#20 / #2f"));
  assert.ok(separationNames(pdf, pdf.getPages()[2]).includes("Varnish#2f #20"));
  assert.match(pdf.getSubject() ?? "", /CutContourLabels:Gang%2320%20%2F%20%232f%20cut/);
});

test("gangsheet rejects cut names colliding with effective White/Varnish names before either export mode starts", async () => {
  const collisionCases = [
    {
      name: "same-item default White",
      items: [{
        id: "same-white",
        cutContourLabel: "rdg_white",
        spotColors: [{ ...makeSpotColors()[0], spotGloss: false, spotWhiteName: undefined }],
      }],
      conflictingItem: "same-white",
    },
    {
      name: "same-item default Gloss",
      items: [{
        id: "same-gloss",
        cutContourLabel: "RDG_GLOSS",
        spotColors: [{ ...makeSpotColors()[0], spotWhite: false, spotGlossName: undefined }],
      }],
      conflictingItem: "same-gloss",
    },
    {
      name: "cross-item default",
      items: [
        { id: "default-cut", cutContourLabel: "RDG_WHITE", spotColors: [] },
        {
          id: "default-white",
          cutContourLabel: "Other cut",
          spotColors: [{ ...makeSpotColors()[0], spotGloss: false, spotWhiteName: undefined }],
        },
      ],
      conflictingItem: "default-white",
    },
    {
      name: "cross-item custom",
      items: [
        { id: "custom-cut", cutContourLabel: "Unique cut", spotColors: [] },
        {
          id: "custom-white",
          cutContourLabel: "Other cut",
          spotColors: [{
            ...makeSpotColors()[0],
            spotWhiteName: "Unique cut",
            spotGlossName: undefined,
          }],
        },
      ],
      conflictingItem: "custom-white",
    },
  ];

  for (const module of [gangModule, legacyGangModule]) {
    for (const singleArtboard of [false, true]) {
      for (const collision of collisionCases) {
        downloads.clear();
        const tracesBefore = traceCalls;
        await assert.rejects(
          () => module.downloadGangSheetPDF(
            collision.items as any,
            { sheetWidth: 4, sheetHeight: 4 } as any,
            [],
            singleArtboard,
          ),
          new RegExp(`Gang sheet export rejected:.*item "${collision.conflictingItem}"`),
          `${collision.name} should be rejected`,
        );
        assert.equal(traceCalls, tracesBefore, `${collision.name} must fail before spot tracing starts`);
        assert.equal(downloads.size, 0, `${collision.name} must fail before any download is created`);
      }
    }
  }
});

test("gangsheet allows the same default separation names across noncolliding items", async () => {
  const items = [
    {
      id: "first",
      cutContourLabel: "Cut one",
      spotColors: [{ ...makeSpotColors()[0], spotWhiteName: undefined, spotGlossName: undefined }],
    },
    {
      id: "second",
      cutContourLabel: "Cut two",
      spotColors: [{ ...makeSpotColors()[0], spotWhiteName: undefined, spotGlossName: undefined }],
    },
  ];

  for (const module of [gangModule, legacyGangModule]) {
    for (const singleArtboard of [false, true]) {
      await module.downloadGangSheetPDF(
        items as any,
        { sheetWidth: 4, sheetHeight: 4 } as any,
        [],
        singleArtboard,
      );
    }
  }
});

test("SVG export records custom spot name with XML escaping", () => {
  downloads.clear();
  vectorStrokeModule.downloadVectorStroke(
    createCanvas(8, 8),
    "custom.svg",
    "svg",
    { paths: ["M 0 0 L 1 1 Z"], bounds: { width: 8, height: 8 } },
    'Die " / # & line',
  );
  const blob = [...downloads.values()].at(-1);
  assert.ok(blob);
  return blob.text().then(svg => {
    assert.match(svg, /data-spot-name="Die &quot; \/ # &amp; line"/);
    assert.doesNotMatch(svg, /data-spot-name="Die " \/ # & line"/);
  });
});