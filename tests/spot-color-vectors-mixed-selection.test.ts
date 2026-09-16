import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';

import '../vps/src/canvas-shim.ts';

type AnyModule = Record<string, any>;
type WorkerEvent = { data?: any; message?: string };
type WorkerListener = (event: WorkerEvent) => void;

let spotColorCore: AnyModule;
const traceMessages: any[] = [];

class InlineSpotWorker {
  private listeners = new Map<string, Set<WorkerListener>>();

  addEventListener(type: string, listener: WorkerListener): void {
    let entries = this.listeners.get(type);
    if (!entries) {
      entries = new Set();
      this.listeners.set(type, entries);
    }
    entries.add(listener);
  }

  removeEventListener(type: string, listener: WorkerListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: any): void {
    if (message?.type !== 'trace') return;
    traceMessages.push({
      regionName: message.regionName,
      allTaggedWhite: message.allTaggedWhite,
      allTaggedGloss: message.allTaggedGloss,
      spotColors: message.spotColors,
      markedColors: message.markedColors,
      pixels: new Uint8ClampedArray(message.imageBuffer),
      fullAlphaMask: message.fullAlphaMask
        ? new Uint8Array(message.fullAlphaMask)
        : undefined,
    });
    queueMicrotask(() => {
      try {
        const pixels = new Uint8ClampedArray(message.imageBuffer);
        const fullAlphaMask = message.fullAlphaMask
          ? new Uint8Array(message.fullAlphaMask)
          : undefined;
        const result = spotColorCore.processOneSeparation(
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
        );
        this.emit('message', {
          data: { type: 'result', regions: result ? [result] : [] },
        });
      } catch (error) {
        this.emit('error', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  terminate(): void {}

  private emit(type: string, event: WorkerEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

Object.defineProperty(globalThis, 'Worker', {
  configurable: true,
  value: InlineSpotWorker,
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { hardwareConcurrency: 1, maxTouchPoints: 0, userAgent: 'node' },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    createElement(tagName: string): any {
      if (tagName === 'canvas') return createCanvas(1, 1);
      throw new Error(`unsupported test element ${tagName}`);
    },
  },
});
const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: async () => ({ ok: false }),
});

const viteServer: ViteDevServer = await createServer({
  configFile: './vite.config.ts',
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});
spotColorCore = await viteServer.ssrLoadModule(
  '/src/builders/spot-uv/lib/spot-color-trace-core.ts',
);
const vectors = await viteServer.ssrLoadModule(
  '/src/builders/spot-uv/lib/spot-color-vectors.ts',
);

test.after(async () => {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: originalFetch,
  });
  await viteServer.close();
});

function makeOpaqueImage(width: number, height: number): any {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#808080';
  context.fillRect(0, 0, width, height);
  return canvas;
}

test('splits mixed same-RGB region selections while preserving all-tagged white alpha', async () => {
  traceMessages.length = 0;

  const width = 4;
  const height = 4;
  const regionMap = new Int32Array([
    0, 0, 1, 1,
    0, 0, 1, 1,
    0, 0, 1, 1,
    -1, 0, 1, 1,
  ]);
  const pixelMap = new Int16Array(width * height).fill(0);
  const spotColors = [{
    hex: '#808080',
    rgb: { r: 128, g: 128, b: 128 },
    spotWhite: true,
    spotGloss: true,
    spotWhiteName: 'TEST_WHITE',
    spotGlossName: 'TEST_GLOSS',
    spotFluorY: true,
    spotFluorM: false,
    spotFluorG: false,
    spotFluorOrange: false,
    spotFluorYName: 'TEST_FLUOR',
    regions: [
      { id: 0, selected: true, spotWhite: true, spotGloss: true },
      { id: 1, selected: true, spotWhite: true, spotGloss: false },
    ],
    regionMap,
  }];

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([72, 72]);
  const labels = await vectors.addSpotColorVectorsToPDF(
    pdfDoc,
    page,
    makeOpaqueImage(width, height),
    spotColors,
    width / 300,
    height / 300,
    height / 300,
    0,
    0,
    true,
    undefined,
    undefined,
    { pixelMap, mapWidth: width, mapHeight: height },
  );

  const white = traceMessages.find(message => message.regionName === 'TEST_WHITE');
  const gloss = traceMessages.find(message => message.regionName === 'TEST_GLOSS');
  const fluor = traceMessages.find(message => message.regionName === 'TEST_FLUOR');
  assert.ok(white);
  assert.ok(gloss);
  assert.ok(fluor);
  assert.equal(traceMessages.filter(message => message.regionName === 'TEST_FLUOR').length, 1);
  assert.equal(white.spotColors[0].spotWhite, true);
  assert.equal(white.spotColors[0].spotGloss, false);
  assert.equal(gloss.spotColors[0].spotWhite, false);
  assert.equal(gloss.spotColors[0].spotGloss, true);

  // The white job is all-tagged after isolation and therefore uses the source
  // alpha silhouette, including the orphan map pixel. Gloss remains a
  // per-region exact selection and excludes region 1 plus the orphan.
  assert.equal(white.allTaggedWhite, true);
  assert.equal(white.allTaggedGloss, false);
  assert.equal(white.fullAlphaMask?.every((value: number) => value === 1), true);
  assert.equal(gloss.allTaggedWhite, false);
  assert.equal(gloss.allTaggedGloss, false);
  assert.equal(gloss.fullAlphaMask, undefined);

  const whiteRawPixels = Array.from(white.pixels).filter((_, index) => index % 4 === 3);
  const glossRawPixels = Array.from(gloss.pixels).filter((_, index) => index % 4 === 3);
  // Fluorescent_Y is intentionally carried by the white pass, so the exact
  // raster also contains the orphan there; the all-tagged white trace uses
  // fullAlphaMask rather than this union raster.
  assert.equal(whiteRawPixels.filter(alpha => alpha === 255).length, 16);
  assert.equal(glossRawPixels.filter(alpha => alpha === 255).length, 7);
  assert.deepEqual(labels, ['TEST_WHITE', 'TEST_FLUOR', 'TEST_GLOSS']);
});

test('does not split channel-identical region membership', async () => {
  traceMessages.length = 0;
  const width = 4;
  const height = 4;
  const regionMap = new Int32Array([
    0, 0, 1, 1,
    0, 0, 1, 1,
    0, 0, 1, 1,
    0, 0, 1, 1,
  ]);
  const pixelMap = new Int16Array(width * height).fill(0);
  const colors = [{
    hex: '#909090',
    rgb: { r: 144, g: 144, b: 144 },
    spotWhite: true,
    spotGloss: true,
    spotWhiteName: 'SAME_WHITE',
    spotGlossName: 'SAME_GLOSS',
    spotFluorY: false,
    spotFluorM: false,
    spotFluorG: false,
    spotFluorOrange: false,
    regions: [
      { id: 0, selected: true, spotWhite: true, spotGloss: true },
      { id: 1, selected: true, spotWhite: false, spotGloss: false },
    ],
    regionMap,
  }];

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([72, 72]);
  const labels = await vectors.addSpotColorVectorsToPDF(
    pdfDoc,
    page,
    makeOpaqueImage(width, height),
    colors,
    width / 300,
    height / 300,
    height / 300,
    0,
    0,
    true,
    undefined,
    undefined,
    { pixelMap, mapWidth: width, mapHeight: height },
  );

  assert.equal(traceMessages.length, 2);
  assert.deepEqual(traceMessages.map(message => message.regionName), ['SAME_WHITE', 'SAME_GLOSS']);
  assert.deepEqual(labels, ['SAME_WHITE', 'SAME_GLOSS']);
});