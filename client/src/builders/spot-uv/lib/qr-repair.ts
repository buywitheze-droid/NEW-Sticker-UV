import QRCode from "qrcode";
import jsQR from "jsqr";
import type {
  QRRepairDraft,
  QRRepairOptions,
  QRRepairRegion,
  QRRepairResult,
  QRRepairSource,
  QRErrorCorrection,
} from "./qr-repair-types";

export type {
  QRRepairDraft,
  QRRepairOptions,
  QRRepairRegion,
  QRRepairResult,
  QRRepairSource,
  QRErrorCorrection,
} from "./qr-repair-types";

// Conservative print guidance, not a QR decoding requirement.
const MIN_CONTRAST_RATIO = 4.5;
const MAX_PATCH_EDGE = 8192;
const MAX_PATCH_PIXELS = 16_000_000;
const MAX_VERIFY_EDGE = 1200;
export type QRRepairScale = number | { x: number; y: number };
function scaleAxes(scale: QRRepairScale): { x: number; y: number } {
  return typeof scale === "number" ? { x: scale, y: scale } : scale;
}
function validScale(scale: QRRepairScale): boolean {
  const axes = scaleAxes(scale);
  return !!axes && [axes.x, axes.y].every(n => Number.isFinite(n) && n > 0);
}

type RGB = { r: number; g: number; b: number };
type RGBA = RGB & { a: number };

function sourceSize(source: QRRepairSource): { width: number; height: number } {
  if (!source || typeof source !== "object") {
    throw new Error("QR repair source is missing");
  }

  const candidate = source as HTMLImageElement & HTMLCanvasElement;
  const width = Math.floor(Number(candidate.naturalWidth || candidate.width));
  const height = Math.floor(Number(candidate.naturalHeight || candidate.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("QR repair source has no usable dimensions");
  }
  if (typeof (source as HTMLCanvasElement).getContext !== "function" &&
      typeof (source as HTMLImageElement).src !== "string") {
    throw new Error("QR repair source is not drawable");
  }
  return { width, height };
}

function assertRegion(
  region: QRRepairRegion,
  sourceWidth?: number,
  sourceHeight?: number,
): { x: number; y: number; width: number; height: number } {
  if (!region || typeof region !== "object") throw new Error("QR repair region is missing");
  const values = [region.x, region.y, region.width, region.height];
  if (!values.every((value) => Number.isFinite(value))) {
    throw new Error("QR repair region must contain finite coordinates");
  }
  // Fractional source coordinates make it impossible to guarantee integer
  // module placement and an exact, inside-the-box paint. Reject them instead
  // of silently rounding into a neighbouring design element.
  if (!values.every((value) => Number.isInteger(value))) {
    throw new Error("QR repair region coordinates must be integers");
  }
  if (region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0) {
    throw new Error("QR repair region must be a positive rectangle");
  }
  if (sourceWidth !== undefined && sourceHeight !== undefined &&
      (region.x + region.width > sourceWidth || region.y + region.height > sourceHeight)) {
    throw new Error("QR repair region is outside the source");
  }
  if (region.width > MAX_PATCH_EDGE || region.height > MAX_PATCH_EDGE ||
      region.width * region.height > MAX_PATCH_PIXELS) {
    throw new Error("QR repair region exceeds the supported patch size");
  }
  return { x: region.x, y: region.y, width: region.width, height: region.height };
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    throw new Error("QR repair requires a canvas-capable document");
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width <= 0 || height <= 0 ||
      width > MAX_PATCH_EDGE || height > MAX_PATCH_EDGE ||
      width * height > MAX_PATCH_PIXELS) {
    throw new Error("QR repair canvas dimensions are not supported");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas: HTMLCanvasElement, readFrequently = false): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", readFrequently ? { willReadFrequently: true } : undefined);
  if (!context) throw new Error("Failed to obtain a 2D canvas context for QR repair");
  return context;
}

function sourceToRegionCanvas(source: QRRepairSource, region: QRRepairRegion): HTMLCanvasElement {
  const { width, height } = sourceSize(source);
  const checked = assertRegion(region, width, height);
  const sample = createCanvas(checked.width, checked.height);
  const context = context2d(sample);

  // Canvas pixels are read as RGB by jsQR. Paint a white ground first so both
  // transparent source pixels and transparent QR colours have deterministic,
  // print-like compositing.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, checked.width, checked.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(
    source,
    checked.x,
    checked.y,
    checked.width,
    checked.height,
    0,
    0,
    checked.width,
    checked.height,
  );
  return sample;
}

function parseColor(value: string): RGBA | null {
  if (typeof value !== "string") return null;
  const input = value.trim().toLowerCase();
  let match: RegExpMatchArray | null;

  if ((match = input.match(/^#([0-9a-f]{3,4})$/i))) {
    const digits = match[1];
    const r = parseInt(`${digits[0]}${digits[0]}`, 16);
    const g = parseInt(`${digits[1]}${digits[1]}`, 16);
    const b = parseInt(`${digits[2]}${digits[2]}`, 16);
    const a = digits.length === 4 ? parseInt(`${digits[3]}${digits[3]}`, 16) / 255 : 1;
    return { r, g, b, a };
  }
  if ((match = input.match(/^#([0-9a-f]{6}|[0-9a-f]{8})$/i))) {
    const digits = match[1];
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
    };
  }
  if ((match = input.match(/^rgba?\(\s*([^)]*)\)$/i))) {
    const parts = match[1].replace(/\//g, ",").split(/[\s,]+/).filter(Boolean);
    if (parts.length >= 3) {
      const channel = (part: string): number => part.endsWith("%")
        ? Math.round(Math.max(0, Math.min(100, parseFloat(part))) * 2.55)
        : Math.max(0, Math.min(255, parseFloat(part)));
      const alpha = parts[3] === undefined
        ? 1
        : (parts[3].endsWith("%")
          ? Math.max(0, Math.min(100, parseFloat(parts[3]))) / 100
          : Math.max(0, Math.min(1, parseFloat(parts[3]))));
      const r = channel(parts[0]);
      const g = channel(parts[1]);
      const b = channel(parts[2]);
      if ([r, g, b, alpha].every(Number.isFinite)) return { r, g, b, a: alpha };
    }
  }

  // CSS named colours are useful for callers that use the same values as
  // CanvasRenderingContext2D. Keep the table intentionally small and
  // deterministic; all common QR colours are covered.
  const named: Record<string, string> = {
    black: "#000000",
    white: "#ffffff",
    red: "#ff0000",
    green: "#008000",
    blue: "#0000ff",
    yellow: "#ffff00",
    cyan: "#00ffff",
    magenta: "#ff00ff",
    gray: "#808080",
    grey: "#808080",
    transparent: "#00000000",
  };
  const namedValue = named[input];
  if (namedValue) return parseColor(namedValue);
  return null;
}

function opaqueRGB(color: RGBA): RGB {
  return {
    r: Math.round(color.r * color.a + 255 * (1 - color.a)),
    g: Math.round(color.g * color.a + 255 * (1 - color.a)),
    b: Math.round(color.b * color.a + 255 * (1 - color.a)),
  };
}

function cssHex(color: RGB): string {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function relativeLuminance(color: RGB): number {
  const linear = (channel: number) => {
    const value = Math.max(0, Math.min(255, channel)) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

function contrastRatio(dark: string, light: string): number {
  const darkRGB = parseColor(dark);
  const lightRGB = parseColor(light);
  if (!darkRGB || !lightRGB) return 1;
  const a = relativeLuminance(opaqueRGB(darkRGB));
  const b = relativeLuminance(opaqueRGB(lightRGB));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function weightedHistogramColor(
  data: Uint8ClampedArray,
  quantile: number,
): RGB {
  const bins = Array.from({ length: 256 }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
  let total = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    // The sample has already been composited onto white. Treating it as
    // opaque here deliberately excludes alpha from colour inference.
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = Math.max(0, Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)));
    const bin = bins[luma];
    bin.weight++;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    total++;
  }
  if (total === 0) return { r: 255, g: 255, b: 255 };
  const wanted = Math.max(0, Math.min(1, quantile)) * (total - 1);
  let seen = 0;
  for (const bin of bins) {
    if (seen + bin.weight > wanted && bin.weight > 0) {
      return {
        r: bin.r / bin.weight,
        g: bin.g / bin.weight,
        b: bin.b / bin.weight,
      };
    }
    seen += bin.weight;
  }
  const last = bins[255];
  return last.weight > 0
    ? { r: last.r / last.weight, g: last.g / last.weight, b: last.b / last.weight }
    : { r: 255, g: 255, b: 255 };
}

/**
 * Infer the two dominant QR colours. Sampling is done after compositing over
 * white and uses weighted luminance quartiles, which avoids picking a logo,
 * antialiased edges, or transparent pixels as either module colour.
 */
export function sampleQRRepairColors(
  source: QRRepairSource,
  region: QRRepairRegion,
): { dark: string; light: string } {
  const sample = sourceToRegionCanvas(source, region);
  const context = context2d(sample, true);
  const image = context.getImageData(0, 0, sample.width, sample.height);
  // A QR's dark modules can be under one quarter of a bbox (finder and
  // alignment patterns are not guaranteed to dominate), so the raw 25th
  // percentile may already be background. Endpoint-weighted quartiles keep
  // the robust histogram behaviour while selecting each colour cluster.
  const dark = weightedHistogramColor(image.data, 0.10);
  const light = weightedHistogramColor(image.data, 0.90);
  return { dark: cssHex(dark), light: cssHex(light) };
}

function rgbToHsl(color: RGB): { h: number; s: number; l: number } {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

function hslToRGB(h: number, s: number, l: number): RGB {
  if (s === 0) {
    const value = Math.round(l * 255);
    return { r: value, g: value, b: value };
  }
  const hue = (h % 1 + 1) % 1;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hueToChannel = (t: number) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return {
    r: Math.round(hueToChannel(hue + 1 / 3) * 255),
    g: Math.round(hueToChannel(hue) * 255),
    b: Math.round(hueToChannel(hue - 1 / 3) * 255),
  };
}

/**
 * Return a contrast-safe pair while retaining each input colour's hue and
 * saturation. Explicitly supplied colours are never changed by buildQRRepair;
 * this helper is the opt-in suggestion path.
 */
export function suggestQRRepairColors(
  dark: string,
  light: string,
): { dark: string; light: string } {
  const darkParsed = parseColor(dark);
  const lightParsed = parseColor(light);
  if (!darkParsed || !lightParsed) return { dark: "#000000", light: "#ffffff" };
  const darkRGB = opaqueRGB(darkParsed);
  const lightRGB = opaqueRGB(lightParsed);
  if (contrastRatio(dark, light) >= MIN_CONTRAST_RATIO) {
    return { dark, light };
  }

  const darkHsl = rgbToHsl(darkRGB);
  const lightHsl = rgbToHsl(lightRGB);
  const darkLightness = [darkHsl.l, 0.2, 0.15, 0.1, 0.05];
  const lightLightness = [lightHsl.l, 0.8, 0.85, 0.9, 0.95];
  let best: { dark: string; light: string; ratio: number } | null = null;
  for (const dL of darkLightness) {
    for (const lL of lightLightness) {
      const candidateDark = cssHex(hslToRGB(darkHsl.h, darkHsl.s, dL));
      const candidateLight = cssHex(hslToRGB(lightHsl.h, lightHsl.s, lL));
      const ratio = contrastRatio(candidateDark, candidateLight);
      if (!best || ratio > best.ratio) {
        best = { dark: candidateDark, light: candidateLight, ratio };
      }
      if (ratio >= MIN_CONTRAST_RATIO) return { dark: candidateDark, light: candidateLight };
    }
  }

  // Saturated colours at the ends of the HSL range can still have too little
  // relative luminance separation. The hue is retained; the saturation is
  // reduced only as a last resort, rather than silently returning the user's
  // unsafe pair.
  for (let saturation = 1; saturation >= 0; saturation -= 0.1) {
    const candidateDark = cssHex(hslToRGB(darkHsl.h, darkHsl.s * saturation, 0.05));
    const candidateLight = cssHex(hslToRGB(lightHsl.h, lightHsl.s * saturation, 0.95));
    if (contrastRatio(candidateDark, candidateLight) >= MIN_CONTRAST_RATIO) {
      return { dark: candidateDark, light: candidateLight };
    }
  }
  return best
    ? { dark: best.dark, light: best.light }
    : { dark: "#000000", light: "#ffffff" };
}

function validateOptions(options: QRRepairOptions): {
  payload: string;
  dark: string;
  light: string;
  errorCorrectionLevel: QRErrorCorrection;
  quietZone: number;
  preserveLogo: boolean;
  logoScale: number;
} {
  if (!options || typeof options !== "object") throw new Error("QR repair options are missing");
  if (typeof options.payload !== "string" || options.payload.length === 0) {
    throw new Error("QR repair payload must be a non-empty string");
  }
  if (typeof options.dark !== "string" || !parseColor(options.dark)) {
    throw new Error("QR repair dark colour is invalid");
  }
  if (typeof options.light !== "string" || !parseColor(options.light)) {
    throw new Error("QR repair light colour is invalid");
  }
  if (!["L", "M", "Q", "H"].includes(options.errorCorrectionLevel)) {
    throw new Error("QR repair error correction level is invalid");
  }
  const quietZone = options.quietZone ?? 4;
  if (!Number.isInteger(quietZone) || quietZone < 4 || quietZone > 8) {
    throw new Error("QR repair quiet zone must be an integer from 4 through 8");
  }
  const preserveLogo = options.preserveLogo ?? false;
  if (typeof preserveLogo !== "boolean") throw new Error("QR repair preserveLogo is invalid");
  const logoScale = options.logoScale ?? 0.2;
  if (!Number.isFinite(logoScale) || logoScale < 0.1 || logoScale > 0.25) {
    throw new Error("QR repair logoScale must be between 0.1 and 0.25");
  }
  return {
    payload: options.payload,
    dark: options.dark,
    light: options.light,
    errorCorrectionLevel: options.errorCorrectionLevel,
    quietZone,
    preserveLogo,
    logoScale,
  };
}

function qrMatrix(payload: string, level: QRErrorCorrection): { size: number; data: Uint8Array } {
  const qr = QRCode.create(payload, { errorCorrectionLevel: level });
  const modules = qr.modules as unknown as { size?: number; data?: Uint8Array };
  if (!modules || !Number.isInteger(modules.size) || !modules.data ||
      modules.data.length !== (modules.size as number) ** 2) {
    throw new Error("QR encoder returned an invalid module matrix");
  }
  return { size: modules.size as number, data: new Uint8Array(modules.data) };
}

function rgbaImageForJsQR(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const context = context2d(canvas, true);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = image.data[i + 3] / 255;
    data[i] = Math.round(image.data[i] * alpha + 255 * (1 - alpha));
    data[i + 1] = Math.round(image.data[i + 1] * alpha + 255 * (1 - alpha));
    data[i + 2] = Math.round(image.data[i + 2] * alpha + 255 * (1 - alpha));
    data[i + 3] = 255;
  }
  return data;
}

function resizedForVerification(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const largest = Math.max(canvas.width, canvas.height);
  if (largest <= MAX_VERIFY_EDGE) return canvas;
  const factor = MAX_VERIFY_EDGE / largest;
  const width = Math.max(1, Math.round(canvas.width * factor));
  const height = Math.max(1, Math.round(canvas.height * factor));
  const resized = createCanvas(width, height);
  const context = context2d(resized);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  // Nearest-neighbour retains the hard module polarity when verification is
  // bounded for a very large print patch.
  context.imageSmoothingEnabled = false;
  context.drawImage(canvas, 0, 0, width, height);
  return resized;
}

function decodeExact(
  canvas: HTMLCanvasElement,
  expectedPayload: string,
): { decodedPayload: string | null; bounded: boolean; pixelsPerModule: number } {
  const measuredDensity = (code: ReturnType<typeof jsQR>, scale: number) => {
    if (!code) return 0;
    const p = code.location;
    const edges = [
      [p.topLeftCorner, p.topRightCorner], [p.topRightCorner, p.bottomRightCorner],
      [p.bottomRightCorner, p.bottomLeftCorner], [p.bottomLeftCorner, p.topLeftCorner],
    ];
    return Math.min(...edges.map(([a, b]) => Math.hypot(a.x - b.x, a.y - b.y))) /
      (17 + 4 * code.version) / scale;
  };
  const verificationCanvas = resizedForVerification(canvas);
  const bounded = verificationCanvas !== canvas;
  const boundedData = rgbaImageForJsQR(verificationCanvas);
  const boundedCode = jsQR(boundedData, verificationCanvas.width, verificationCanvas.height, {
    inversionAttempts: "attemptBoth",
  });
  // A bounded pass prevents a very large print canvas from monopolising the
  // main thread. For ordinary-sized target output, also decode the actual
  // final pixels so a resample artefact cannot be hidden by the preview pass.
  if (bounded && canvas.width * canvas.height <= 4_000_000) {
    const targetData = rgbaImageForJsQR(canvas);
    const targetCode = jsQR(targetData, canvas.width, canvas.height, {
      inversionAttempts: "attemptBoth",
    });
    return {
      decodedPayload: targetCode?.data ?? null,
      bounded: true,
      pixelsPerModule: measuredDensity(targetCode, 1),
    };
  }
  return {
    decodedPayload: boundedCode?.data ?? null,
    bounded,
    pixelsPerModule: measuredDensity(boundedCode, Math.min(
      verificationCanvas.width / canvas.width, verificationCanvas.height / canvas.height,
    )),
  };
}

function warningForVerification(
  decodedPayload: string | null,
  expectedPayload: string,
  ratio: number,
  pixelsPerModule: number,
): string[] {
  const warnings: string[] = [];
  if (ratio < MIN_CONTRAST_RATIO) warnings.push("Low contrast: these colors may be harder to scan in print. Test a printed sample.");
  if (pixelsPerModule < 2) warnings.push("QR has fewer than two pixels per module");
  if (decodedPayload !== expectedPayload) warnings.push("QR payload could not be verified");
  return warnings;
}

/**
 * Build an isolated QR patch. The patch is exactly the supplied region, so
 * callers can safely draw it back at region.x/region.y without touching
 * adjacent artwork.
 */
export async function buildQRRepair(
  source: QRRepairSource,
  draft: QRRepairDraft,
): Promise<QRRepairResult> {
  const dimensions = sourceSize(source);
  const region = assertRegion(draft?.region, dimensions.width, dimensions.height);
  const options = validateOptions(draft?.options);
  if (draft.originalPayload !== undefined && draft.originalPayload !== options.payload) {
    throw new Error("QR repair payload differs from the original decoded payload");
  }

  const matrix = qrMatrix(options.payload, options.errorCorrectionLevel);
  const moduleCount = matrix.size;
  const available = Math.min(region.width, region.height);
  const pixelsPerModule = Math.floor(available / (moduleCount + options.quietZone * 2));
  if (pixelsPerModule < 1) {
    throw new Error("QR repair region is too small for the requested quiet zone");
  }

  const canvas = createCanvas(region.width, region.height);
  const context = context2d(canvas);
  const dark = parseColor(options.dark);
  const light = parseColor(options.light);
  // validateOptions has already checked both values.
  context.fillStyle = options.light;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const qrSize = (moduleCount + options.quietZone * 2) * pixelsPerModule;
  const originX = Math.floor((region.width - qrSize) / 2);
  const originY = Math.floor((region.height - qrSize) / 2);
  context.fillStyle = options.dark;
  context.imageSmoothingEnabled = false;
  for (let row = 0; row < moduleCount; row++) {
    for (let column = 0; column < moduleCount; column++) {
      if (matrix.data[row * moduleCount + column] === 0) continue;
      context.fillRect(
        originX + (options.quietZone + column) * pixelsPerModule,
        originY + (options.quietZone + row) * pixelsPerModule,
        pixelsPerModule,
        pixelsPerModule,
      );
    }
  }

  if (options.preserveLogo) {
    const logoSize = Math.max(1, Math.round(available * options.logoScale));
    const sourceLogoX = region.x + Math.floor((region.width - logoSize) / 2);
    const sourceLogoY = region.y + Math.floor((region.height - logoSize) / 2);
    const targetLogoX = Math.floor((region.width - logoSize) / 2);
    const targetLogoY = Math.floor((region.height - logoSize) / 2);
    context.imageSmoothingEnabled = false;
    context.drawImage(
      source,
      sourceLogoX,
      sourceLogoY,
      logoSize,
      logoSize,
      targetLogoX,
      targetLogoY,
      logoSize,
      logoSize,
    );
  }

  const ratio = dark && light ? contrastRatio(options.dark, options.light) : 1;
  const decoded = decodeExact(canvas, options.payload);
  const warnings = warningForVerification(
    decoded.decodedPayload,
    options.payload,
    ratio,
    pixelsPerModule,
  );
  if (decoded.bounded) {
    warnings.push("QR verification used a bounded scan image");
  }

  // Keep the result's draft options canonical only for values which were
  // omitted at runtime (quietZone/logoScale). Do not mutate the caller's
  // draft object.
  const canonicalDraft: QRRepairDraft = {
    ...draft,
    region: { ...region },
    options: {
      ...draft.options,
      quietZone: options.quietZone,
      preserveLogo: options.preserveLogo,
      logoScale: options.logoScale,
    },
  };
  return {
    draft: canonicalDraft,
    canvas,
    verified: pixelsPerModule >= 2 &&
      decoded.decodedPayload === options.payload,
    decodedPayload: decoded.decodedPayload,
    contrastRatio: ratio,
    moduleCount,
    pixelsPerModule,
    warnings,
  };
}

function rectanglesOverlap(a: QRRepairRegion, b: QRRepairRegion): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height;
}

function resampleCanvasForVerification(
  canvas: HTMLCanvasElement,
  scale: QRRepairScale,
): { canvas: HTMLCanvasElement; pixelsPerModuleScale: number } {
  const axes = scaleAxes(scale);
  const width = Math.max(1, Math.round(canvas.width * axes.x));
  const height = Math.max(1, Math.round(canvas.height * axes.y));
  if (width > MAX_PATCH_EDGE || height > MAX_PATCH_EDGE || width * height > MAX_PATCH_PIXELS) {
    throw new Error("Scaled QR exceeds the supported verification size");
  }
  const target = createCanvas(width, height);
  const context = context2d(target);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(canvas, 0, 0, width, height);
  return {
    canvas: target,
    pixelsPerModuleScale: Math.min(width / canvas.width, height / canvas.height),
  };
}

function verifyCanvasAtScale(
  result: QRRepairResult,
  scale: QRRepairScale,
): { verified: boolean; pixelsPerModule: number; warning?: string } {
  if (!validScale(scale)) {
    return { verified: false, pixelsPerModule: 0, warning: "Scale must be greater than zero" };
  }
  if (!result || !result.canvas || !result.draft?.options?.payload) {
    return { verified: false, pixelsPerModule: 0, warning: "QR repair result is incomplete" };
  }
  let target: HTMLCanvasElement;
  let actualScale: number;
  try {
    const resized = resampleCanvasForVerification(result.canvas, scale);
    target = resized.canvas;
    actualScale = resized.pixelsPerModuleScale;
  } catch (error) {
    return {
      verified: false,
      pixelsPerModule: result.pixelsPerModule * Math.min(scaleAxes(scale).x, scaleAxes(scale).y),
      warning: error instanceof Error ? error.message : "Scaled QR exceeds the supported verification size",
    };
  }

  const decoded = decodeExact(target, result.draft.options.payload);
  const ppm = result.pixelsPerModule * actualScale;
  const warning = decoded.decodedPayload !== result.draft.options.payload
      ? "QR payload did not survive the final-size resample"
      : ppm < 2
        ? "QR has fewer than two pixels per module at this scale"
        : undefined;
  return {
    verified: decoded.decodedPayload === result.draft.options.payload &&
      ppm >= 2,
    pixelsPerModule: ppm,
    ...(warning ? { warning } : {}),
  };
}

/**
 * Verify the generated patch after resampling it to a print/output scale.
 * This intentionally performs a real jsQR decode; module geometry and a
 * contrast ratio alone are not sufficient evidence that a small export will
 * scan.
 */
export function verifyQRRepairAtScale(
  result: QRRepairResult,
  scale: QRRepairScale,
): { verified: boolean; pixelsPerModule: number; warning?: string } {
  return verifyCanvasAtScale(result, scale);
}

/**
 * Verify pixels that are already committed to a source canvas/image. Unlike
 * buildQRRepair, this function never renders or substitutes a QR patch: it
 * only crops, resamples, decodes, and checks the observed module density.
 */
export function verifyQRRepairPixels(
  source: QRRepairSource,
  drafts: QRRepairDraft[],
  outputScale: QRRepairScale = 1,
): void {
  if (!validScale(outputScale)) {
    throw new Error("QR pixel verification scale must be greater than zero");
  }
  if (!Array.isArray(drafts)) throw new Error("QR pixel verification drafts must be an array");
  const dimensions = sourceSize(source);
  const regions = drafts.map((draft) => assertRegion(draft?.region, dimensions.width, dimensions.height));
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      if (rectanglesOverlap(regions[i], regions[j])) {
        throw new Error("QR pixel verification regions overlap");
      }
    }
  }

  for (let index = 0; index < drafts.length; index++) {
    const draft = drafts[index];
    const region = regions[index];
    const options = validateOptions(draft.options);
    if (draft.originalPayload !== undefined && draft.originalPayload !== options.payload) {
      throw new Error(`QR pixel verification rejected immutable payload for repair ${draft.id || index}`);
    }
    let patch: HTMLCanvasElement;
    try {
      patch = sourceToRegionCanvas(source, region);
    } catch (error) {
      throw new Error(
        `QR pixel verification could not read repair ${draft.id || index}: ${
          error instanceof Error ? error.message : "unreadable source"
        }`,
      );
    }
    let target: HTMLCanvasElement;
    try {
      const resized = resampleCanvasForVerification(patch, outputScale);
      target = resized.canvas;
    } catch (error) {
      throw new Error(
        `QR pixel verification output for repair ${draft.id || index} is too large: ${
          error instanceof Error ? error.message : "unsupported size"
        }`,
      );
    }

    const decoded = decodeExact(target, options.payload);
    if (decoded.decodedPayload !== options.payload) {
      throw new Error(`QR pixel verification failed payload for repair ${draft.id || index}`);
    }
    // Measure the actual decoded geometry. A preview resample has fractional
    // module spacing; reconstructing a new integer grid here rejects valid
    // committed pixels and does not measure what is really being exported.
    const actualPixelsPerModule = decoded.pixelsPerModule;
    if (actualPixelsPerModule < 1.95) {
      throw new Error(
        `QR pixel verification failed density for repair ${draft.id || index}: ` +
        `${actualPixelsPerModule.toFixed(2)} pixels per module`,
      );
    }

  }
}

/**
 * Build and verify every patch before painting any of them. A snapshot is
 * retained so a canvas failure during the final paint remains atomic too.
 */
export async function applyQRRepairs(
  sourceCanvas: HTMLCanvasElement,
  drafts: QRRepairDraft[],
  outputScale: QRRepairScale = 1,
): Promise<void> {
  if (!sourceCanvas || typeof sourceCanvas.getContext !== "function") {
    throw new Error("QR repair target must be a canvas");
  }
  if (!Array.isArray(drafts)) throw new Error("QR repair drafts must be an array");
  if (!validScale(outputScale)) {
    throw new Error("QR repair output scale must be greater than zero");
  }
  const width = Number(sourceCanvas.width);
  const height = Number(sourceCanvas.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("QR repair target canvas has invalid dimensions");
  }

  const regions = drafts.map((draft) => assertRegion(draft?.region, width, height));
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      if (rectanglesOverlap(regions[i], regions[j])) {
        throw new Error("QR repair regions overlap");
      }
    }
  }

  // Every build reads the unmodified source canvas. No call to drawImage on
  // sourceCanvas occurs until all builds, density checks, and decodes pass.
  const results: QRRepairResult[] = [];
  for (const draft of drafts) {
    const result = await buildQRRepair(sourceCanvas, draft);
    if (!result.verified) throw new Error("QR repair could not be verified");
    const atTarget = verifyQRRepairAtScale(result, outputScale);
    if (!atTarget.verified) {
      throw new Error(atTarget.warning ?? "QR repair failed final-size verification");
    }
    results.push(result);
  }

  if (results.length === 0) return;
  const sourceContext = context2d(sourceCanvas);
  // A print canvas may legitimately be larger than the 16 MP patch limit.
  // Snapshot only affected rectangles for rollback; never allocate a full
  // source-sized clone.
  const snapshots = results.map((result) => {
    const region = result.draft.region;
    const canvas = createCanvas(region.width, region.height);
    const context = context2d(canvas);
    context.imageSmoothingEnabled = false;
    context.drawImage(
      sourceCanvas,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      region.width,
      region.height,
    );
    return { region, canvas };
  });
  try {
    sourceContext.imageSmoothingEnabled = false;
    for (const result of results) {
      const region = result.draft.region;
      sourceContext.drawImage(result.canvas, region.x, region.y, region.width, region.height);
    }
  } catch (error) {
    sourceContext.imageSmoothingEnabled = false;
    for (const snapshot of snapshots) {
      const { region, canvas } = snapshot;
      sourceContext.clearRect(region.x, region.y, region.width, region.height);
      sourceContext.drawImage(canvas, region.x, region.y, region.width, region.height);
    }
    throw error;
  }
}
