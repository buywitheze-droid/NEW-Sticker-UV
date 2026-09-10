import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { createServer, type ViteDevServer } from "vite";
import {
  Canvas,
  Image,
  ImageData as NapiImageData,
  createCanvas,
} from "@napi-rs/canvas";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
} from "pdf-lib";

import "../vps/src/canvas-shim.ts";

/**
 * This is intentionally a real export harness rather than a PDF writer mock.
 *
 * Vite SSR is used only to load the production modules which contain
 * `?worker` imports; plain tsx cannot instantiate those imports in Node. The
 * Worker shim dispatches contour and spot-color messages to the actual shared
 * trace cores, so ContourWorkerManager still receives and caches a real
 * worker-shaped result. @napi-rs/canvas supplies ImageData/canvas pixels and
 * the small DOM shim captures the blobs produced by the download functions.
 */

type ProductionModule = Record<string, any>;
type Download = { filename: string; blob: Blob };

const downloads: Download[] = [];
const objectUrls = new Map<string, Blob>();
let nextObjectUrl = 1;

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  writable: true,
  value: (blob: Blob) => {
    const url = `blob:test-download-${nextObjectUrl++}`;
    objectUrls.set(url, blob);
    return url;
  },
});
Object.defineProperty(URL, "revokeObjectURL", {
  configurable: true,
  writable: true,
  value: (url: string) => {
    // Keep captured blobs alive long enough for assertions. The production
    // path still calls revokeObjectURL, as it would in a browser.
    void url;
  },
});

class DownloadAnchor {
  href = "";
  download = "";
  style: Record<string, string> = {};

  click(): void {
    const blob = objectUrls.get(this.href);
    if (blob) downloads.push({ filename: this.download, blob });
  }
}

const documentShim = {
  createElement(tagName: string): any {
    if (tagName === "canvas") return createCanvas(1, 1);
    if (tagName === "a") return new DownloadAnchor();
    throw new Error(`single-contour-download test: unsupported element ${tagName}`);
  },
  body: {
    appendChild<T>(element: T): T {
      return element;
    },
    removeChild<T>(element: T): T {
      return element;
    },
  },
};

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: documentShim,
});
Object.defineProperty(globalThis, "Image", {
  configurable: true,
  value: Image,
});
Object.defineProperty(globalThis, "ImageData", {
  configurable: true,
  value: NapiImageData,
});
Object.defineProperty(globalThis, "OffscreenCanvas", {
  configurable: true,
  value: Canvas,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    hardwareConcurrency: 1,
    maxTouchPoints: 0,
    userAgent: "Node.js single contour download test",
  },
});

let contourCore: ProductionModule | null = null;
let spotColorCore: ProductionModule | null = null;
let nextImageId = 1;

type Listener = (event: { data?: any; message?: string }) => void;

/**
 * Worker shim for the two production worker pools used by an individual
 * export. It is deliberately narrow: no app code is altered, and all pixel
 * tracing is delegated to the production core modules loaded by Vite.
 */
class InlineProductionWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private listeners = new Map<string, Set<Listener>>();

  constructor(_url?: unknown, _options?: unknown) {
    // worker-health.ts expects the probe worker to announce readiness after
    // listeners have been attached.
    queueMicrotask(() => this.emit("message", { data: { ready: true } }));
  }

  addEventListener(type: string, listener: Listener): void {
    let entries = this.listeners.get(type);
    if (!entries) {
      entries = new Set();
      this.listeners.set(type, entries);
    }
    entries.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: any): void {
    if (message?.ping === 1) {
      queueMicrotask(() => this.emit("message", { data: { ok: true, echo: message } }));
      return;
    }

    queueMicrotask(() => {
      try {
        if (message?.type === "process") {
          assert.ok(contourCore, "contour trace core was not loaded");
          const result = contourCore.processContour(
            message.imageData,
            message.strokeSettings,
            message.effectiveDPI,
            message.previewMode,
            message.detectedShapeType,
            message.detectedShapeBBox,
          );
          this.emit("message", {
            data: {
              type: "result",
              imageData: result.imageData,
              imageCanvasX: result.imageCanvasX,
              imageCanvasY: result.imageCanvasY,
              contourData: result.contourData,
              detectedAlgorithm: result.detectedAlgorithm,
            },
          });
          return;
        }

        if (message?.type === "trace") {
          assert.ok(spotColorCore, "spot-color trace core was not loaded");
          const pixels = new Uint8ClampedArray(message.imageBuffer);
          const fullAlphaMask = message.fullAlphaMask
            ? new Uint8Array(message.fullAlphaMask)
            : undefined;
          const region = message.regionName
            ? spotColorCore.processOneSeparation(
                pixels,
                message.imageWidth,
                message.imageHeight,
                message.spotColors,
                message.markedColors,
                message.regionName,
                message.dpi,
                message.exactSelection,
                fullAlphaMask,
                message.allTaggedWhite,
                message.allTaggedGloss,
              )
            : null;
          const regions = message.regionName
            ? (region ? [region] : [])
            : spotColorCore.processSpotColors(
                pixels,
                message.imageWidth,
                message.imageHeight,
                message.spotColors,
                message.dpi,
                message.whiteInclusionMask
                  ? new Uint8Array(message.whiteInclusionMask)
                  : undefined,
                message.glossInclusionMask
                  ? new Uint8Array(message.glossInclusionMask)
                  : undefined,
                fullAlphaMask,
                message.allTaggedWhite,
                message.allTaggedGloss,
                message.exactSelection,
              );
          this.emit("message", { data: { type: "result", regions } });
        }
      } catch (error) {
        this.emit("error", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  terminate(): void {}

  private emit(type: string, event: { data?: any; message?: string }): void {
    if (type === "message") {
      this.onmessage?.(event as MessageEvent);
    }
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

Object.defineProperty(globalThis, "Worker", {
  configurable: true,
  value: InlineProductionWorker,
});

const viteServer: ViteDevServer = await createServer({
  configFile: "./vite.config.ts",
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
});

const contourCoreModule = await viteServer.ssrLoadModule(
  "/src/builders/spot-uv/lib/contour-trace-core.ts",
);
const spotColorCoreModule = await viteServer.ssrLoadModule(
  "/src/builders/spot-uv/lib/spot-color-trace-core.ts",
);
contourCore = contourCoreModule;
spotColorCore = spotColorCoreModule;

const contourOutlineModule = await viteServer.ssrLoadModule(
  "/src/builders/spot-uv/lib/contour-outline.ts",
);
const contourWorkerManagerModule = await viteServer.ssrLoadModule(
  "/src/builders/spot-uv/lib/contour-worker-manager.ts",
);
const vectorStrokeModule = await viteServer.ssrLoadModule(
  "/src/builders/spot-uv/lib/vector-stroke.ts",
);

test.after(async () => {
  contourWorkerManagerModule.getContourWorkerManager().terminate();
  await viteServer.close();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: originalCreateObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: originalRevokeObjectURL,
  });
});

function clearDownloads(): void {
  downloads.length = 0;
}

function latestDownload(expectedFilename: string): Download {
  const download = downloads.at(-1);
  assert.ok(download, `expected ${expectedFilename} to be downloaded`);
  assert.equal(download.filename, expectedFilename);
  return download;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function quietLogs<T>(fn: () => T): T {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

async function quietLogsAsync<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function makeStickerImage(): HTMLImageElement {
  const source = createCanvas(64, 48);
  const ctx = source.getContext("2d");
  ctx.clearRect(0, 0, source.width, source.height);
  ctx.fillStyle = "#e33b56";
  ctx.fillRect(10, 8, 44, 32);
  // A second colour makes nonempty artwork and spot-region tracing explicit.
  ctx.fillStyle = "#ffd166";
  ctx.fillRect(18, 16, 28, 16);

  // @napi-rs/canvas Canvas is a valid drawImage source and preserves pixels
  // reliably in Node. Its Image decoder is intentionally not used here:
  // drawImage(Image) is asynchronous in browsers but does not become a
  // synchronously decoded source under this Node shim.
  Object.defineProperties(source, {
    naturalWidth: { value: source.width },
    naturalHeight: { value: source.height },
    // ContourWorkerManager includes image.src in its cache key. A unique
    // source marker prevents independent tests from accidentally short-circuiting
    // on a prior test's cached worker result.
    src: { value: `node-test-sticker-${nextImageId++}` },
  });
  assert.ok(source.width > 0 && source.height > 0, "napi canvas should contain artwork");
  return source as unknown as HTMLImageElement;
}

const resizeSettings = {
  widthInches: 2,
  heightInches: 1.5,
  maintainAspectRatio: false,
  outputDPI: 300,
};

const zeroHeroStroke = {
  width: 0,
  color: "#ff00ff",
  enabled: true,
  alphaThreshold: 128,
  backgroundColor: "#ffffff",
  useCustomBackground: true,
  cornerMode: "rounded" as const,
  autoBridging: false,
  autoBridgingThreshold: 0.02,
  contourMode: "smooth" as const,
};

const namedSpotColors = [
  {
    hex: "#e33b56",
    rgb: { r: 227, g: 59, b: 86 },
    spotWhite: true,
    spotGloss: true,
    spotWhiteName: "TEST_WHITE",
    spotGlossName: "TEST_GLOSS",
    spotFluorY: false,
    spotFluorM: false,
    spotFluorG: false,
    spotFluorOrange: false,
  },
];

async function traceAndGetCache(
  image: HTMLImageElement,
  strokeSettings = zeroHeroStroke,
) {
  const result = await quietLogsAsync(() =>
    contourWorkerManagerModule.processContourInWorker(
      image,
      strokeSettings,
      resizeSettings,
    ),
  );
  assert.ok(result.contourData, "worker result should include contour data");
  const cached = contourWorkerManagerModule
    .getContourWorkerManager()
    .getCachedContourData();
  assert.ok(cached, "worker manager should cache the contour used by export");
  assert.ok(cached.pathPoints.length > 2, "cached contour should not be empty");
  return cached;
}

function pageContentText(page: any, pdfDoc: PDFDocument): string {
  const contents = page.node.Contents();
  assert.ok(contents, "PDF page should have content streams");
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  return refs
    .map((ref: any) => pdfDoc.context.lookup(ref))
    .filter((stream: any): stream is PDFRawStream =>
      stream instanceof PDFRawStream,
    )
    .map((stream: PDFRawStream) => {
      const raw = stream.getContents();
      const filter = stream.dict.get(PDFName.of("Filter"))?.toString() ?? "";
      const decoded = filter.includes("FlateDecode")
        ? inflateSync(raw)
        : raw;
      return new TextDecoder().decode(decoded);
    })
    .join("\n");
}

function resourceNames(page: any): string[] {
  const resources = page.node.Resources();
  assert.ok(resources, "PDF page should have resources");
  const colorSpace = resources.get(PDFName.of("ColorSpace"));
  assert.ok(colorSpace, "PDF page should have color-space resources");
  const dictionary = colorSpace instanceof PDFDict ? colorSpace : null;
  assert.ok(dictionary, "color-space resource should be a dictionary");
  return dictionary.keys().map((name: PDFName) =>
    name.toString().replace(/^\/+/, ""),
  );
}

function imageXObjectBytes(page: any, pdfDoc: PDFDocument): number {
  const resources = page.node.Resources();
  const xObject = resources?.get(PDFName.of("XObject"));
  if (!(xObject instanceof PDFDict)) return 0;
  let total = 0;
  for (const [, value] of xObject.entries()) {
    const resolved = pdfDoc.context.lookup(value);
    if (!(resolved instanceof PDFRawStream)) continue;
    if (resolved.dict.get(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
    total += resolved.getContents().length;
  }
  return total;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

test("individual contour PDF is a real aligned sticker export with grouped spot resources", async () => {
  clearDownloads();
  const image = makeStickerImage();
  const cached = await traceAndGetCache(image);

  await quietLogsAsync(() =>
    contourOutlineModule.downloadContourPDF(
      image,
      zeroHeroStroke,
      resizeSettings,
      "individual-with-contour.pdf",
      cached,
      namedSpotColors,
      true,
      "CutContour",
    ),
  );

  const download = latestDownload("individual-with-contour.pdf");
  assert.equal(download.blob.type, "application/pdf");
  const pdfDoc = await PDFDocument.load(await blobBytes(download.blob));
  assert.equal(pdfDoc.getPageCount(), 1, "singleArtboard should group spots");

  const page = pdfDoc.getPage(0);
  assert.equal(
    rounded(page.getWidth()),
    rounded(cached.widthInches * 72),
    "PDF width should come from cached contour bounds",
  );
  assert.equal(
    rounded(page.getHeight()),
    rounded(cached.heightInches * 72),
    "PDF height should come from cached contour bounds",
  );

  const names = resourceNames(page);
  assert.ok(names.includes("CutContour"), `missing CutContour resource: ${names}`);
  assert.ok(names.includes("TEST_WHITE"), `missing White resource: ${names}`);
  assert.ok(names.includes("TEST_GLOSS"), `missing Gloss resource: ${names}`);

  const content = pageContentText(page, pdfDoc);
  assert.match(content, /\/CutContour\s+CS\s+1\s+SCN/);
  assert.match(content, /\/TEST_WHITE\s+cs\s+1\s+scn/);
  assert.match(content, /\/TEST_GLOSS\s+cs\s+1\s+scn/);
  assert.ok((content.match(/\bDo\b/g) ?? []).length >= 2, "PDF should place background and artwork images");

  const expectedImageWidth = resizeSettings.widthInches * 72;
  const expectedImageHeight = resizeSettings.heightInches * 72;
  assert.match(
    content,
    new RegExp(
      `${expectedImageWidth.toFixed(0)}\\s+0\\s+0\\s+${expectedImageHeight.toFixed(0)}\\s+`,
    ),
    "artwork placement should retain the source aspect ratio and requested size",
  );
  assert.ok(imageXObjectBytes(page, pdfDoc) > 100, "embedded artwork/background PNG must be nonempty");
});

test("individual contour PDF keeps separated White/Gloss pages and design-only PDF is nonempty", async () => {
  clearDownloads();
  const image = makeStickerImage();
  const cached = await traceAndGetCache(image);

  await quietLogsAsync(() =>
    contourOutlineModule.downloadContourPDF(
      image,
      zeroHeroStroke,
      resizeSettings,
      "individual-separated.pdf",
      cached,
      namedSpotColors,
      false,
      "CutContour",
    ),
  );

  const separated = latestDownload("individual-separated.pdf");
  const separatedPdf = await PDFDocument.load(await blobBytes(separated.blob));
  assert.equal(separatedPdf.getPageCount(), 3, "separate-artboard export should retain one page per spot");
  assert.ok(resourceNames(separatedPdf.getPage(0)).includes("CutContour"));
  assert.ok(resourceNames(separatedPdf.getPage(1)).includes("TEST_WHITE"));
  assert.ok(resourceNames(separatedPdf.getPage(2)).includes("TEST_GLOSS"));
  assert.ok(imageXObjectBytes(separatedPdf.getPage(0), separatedPdf) > 100);

  clearDownloads();
  await quietLogsAsync(() =>
    contourOutlineModule.downloadDesignOnlyPDF(
      image,
      resizeSettings,
      "individual-design-only.pdf",
    ),
  );
  const designOnly = latestDownload("individual-design-only.pdf");
  const designPdf = await PDFDocument.load(await blobBytes(designOnly.blob));
  assert.equal(designPdf.getPageCount(), 1);
  assert.equal(
    rounded(designPdf.getPage(0).getWidth()),
    resizeSettings.widthInches * 72,
  );
  assert.ok(
    imageXObjectBytes(designPdf.getPage(0), designPdf) > 20,
    "design-only export should contain nonempty artwork",
  );
});

test("individual cut-contour SVG and PNG paths produce nonempty downloadable files", async () => {
  clearDownloads();
  const image = makeStickerImage();
  const strokeSettings = {
    ...zeroHeroStroke,
    width: 2,
  };

  const vectorCanvas = quietLogs(() =>
    vectorStrokeModule.createVectorStroke(image, {
      strokeSettings,
      exportCutContour: true,
      vectorQuality: "high",
    }),
  );
  const vectorPaths = quietLogs(() =>
    vectorStrokeModule.createVectorPaths(image, strokeSettings, true),
  );
  assert.ok(vectorPaths.paths.length > 0, "cut-contour path extraction should find artwork");

  vectorStrokeModule.downloadVectorStroke(
    vectorCanvas,
    "individual-cut-contour.svg",
    "svg",
    vectorPaths,
  );
  const svg = latestDownload("individual-cut-contour.svg");
  assert.equal(svg.blob.type, "image/svg+xml");
  const svgText = new TextDecoder().decode(await blobBytes(svg.blob));
  assert.match(svgText, /<svg\b/);
  assert.match(svgText, /<path\b/);
  assert.match(svgText, /#FF00FF/);

  clearDownloads();
  vectorStrokeModule.downloadVectorStroke(
    vectorCanvas,
    "individual-cut-contour.any",
    "png",
  );
  // PNG fallback is callback-based, unlike SVG's synchronous Blob path.
  for (let attempt = 0; attempt < 20 && downloads.length === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const png = latestDownload("individual-cut-contour.png");
  assert.equal(png.blob.type, "image/png");
  const pngBytes = await blobBytes(png.blob);
  assert.deepEqual(Array.from(pngBytes.slice(0, 8)), [
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);
  assert.ok(pngBytes.length > 100, "PNG download should contain nonempty artwork");
});