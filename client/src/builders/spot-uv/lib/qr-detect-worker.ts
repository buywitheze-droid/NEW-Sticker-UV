// Multi-engine QR detection worker.
//
// Goal: detection accuracy approaching a phone camera. Phones do this by
// running multiple decoders simultaneously over many frames with heavy
// preprocessing. We have a single static image, so we trade real-time
// constraints for thoroughness — running several engines × several
// preprocessing variants × several spatial tiles, then deduping results
// spatially.
//
// Engines (in priority order):
//   1. BarcodeDetector  — native browser API, backed by the OS detector
//      (CoreImage / MLKit). Best-in-class when present, near-instant. Not
//      yet available in Firefox / Safari workers; we feature-detect.
//   2. ZBar (zbar-wasm)  — compiled C/C++ ZBar, 38.95% accuracy on
//      Dynamsoft's 536-image real-world benchmark (vs ZXing 31.87%, jsQR
//      worse still). Strong on stylised, low-contrast, and partially
//      occluded codes.
//   3. jsQR             — pure JS, fast, weakest accuracy but different
//      failure mode from ZBar — sometimes catches what ZBar misses on
//      very small or very crisp synthetic QRs.
//
// Preprocessing variants (each engine sees each variant):
//   - raw                  — the source image as-is
//   - otsu                 — global Otsu threshold (handles styled dots)
//   - inverted             — for white-on-dark QRs
//   - contrast             — histogram-stretch then Otsu (low-contrast)
//   - logo-erased          — centre 22% wiped (defeats centred logos)
//   - rotated 90/180/270   — for QRs not upright (jsQR, others auto-rotate)
//   - tiled (4 quadrants)  — finds small QRs in large designs
//
// Findings are deduped by overlapping geometry. Two identical payloads at
// two different positions are both retained.

import jsQR from 'jsqr';
// ZBar wasm is intentionally excluded: in a Vite worker build the WASM binary
// URL resolves to the Vite HTML 404 page (magic bytes <!DO instead of \0asm),
// causing every call to throw and all variants to silently return [].
// jsQR + native BarcodeDetector cover the same ground reliably without wasm.

interface DetectRequest {
  imageData: Uint8ClampedArray;
  width: number;
  height: number;
  /** Original source dimensions; raster dimensions may be capped by caller. */
  sourceWidth?: number;
  sourceHeight?: number;
  /** Hard cap on how many QRs we attempt to detect. Default 4. */
  maxCodes?: number;
  /** Enables the longer local recovery pass. */
  deep?: boolean;
  /** Absolute deadline supplied by the owning invocation. */
  deadlineAt?: number;
}

interface DetectedQRPayload {
  payload: string;
  /** Axis-aligned bounding box in image pixel coords (source-image space). */
  bbox: { x: number; y: number; width: number; height: number };
  corners: {
    topLeft: { x: number; y: number };
    topRight: { x: number; y: number };
    bottomLeft: { x: number; y: number };
    bottomRight: { x: number; y: number };
  };
  rotation: number;
  estimatedModuleSize: number;
  /** Which engine + variant detected this QR (internal tie-break only). */
  source?: string;
}

// ─── Geometry helpers ────────────────────────────────────────────────────

function bboxFromCorners(corners: DetectedQRPayload['corners']): DetectedQRPayload['bbox'] {
  const xs = [corners.topLeft.x, corners.topRight.x, corners.bottomLeft.x, corners.bottomRight.x];
  const ys = [corners.topLeft.y, corners.topRight.y, corners.bottomLeft.y, corners.bottomRight.y];
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function rotationFromCorners(corners: DetectedQRPayload['corners']): number {
  const dx = corners.topRight.x - corners.topLeft.x;
  const dy = corners.topRight.y - corners.topLeft.y;
  return Math.atan2(dy, dx);
}

function estimateModuleSize(corners: DetectedQRPayload['corners']): number {
  const topEdge = Math.hypot(
    corners.topRight.x - corners.topLeft.x,
    corners.topRight.y - corners.topLeft.y,
  );
  const leftEdge = Math.hypot(
    corners.bottomLeft.x - corners.topLeft.x,
    corners.bottomLeft.y - corners.topLeft.y,
  );
  return (topEdge + leftEdge) / 2 / 21;
}

// IoU on axis-aligned bboxes — used to drop duplicate detections of the
// same physical QR by different engines / variants when their payloads
// somehow differ (rare; usually same payload + spatial overlap means same QR).
function bboxIoU(a: DetectedQRPayload['bbox'], b: DetectedQRPayload['bbox']): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return inter / union;
}

// ─── Preprocessing ───────────────────────────────────────────────────────

function rgbaToLuma(src: Uint8ClampedArray): Uint8ClampedArray {
  const luma = new Uint8ClampedArray(src.length / 4);
  for (let i = 0, j = 0; i < src.length; i += 4, j++) {
    // Premultiply against white so transparent pixels read as light, not
    // black — otherwise a transparent design with a dark QR fails Otsu.
    const a = src[i + 3] / 255;
    const r = src[i] * a + 255 * (1 - a);
    const g = src[i + 1] * a + 255 * (1 - a);
    const b = src[i + 2] * a + 255 * (1 - a);
    luma[j] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
  }
  return luma;
}

function lumaToRgba(luma: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(luma.length * 4);
  for (let i = 0, j = 0; i < luma.length; i++, j += 4) {
    out[j] = luma[i]; out[j + 1] = luma[i]; out[j + 2] = luma[i]; out[j + 3] = 255;
  }
  return out;
}

function computeOtsuThreshold(luma: Uint8ClampedArray): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < luma.length; i++) hist[luma[i]]++;
  const total = luma.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = -1, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) { maxVar = v; threshold = t; }
  }
  return threshold;
}

function applyThreshold(luma: Uint8ClampedArray, threshold: number, invert = false): Uint8ClampedArray {
  const out = new Uint8ClampedArray(luma.length);
  if (invert) {
    for (let i = 0; i < luma.length; i++) out[i] = luma[i] < threshold ? 255 : 0;
  } else {
    for (let i = 0; i < luma.length; i++) out[i] = luma[i] < threshold ? 0 : 255;
  }
  return out;
}

// Histogram-stretch contrast normalisation — the 2nd–98th percentile range
// is mapped to [0,255]. Defeats washed-out / low-contrast QRs that Otsu
// alone can't handle because the dark and light populations sit too close.
function stretchContrast(luma: Uint8ClampedArray): Uint8ClampedArray {
  const hist = new Uint32Array(256);
  for (let i = 0; i < luma.length; i++) hist[luma[i]]++;
  let lo = 0, hi = 255;
  const lowCount = luma.length * 0.02;
  const highCount = luma.length * 0.98;
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= lowCount) { lo = i; break; } }
  acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= highCount) { hi = i; break; } }
  const range = Math.max(1, hi - lo);
  const out = new Uint8ClampedArray(luma.length);
  for (let i = 0; i < luma.length; i++) {
    const v = ((luma[i] - lo) * 255 / range) | 0;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

// Wipe the centre of the image to white. Many QRs have a logo overlaid
// in the middle (Instagram, brand marks, etc) which kills decoders that
// rely on full-codeword integrity. Erasing the centre lets the decoder
// reconstruct the missing modules from QR's built-in error correction.
function eraseCentre(rgba: Uint8ClampedArray, width: number, height: number, fraction: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const w = Math.round(width * fraction);
  const h = Math.round(height * fraction);
  const x0 = Math.round((width - w) / 2);
  const y0 = Math.round((height - h) / 2);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * width + x) * 4;
      out[i] = 255; out[i + 1] = 255; out[i + 2] = 255; out[i + 3] = 255;
    }
  }
  return out;
}

function rotateRgba90(src: Uint8ClampedArray, width: number, height: number): { data: Uint8ClampedArray; width: number; height: number } {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sIdx = (y * width + x) * 4;
      const dx = height - 1 - y;
      const dy = x;
      const dIdx = (dy * height + dx) * 4;
      out[dIdx] = src[sIdx]; out[dIdx + 1] = src[sIdx + 1]; out[dIdx + 2] = src[sIdx + 2]; out[dIdx + 3] = src[sIdx + 3];
    }
  }
  return { data: out, width: height, height: width };
}

// Map corners detected on a rotated buffer back into the original
// source-image coordinate frame. `rotations` is the number of CW 90°
// turns applied to the source before detection.
function unrotateCorners(
  corners: DetectedQRPayload['corners'],
  rotations: number,
  origW: number,
  origH: number,
): DetectedQRPayload['corners'] {
  if (rotations === 0) return corners;
  const map = (p: { x: number; y: number }, rotsRemaining: number, w: number, h: number): { x: number; y: number } => {
    if (rotsRemaining === 0) return p;
    // Inverse of one CW 90° rotation: (x, y) → (y, w - 1 - x), mapping back
    // from a (h × w) rotated frame into the (w × h) original.
    const inv = { x: p.y, y: w - 1 - p.x };
    return map(inv, rotsRemaining - 1, h, w);
  };
  const w0 = rotations % 2 === 1 ? origH : origW;
  const h0 = rotations % 2 === 1 ? origW : origH;
  return {
    topLeft: map(corners.topLeft, rotations, w0, h0),
    topRight: map(corners.topRight, rotations, w0, h0),
    bottomLeft: map(corners.bottomLeft, rotations, w0, h0),
    bottomRight: map(corners.bottomRight, rotations, w0, h0),
  };
}

// ─── Engine adapters ─────────────────────────────────────────────────────

function approximateCornersFromPoints(points: Array<{ x: number; y: number }>): DetectedQRPayload['corners'] {
  // Sort by y, take top two as top, bottom two as bottom; within each pair
  // sort by x. Robust enough for axis-ish-aligned QRs which is what we
  // accept for the vector overlay anyway (off-axis ones are filtered).
  const sortedByY = [...points].sort((a, b) => a.y - b.y);
  const top = sortedByY.slice(0, 2).sort((a, b) => a.x - b.x);
  const bot = sortedByY.slice(2, 4).sort((a, b) => a.x - b.x);
  return {
    topLeft: top[0],
    topRight: top[1],
    bottomLeft: bot[0],
    bottomRight: bot[1],
  };
}

function detectWithJsQR(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  source: string,
): DetectedQRPayload[] {
  const out: DetectedQRPayload[] = [];
  // jsQR finds one per call; iterate by masking out and re-running.
  const buf = new Uint8ClampedArray(rgba);
  for (let i = 0; i < 6; i++) {
    const result = jsQR(buf, width, height, { inversionAttempts: 'attemptBoth' });
    if (!result) break;
    const corners = {
      topLeft: result.location.topLeftCorner,
      topRight: result.location.topRightCorner,
      bottomLeft: result.location.bottomLeftCorner,
      bottomRight: result.location.bottomRightCorner,
    };
    const bbox = bboxFromCorners(corners);
    if (bbox.width < 8 || bbox.height < 8 || bbox.width > width || bbox.height > height) break;
    out.push({
      payload: result.data,
      bbox,
      corners,
      rotation: rotationFromCorners(corners),
      estimatedModuleSize: estimateModuleSize(corners),
      source,
    });
    // Mask the QR out of the buffer so the next iteration can find another.
    const x0 = Math.max(0, Math.floor(bbox.x));
    const y0 = Math.max(0, Math.floor(bbox.y));
    const x1 = Math.min(width, Math.ceil(bbox.x + bbox.width));
    const y1 = Math.min(height, Math.ceil(bbox.y + bbox.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * width + x) * 4;
        buf[idx] = 255; buf[idx + 1] = 255; buf[idx + 2] = 255; buf[idx + 3] = 255;
      }
    }
  }
  return out;
}

// Native BarcodeDetector — backed by the OS detector when available
// (CoreImage / MLKit). Easily the most accurate engine when present.
// We feature-detect because it's not yet in Firefox / Safari workers.
interface NativeBarcode {
  rawValue: string;
  cornerPoints: Array<{ x: number; y: number }>;
  boundingBox: DOMRectReadOnly;
}
interface NativeBarcodeDetector {
  detect: (image: ImageBitmap | ImageData) => Promise<NativeBarcode[]>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => NativeBarcodeDetector;

async function detectWithNative(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  source: string,
): Promise<DetectedQRPayload[]> {
  const Ctor = (self as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!Ctor) return [];
  try {
    const detector = new Ctor({ formats: ['qr_code'] });
    const imageData = new ImageData(rgba, width, height);
    // Some implementations want an ImageBitmap; try ImageData first, fall
    // back to bitmap if rejected.
    let results: NativeBarcode[];
    try {
      results = await detector.detect(imageData);
    } catch {
      const bmp = await createImageBitmap(imageData);
      results = await detector.detect(bmp);
      bmp.close();
    }
    const out: DetectedQRPayload[] = [];
    for (const r of results) {
      const pts = r.cornerPoints && r.cornerPoints.length === 4
        ? r.cornerPoints
        : [
            { x: r.boundingBox.left, y: r.boundingBox.top },
            { x: r.boundingBox.right, y: r.boundingBox.top },
            { x: r.boundingBox.right, y: r.boundingBox.bottom },
            { x: r.boundingBox.left, y: r.boundingBox.bottom },
          ];
      const corners = approximateCornersFromPoints(pts);
      out.push({
        // Native implementations can expose geometry before decoding a
        // payload. Keep it as a manual recovery candidate.
        payload: typeof r.rawValue === 'string' ? r.rawValue : '',
        bbox: bboxFromCorners(corners),
        corners,
        rotation: rotationFromCorners(corners),
        estimatedModuleSize: estimateModuleSize(corners),
        source,
      });
    }
    return out;
  } catch (err) {
    return [];
  }
}

// ─── Variant runner ──────────────────────────────────────────────────────

interface DetectionContext {
  width: number;
  height: number;
  rotations: number; // 0–3, # of 90° CW rotations applied before detection
  baseOriginX: number; // for tile crops: where this tile sits in the source
  baseOriginY: number;
}

async function runEngines(
  rgba: Uint8ClampedArray,
  ctx: DetectionContext,
  variant: string,
  origW: number,
  origH: number,
): Promise<DetectedQRPayload[]> {
  const findings: DetectedQRPayload[] = [];

  // Engine order: native BarcodeDetector first (OS-backed, most accurate
  // when present), then jsQR (pure JS, reliable, different failure mode).
  // ZBar wasm is excluded — in this Vite worker build the .wasm binary URL
  // resolves to an HTML 404 page, causing instant RuntimeError on every call.
  const native = await detectWithNative(rgba, ctx.width, ctx.height, `native:${variant}`);
  findings.push(...native);

  const js = detectWithJsQR(rgba, ctx.width, ctx.height, `jsqr:${variant}`);
  findings.push(...js);

  // Map all findings back into source-image coordinate space.
  return findings.map((f) => {
    const corners = unrotateCorners(f.corners, ctx.rotations, origW, origH);
    const sourceCorners = {
      topLeft: { x: corners.topLeft.x + ctx.baseOriginX, y: corners.topLeft.y + ctx.baseOriginY },
      topRight: { x: corners.topRight.x + ctx.baseOriginX, y: corners.topRight.y + ctx.baseOriginY },
      bottomLeft: { x: corners.bottomLeft.x + ctx.baseOriginX, y: corners.bottomLeft.y + ctx.baseOriginY },
      bottomRight: { x: corners.bottomRight.x + ctx.baseOriginX, y: corners.bottomRight.y + ctx.baseOriginY },
    };
    return {
      ...f,
      corners: sourceCorners,
      bbox: bboxFromCorners(sourceCorners),
      rotation: rotationFromCorners(sourceCorners),
      estimatedModuleSize: estimateModuleSize(sourceCorners),
    };
  });
}

// ─── Dedup ───────────────────────────────────────────────────────────────

function dedupe(findings: DetectedQRPayload[]): DetectedQRPayload[] {
  // Cluster spatially, not by payload: a decoder can return a slightly
  // different payload for the same physical QR, while two identical QRs at
  // different positions must remain separate results.
  const clusters: DetectedQRPayload[][] = [];
  for (const finding of findings) {
    const cluster = clusters.find((items) =>
      items.some((item) => bboxIoU(item.bbox, finding.bbox) > 0.3));
    if (cluster) cluster.push(finding);
    else clusters.push([finding]);
  }
  return clusters.map((cluster) => {
    // Prefer a decoded payload over a geometry-only candidate, then prefer
    // the largest localization (usually the most accurate engine result).
    cluster.sort((a, b) => {
      const payloadQuality = Number(b.payload.length > 0) - Number(a.payload.length > 0);
      if (payloadQuality !== 0) return payloadQuality;
      return b.bbox.width * b.bbox.height - a.bbox.width * a.bbox.height;
    });
    return cluster[0];
  });
}

// ─── Main pipeline ───────────────────────────────────────────────────────

function validGeometry(f: DetectedQRPayload, width: number, height: number): boolean {
  const points = [
    f.corners.topLeft,
    f.corners.topRight,
    f.corners.bottomLeft,
    f.corners.bottomRight,
  ];
  if (!points.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
  if (!points.every((p) => p && p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height)) return false;
  if (!Number.isFinite(f.bbox.x) || !Number.isFinite(f.bbox.y) ||
      !Number.isFinite(f.bbox.width) || !Number.isFinite(f.bbox.height) ||
      f.bbox.x < 0 || f.bbox.y < 0 ||
      f.bbox.x + f.bbox.width > width || f.bbox.y + f.bbox.height > height ||
      f.bbox.width < 8 || f.bbox.height < 8) return false;
  return Number.isFinite(f.estimatedModuleSize) && f.estimatedModuleSize > 0;
}

function maybeDownscale(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  deep: boolean,
): { rgba: Uint8ClampedArray; w: number; h: number; scale: number } {
  const pixelBudget = deep ? 4_000_000 : 2_000_000;
  const total = width * height;
  const scale = Math.min(1, 2400 / Math.max(width, height), Math.sqrt(pixelBudget / total));
  if (scale >= 1) return { rgba: src, w: width, h: height, scale: 1 };
  let newW = Math.max(1, Math.round(width * scale));
  let newH = Math.max(1, Math.round(height * scale));
  while (newW * newH > pixelBudget || Math.max(newW, newH) > 2400) {
    if (newW >= newH && newW > 1) newW--;
    else if (newH > 1) newH--;
    else break;
  }
  // Bilinear downscale — fine for QR localisation, much faster than offscreen
  // canvas calls inside a worker.
  const out = new Uint8ClampedArray(newW * newH * 4);
  const xRatio = width / newW;
  const yRatio = height / newH;
  for (let y = 0; y < newH; y++) {
    const sy = Math.min(height - 1, Math.floor(y * yRatio));
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(width - 1, Math.floor(x * xRatio));
      const sIdx = (sy * width + sx) * 4;
      const dIdx = (y * newW + x) * 4;
      out[dIdx] = src[sIdx]; out[dIdx + 1] = src[sIdx + 1]; out[dIdx + 2] = src[sIdx + 2]; out[dIdx + 3] = src[sIdx + 3];
    }
  }
  return { rgba: out, w: newW, h: newH, scale };
}

function spatialCount(findings: DetectedQRPayload[]): number {
  return dedupe(findings).length;
}

function ensureWithinDeadline(deadlineAt?: number): void {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    const error = new Error('QR detection deadline exceeded');
    error.name = 'QRDetectionTimeout';
    throw error;
  }
}

function workerProgress(
  message: 'Scanning original raster' | 'Trying enhanced local variants' | 'Scanning image regions' | 'Finishing QR scan',
): void {
  (self as unknown as Worker).postMessage({ type: 'progress', message });
}

self.onmessage = async (e: MessageEvent) => {
  const {
    imageData,
    width: rasterW,
    height: rasterH,
    sourceWidth = rasterW,
    sourceHeight = rasterH,
    maxCodes: requestedMaxCodes = 4,
    deep = false,
    deadlineAt,
  } = e.data as DetectRequest;
  const maxCodes = Number.isFinite(requestedMaxCodes)
    ? Math.max(0, Math.floor(requestedMaxCodes))
    : 4;

  try {
    ensureWithinDeadline(deadlineAt);
    if (maxCodes === 0) {
      (self as unknown as Worker).postMessage({
        type: 'result',
        coordinateSpace: 'source',
        qrCodes: [],
      });
      return;
    }
    // Downscale huge images before detection. We map detected coords back
    // to source-image space at the very end so callers always see
    // source-pixel bboxes.
    const { rgba: workRgba, w: width, h: height } = maybeDownscale(imageData, rasterW, rasterH, deep);
    const sourceScaleX = sourceWidth / width;
    const sourceScaleY = sourceHeight / height;
    workerProgress('Scanning original raster');

    // Compute luma + Otsu once — these feed many variants, no point
    // recomputing.
    const luma = rgbaToLuma(workRgba);
    const otsuT = computeOtsuThreshold(luma);
    const stretched = stretchContrast(luma);
    const stretchedOtsuT = computeOtsuThreshold(stretched);
    const otsuRgba = lumaToRgba(applyThreshold(luma, otsuT));

    // Variants are described as factory functions so we never hold more
    // than one large RGBA buffer in memory at a time. Order is rough
    // priority — earlier variants are cheaper / more common to succeed.
    type VariantFn = () => { name: string; rgba: Uint8ClampedArray; w: number; h: number; rotations: number; baseOriginX: number; baseOriginY: number };
    // Per-channel isolation: extract R, G, or B as greyscale then Otsu.
    // Coloured QR modules (e.g. dark blue on colourful background) that
    // blend into mid-luma on a standard Y' conversion become crisp B/W
    // when isolated in the channel where they have maximum contrast.
    const extractChannel = (rgba: Uint8ClampedArray, ch: 0|1|2): Uint8ClampedArray => {
      const lm = new Uint8ClampedArray(rgba.length/4);
      for (let i=0,j=0;i<rgba.length;i+=4,j++) {
        const a=rgba[i+3]/255;
        lm[j]=(rgba[i+ch]*a+255*(1-a))|0;
      }
      return lm;
    };
    const rLuma = extractChannel(workRgba, 0);
    const gLuma = extractChannel(workRgba, 1);
    const bLuma = extractChannel(workRgba, 2);
    const rOtsuT = computeOtsuThreshold(rLuma);
    const gOtsuT = computeOtsuThreshold(gLuma);
    const bOtsuT = computeOtsuThreshold(bLuma);

    // Local adaptive threshold: split into cells, Otsu per cell.
    // Handles QRs embedded in uneven or busy backgrounds where a single
    // global threshold fails.
    const localAdaptive = (rgba: Uint8ClampedArray, w: number, h: number, cellSize: number): Uint8ClampedArray => {
      const lm = new Uint8ClampedArray(rgba.length/4);
      for (let i=0,j=0;i<rgba.length;i+=4,j++) {
        const a=rgba[i+3]/255;
        lm[j]=(0.299*(rgba[i]*a+255*(1-a))+0.587*(rgba[i+1]*a+255*(1-a))+0.114*(rgba[i+2]*a+255*(1-a)))|0;
      }
      const out = new Uint8ClampedArray(w*h*4);
      const cols=Math.ceil(w/cellSize), rows=Math.ceil(h/cellSize);
      for (let row=0;row<rows;row++) for (let col=0;col<cols;col++) {
        const x0=col*cellSize,y0=row*cellSize,x1=Math.min(x0+cellSize,w),y1=Math.min(y0+cellSize,h);
        const cell=new Uint8ClampedArray((x1-x0)*(y1-y0));
        let k=0; for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++) cell[k++]=lm[y*w+x];
        const t=computeOtsuThreshold(cell);
        for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++) {
          const v=lm[y*w+x]<t?0:255; const idx=(y*w+x)*4;
          out[idx]=v;out[idx+1]=v;out[idx+2]=v;out[idx+3]=255;
        }
      }
      return out;
    };

    const variantFactories: VariantFn[] = [
      () => ({ name: 'raw', rgba: workRgba, w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      () => ({ name: 'otsu', rgba: otsuRgba, w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      () => ({ name: 'otsu-inv', rgba: lumaToRgba(applyThreshold(luma, otsuT, true)), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      () => ({ name: 'contrast', rgba: lumaToRgba(applyThreshold(stretched, stretchedOtsuT)), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      // Per-channel: coloured QR modules
      () => ({ name: 'ch-R', rgba: lumaToRgba(applyThreshold(rLuma, rOtsuT)), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      () => ({ name: 'ch-G', rgba: lumaToRgba(applyThreshold(gLuma, gOtsuT)), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      () => ({ name: 'ch-B', rgba: lumaToRgba(applyThreshold(bLuma, bOtsuT)), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      // Local adaptive: busy / uneven backgrounds
      () => ({ name: 'local-adapt', rgba: localAdaptive(workRgba, width, height, 48), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      // Logo-erase at multiple radii
      () => ({ name: 'erase22', rgba: eraseCentre(otsuRgba, width, height, 0.22), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      () => ({ name: 'erase30', rgba: eraseCentre(otsuRgba, width, height, 0.30), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      () => ({ name: 'erase40', rgba: eraseCentre(otsuRgba, width, height, 0.40), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      () => ({ name: 'erase50', rgba: eraseCentre(otsuRgba, width, height, 0.50), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      // Fixed thresholds: when Otsu picks wrong split point
      () => ({ name: 't80',  rgba: lumaToRgba(applyThreshold(luma, 80)),  w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      () => ({ name: 't128', rgba: lumaToRgba(applyThreshold(luma, 128)), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
      () => ({ name: 't180', rgba: lumaToRgba(applyThreshold(luma, 180)), w: width, h: height, rotations: 0, baseOriginX: 0, baseOriginY: 0 }),
    ];
    // Rotation variants — most engines auto-rotate but jsQR doesn't, and
    // some heavily-stylised QRs are easier for engines to localise when
    // upright. Generate on-demand to avoid keeping rotated buffers around.
    for (let r = 1; r <= 3; r++) {
      const turns = r;
      variantFactories.push(() => {
        let rotated = { data: workRgba, width, height };
        for (let i = 0; i < turns; i++) rotated = rotateRgba90(rotated.data, rotated.width, rotated.height);
        return { name: `rot${turns * 90}`, rgba: rotated.data, w: rotated.width, h: rotated.height, rotations: turns, baseOriginX: 0, baseOriginY: 0 };
      });
    }

    // Normal scans stay predictable; deep scans add enhanced local variants
    // and the regional pass.
    const scanFactories = deep
      ? variantFactories
      : [...variantFactories.slice(0, 4), ...variantFactories.slice(-3)];
    const allFindings: DetectedQRPayload[] = [];
    for (const [index, factory] of scanFactories.entries()) {
      ensureWithinDeadline(deadlineAt);
      const v = factory();
      const ctx: DetectionContext = { width: v.w, height: v.h, rotations: v.rotations, baseOriginX: v.baseOriginX, baseOriginY: v.baseOriginY };
      const found = await runEngines(v.rgba, ctx, v.name, width, height);
      allFindings.push(...found);
      const distinct = spatialCount(allFindings);
      if (deep && index === 4) workerProgress('Trying enhanced local variants');
      if (distinct >= maxCodes) break;
    }

    // Tile-based scan — only run if we haven't found enough yet *and*
    // the source is large enough that small QRs tucked into corners are
    // plausible after the work-canvas downscale.
    const distinctSoFar = spatialCount(allFindings);
    if (deep && distinctSoFar < maxCodes && Math.max(width, height) >= 800) {
      workerProgress('Scanning image regions');
      const tw = Math.floor(width / 2);
      const th = Math.floor(height / 2);
      const overlap = Math.floor(Math.min(tw, th) * 0.25);
      const tiles: Array<{ x: number; y: number; w: number; h: number }> = [
        { x: 0, y: 0, w: tw + overlap, h: th + overlap },
        { x: tw - overlap, y: 0, w: width - (tw - overlap), h: th + overlap },
        { x: 0, y: th - overlap, w: tw + overlap, h: height - (th - overlap) },
        { x: tw - overlap, y: th - overlap, w: width - (tw - overlap), h: height - (th - overlap) },
      ];
      for (const tile of tiles) {
        const tileBuf = new Uint8ClampedArray(tile.w * tile.h * 4);
        for (let y = 0; y < tile.h; y++) {
          const srcRow = (tile.y + y) * width * 4;
          const dstRow = y * tile.w * 4;
          tileBuf.set(workRgba.subarray(srcRow + tile.x * 4, srcRow + (tile.x + tile.w) * 4), dstRow);
        }
        const tileLuma = rgbaToLuma(tileBuf);
        const tileOtsu = computeOtsuThreshold(tileLuma);
        const tileOtsuRgba = lumaToRgba(applyThreshold(tileLuma, tileOtsu));
        for (const tv of [
          { name: `tile-raw[${tile.x},${tile.y}]`, rgba: tileBuf },
          { name: `tile-otsu[${tile.x},${tile.y}]`, rgba: tileOtsuRgba },
        ]) {
          ensureWithinDeadline(deadlineAt);
          const ctx: DetectionContext = { width: tile.w, height: tile.h, rotations: 0, baseOriginX: tile.x, baseOriginY: tile.y };
          const found = await runEngines(tv.rgba, ctx, tv.name, tile.w, tile.h);
          allFindings.push(...found);
          if (spatialCount(allFindings) >= maxCodes) break;
        }
        if (spatialCount(allFindings) >= maxCodes) break;
      }
    }

    // Map work-coords back to source-image coords.
    const sourceCoordFindings = allFindings.map((f) => {
      const map = (p: { x: number; y: number }) => ({ x: p.x * sourceScaleX, y: p.y * sourceScaleY });
      const corners = {
        topLeft: map(f.corners.topLeft),
        topRight: map(f.corners.topRight),
        bottomLeft: map(f.corners.bottomLeft),
        bottomRight: map(f.corners.bottomRight),
      };
      return {
        ...f,
        corners,
        bbox: bboxFromCorners(corners),
        rotation: rotationFromCorners(corners),
        estimatedModuleSize: estimateModuleSize(corners),
      };
    });

    const deduped = dedupe(sourceCoordFindings.map((f) => ({
      ...f,
      payload: typeof f.payload === 'string' ? f.payload : '',
    })).filter((f) => validGeometry(f, sourceWidth, sourceHeight)));
    const final = deduped.filter((f) =>
      f.bbox.width >= 8 && f.bbox.height >= 8 &&
      f.bbox.width <= sourceWidth && f.bbox.height <= sourceHeight);

    workerProgress('Finishing QR scan');
    (self as unknown as Worker).postMessage({
      type: 'result',
      coordinateSpace: 'source',
      qrCodes: final.slice(0, maxCodes),
    });
  } catch (err: unknown) {
    (self as unknown as Worker).postMessage({
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof Error && err.name === 'QRDetectionTimeout' ? 'timeout' : 'worker',
    });
  }
};

export {};
