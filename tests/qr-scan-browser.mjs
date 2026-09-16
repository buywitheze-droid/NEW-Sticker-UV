// Run against a running dev server:
// PLAYWRIGHT_MODULE=/mnt/pid2/node_modules/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium \
//   node tests/qr-scan-browser.mjs
//
// This test imports the real spot-UV QR API in Chromium and replaces only the
// QR detector worker. Keeping the worker fake in the page exercises the actual
// canvas/raster-budget, cancellation, deadline, geometry, and result plumbing.
import assert from 'node:assert/strict';

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || '/mnt/pid2/node_modules/playwright/index.mjs'
);
const executablePath = process.env.CHROMIUM_EXECUTABLE ||
  '/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium';
const baseURL = process.env.TEST_BASE_URL ||
  `https://${process.env.REPLIT_DEV_DOMAIN}`;

assert.ok(process.env.REPLIT_DEV_DOMAIN || process.env.TEST_BASE_URL,
  'Set REPLIT_DEV_DOMAIN or TEST_BASE_URL before running this browser test');

const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox'],
});

async function rejectedOutcome(page, promiseName) {
  return page.evaluate(async (name) => {
    try {
      const value = await globalThis.__qrScanPromises[name];
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }, promiseName);
}

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const apiRequests = [];
const pageErrors = [];
page.on('request', request => {
  if (new URL(request.url()).pathname === '/api/detect-qr') apiRequests.push(request.url());
});
page.on('pageerror', error => pageErrors.push(error.message));

try {
  await page.goto(baseURL);

  await page.evaluate(async () => {
    const NativeWorker = window.Worker;
    const workers = [];

    class FakeQRWorker extends EventTarget {
      constructor(url) {
        super();
        this.url = String(url);
        this.terminated = false;
        this.lastMessage = null;
        workers.push(this);
      }

      postMessage(message) {
        // Do not retain the large transferred ImageData. The dimensions are
        // enough to verify the browser-side raster caps.
        this.lastMessage = {
          width: message.width,
          height: message.height,
          sourceWidth: message.sourceWidth,
          sourceHeight: message.sourceHeight,
          maxCodes: message.maxCodes,
          deep: message.deep,
        };
      }

      terminate() {
        this.terminated = true;
      }

      send(data) {
        this.dispatchEvent(new MessageEvent('message', { data }));
      }
    }

    // Vite's ?worker wrapper eventually calls the browser Worker constructor.
    // Preserve every unrelated worker used by the application.
    window.Worker = class QRWorkerShim extends NativeWorker {
      constructor(url, options) {
        if (String(url).includes('qr-detect-worker')) {
          return new FakeQRWorker(url);
        }
        super(url, options);
      }
    };

    const { detectQRsInImage } = await import('/src/builders/spot-uv/lib/qr.ts');
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="6000" height="3000" viewBox="0 0 6000 3000"><rect width="6000" height="3000" fill="white"/></svg>',
    )}`;
    await image.decode();

    globalThis.__qrDetect = detectQRsInImage;
    globalThis.__qrImage = image;
    globalThis.__qrWorkers = workers;
    globalThis.__qrScanPromises = {};
    globalThis.__qrRasterCode = (x, y, size = 100, payload = 'same-payload') => ({
      payload,
      bbox: { x, y, width: size, height: size },
      corners: {
        topLeft: { x, y },
        topRight: { x: x + size, y },
        bottomLeft: { x, y: y + size },
        bottomRight: { x: x + size, y: y + size },
      },
      rotation: 0,
      estimatedModuleSize: 10,
    });
  });
  // Ignore unrelated application startup traffic; this assertion covers the
  // QR API invocations below.
  apiRequests.length = 0;

  // The normal cap is 2MP, so this 6000×3000 source must be read at
  // approximately 2000×1000. Feed raster coordinates and verify every
  // geometry field is returned in original-image coordinates.
  const scaleWorkerIndex = await page.evaluate(() => {
    const progress = [];
    globalThis.__qrProgress = progress;
    globalThis.__qrScanPromises.scale = globalThis.__qrDetect(
      globalThis.__qrImage,
      { maxCodes: 4, onProgress: message => progress.push(message) },
    );
    return globalThis.__qrWorkers.length - 1;
  });
  const scaleMessage = await page.evaluate(index =>
    globalThis.__qrWorkers[index].lastMessage, scaleWorkerIndex);
  assert.ok(scaleMessage.width <= 2400 && scaleMessage.height <= 2400,
    `raster edge exceeded cap: ${JSON.stringify(scaleMessage)}`);
  assert.ok(scaleMessage.width * scaleMessage.height <= 2_000_000,
    `normal raster exceeded 2MP cap: ${JSON.stringify(scaleMessage)}`);
  assert.equal(scaleMessage.sourceWidth, 6000);
  assert.equal(scaleMessage.sourceHeight, 3000);

  await page.evaluate(index => {
    const worker = globalThis.__qrWorkers[index];
    worker.send({ type: 'progress', message: 'Scanning original raster' });
    worker.send({ type: 'progress', message: 'not a bounded public stage' });
    worker.send({
      type: 'result',
      coordinateSpace: 'raster',
      qrCodes: [
        globalThis.__qrRasterCode(100, 100, 100, 'same-payload'),
        globalThis.__qrRasterCode(500, 100, 100, 'same-payload'),
        globalThis.__qrRasterCode(-20, 100, 100, 'out-of-bounds'),
        globalThis.__qrRasterCode(800, 100, 100, ''),
      ],
    });
  }, scaleWorkerIndex);
  const scaleResult = await page.evaluate(() => globalThis.__qrScanPromises.scale);
  assert.equal(scaleResult.length, 3,
    'same-payload separate regions and payloadless geometry should survive');
  assert.deepEqual(
    scaleResult.slice(0, 2).map(code => [code.payload, code.bbox.x, code.bbox.y, code.bbox.width, code.bbox.height]),
    [
      ['same-payload', 300, 300, 300, 300],
      ['same-payload', 1500, 300, 300, 300],
    ],
  );
  assert.equal(scaleResult[2].payload, '',
    'payloadless geometry must remain a manual recovery candidate');
  assert.equal(scaleResult[2].bbox.x, 2400);
  assert.equal(scaleResult[2].estimatedModuleSize, 30);
  const progress = await page.evaluate(() => globalThis.__qrProgress);
  assert.deepEqual(progress, ['Preparing QR scan', 'Scanning original raster'],
    'only bounded worker stages should reach onProgress');
  assert.equal(await page.evaluate(index => globalThis.__qrWorkers[index].terminated, scaleWorkerIndex), true);

  const deepWorkerIndex = await page.evaluate(() => {
    globalThis.__qrScanPromises.deep = globalThis.__qrDetect(
      globalThis.__qrImage,
      { deep: true, maxCodes: 1 },
    );
    return globalThis.__qrWorkers.length - 1;
  });
  const deepMessage = await page.evaluate(index =>
    globalThis.__qrWorkers[index].lastMessage, deepWorkerIndex);
  assert.ok(deepMessage.width * deepMessage.height <= 4_000_000,
    `deep raster exceeded 4MP cap: ${JSON.stringify(deepMessage)}`);
  assert.ok(Math.max(deepMessage.width, deepMessage.height) <= 2400,
    `deep raster edge exceeded cap: ${JSON.stringify(deepMessage)}`);
  await page.evaluate(index => {
    globalThis.__qrWorkers[index].send({
      type: 'result',
      coordinateSpace: 'raster',
      qrCodes: [],
    });
  }, deepWorkerIndex);
  assert.deepEqual(await page.evaluate(() => globalThis.__qrScanPromises.deep), []);
  assert.equal(await page.evaluate(index => globalThis.__qrWorkers[index].terminated, deepWorkerIndex), true);

  // Every concurrent invocation gets a distinct worker and keeps its own
  // listener. Resolve them out of order to catch shared-listener mixing.
  const concurrentStart = await page.evaluate(() => {
    globalThis.__qrScanPromises.concurrentA = globalThis.__qrDetect(globalThis.__qrImage, { maxCodes: 1 });
    globalThis.__qrScanPromises.concurrentB = globalThis.__qrDetect(globalThis.__qrImage, { maxCodes: 1 });
    return globalThis.__qrWorkers.length;
  });
  const concurrentA = concurrentStart - 2;
  const concurrentB = concurrentStart - 1;
  await page.evaluate(({ a, b }) => {
    globalThis.__qrWorkers[b].send({
      type: 'result',
      coordinateSpace: 'raster',
      qrCodes: [globalThis.__qrRasterCode(100, 100, 100, 'second')],
    });
    globalThis.__qrWorkers[a].send({
      type: 'result',
      coordinateSpace: 'raster',
      qrCodes: [globalThis.__qrRasterCode(100, 100, 100, 'first')],
    });
  }, { a: concurrentA, b: concurrentB });
  const concurrentResults = await page.evaluate(async () => [
    await globalThis.__qrScanPromises.concurrentA,
    await globalThis.__qrScanPromises.concurrentB,
  ]);
  assert.equal(concurrentResults[0][0].payload, 'first');
  assert.equal(concurrentResults[1][0].payload, 'second');
  assert.equal(await page.evaluate(index => globalThis.__qrWorkers[index].terminated, concurrentA), true);
  assert.equal(await page.evaluate(index => globalThis.__qrWorkers[index].terminated, concurrentB), true);

  const cancellationIndex = await page.evaluate(() => {
    const controller = new AbortController();
    globalThis.__qrCancelController = controller;
    globalThis.__qrScanPromises.cancel = globalThis.__qrDetect(
      globalThis.__qrImage,
      { signal: controller.signal },
    );
    globalThis.__qrScanPromises.cancel.catch(() => {});
    return globalThis.__qrWorkers.length - 1;
  });
  await page.evaluate(() => globalThis.__qrCancelController.abort());
  const cancellation = await rejectedOutcome(page, 'cancel');
  assert.equal(cancellation.ok, false);
  assert.match(cancellation.message, /cancelled/i);
  assert.equal(await page.evaluate(index => globalThis.__qrWorkers[index].terminated, cancellationIndex), true);

  // Leave one normal scan unresolved. The production 8-second deadline must
  // reject and terminate rather than converting a timeout into [] .
  const timeoutIndex = await page.evaluate(() => {
    globalThis.__qrScanPromises.timeout = globalThis.__qrDetect(globalThis.__qrImage);
    globalThis.__qrScanPromises.timeout.catch(() => {});
    return globalThis.__qrWorkers.length - 1;
  });
  const timeout = await rejectedOutcome(page, 'timeout');
  assert.equal(timeout.ok, false);
  assert.match(timeout.message, /timed out|timeout/i);
  assert.equal(await page.evaluate(index => globalThis.__qrWorkers[index].terminated, timeoutIndex), true);

  assert.deepEqual(apiRequests, [], 'QR detection must not call /api/detect-qr');
  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join('; ')}`);
  console.log('qr-scan-browser: concurrent isolation, cancellation, timeout, caps, scaling, filtering, dedupe, and local-only detection passed');
} finally {
  await page.close();
  await browser.close();
}