// Run against a running dev server:
// PLAYWRIGHT_MODULE=/mnt/pid2/node_modules/playwright/index.mjs \
// CHROMIUM_EXECUTABLE=/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium \
//   node tests/qr-repair-studio-browser.mjs
//
// This is intentionally an end-to-end browser test. The normal scenario does
// not stub /api/detect-qr: QR detection is expected to stay local in the new
// worker. A separate, small status scenario supplies a synthetic worker only
// to exercise cancellation and a deadline error without waiting 20 seconds.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { PDFDocument } from "pdf-lib";
import { transform } from "esbuild";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "/mnt/pid2/node_modules/playwright/index.mjs"
);
const executablePath = process.env.CHROMIUM_EXECUTABLE ||
  "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";
const baseURL = process.env.TEST_BASE_URL ||
  `https://${process.env.REPLIT_DEV_DOMAIN}`;

assert.ok(
  process.env.REPLIT_DEV_DOMAIN || process.env.TEST_BASE_URL,
  "Set REPLIT_DEV_DOMAIN or TEST_BASE_URL before running this browser test",
);

const PAYLOAD = "https://example.com/qr-repair-test?id=navy-cream";
const ART_WIDTH = 1200;
const ART_HEIGHT = 900;
const DARK = "#111827";
const LIGHT = "#fff7ed";
const CENTER_LOGO_COLOR = "#ef476f";
const CORNER_LOGO_COLOR = "#2a9d8f";
const ADVANCED_OPTIONS_SUMMARY = /Advanced options: colors(?:, logo)? and scan settings/;

function makeFixture() {
  const artwork = createCanvas(ART_WIDTH, ART_HEIGHT);
  const context = artwork.getContext("2d");
  context.fillStyle = LIGHT;
  context.fillRect(0, 0, ART_WIDTH, ART_HEIGHT);

  // A little non-QR art makes the pixel-preservation assertion meaningful.
  context.fillStyle = "#d6c7b8";
  context.fillRect(0, 0, 64, ART_HEIGHT);
  context.fillRect(ART_WIDTH - 64, 0, 64, ART_HEIGHT);
  context.fillStyle = "#e8d8c8";
  context.fillRect(70, 70, 80, 80);
  context.fillRect(ART_WIDTH - 150, ART_HEIGHT - 150, 80, 80);

  const matrix = QRCode.create(PAYLOAD, { errorCorrectionLevel: "H" }).modules;
  const moduleSize = 8;
  const quietZone = 4;
  const qrSize = matrix.size * moduleSize;
  const totalSize = (matrix.size + quietZone * 2) * moduleSize;
  const regions = [
    { x: 100, y: 250 },
    { x: 740, y: 250 },
  ].map(({ x, y }) => ({
    x: x + quietZone * moduleSize,
    y: y + quietZone * moduleSize,
    width: qrSize,
    height: qrSize,
  }));

  for (const { x, y } of [{ x: 100, y: 250 }, { x: 740, y: 250 }]) {
    context.fillStyle = LIGHT;
    context.fillRect(x, y, totalSize, totalSize);
    context.fillStyle = DARK;
    for (let row = 0; row < matrix.size; row += 1) {
      for (let column = 0; column < matrix.size; column += 1) {
        if (matrix.get(column, row)) {
          context.fillRect(
            x + (column + quietZone) * moduleSize,
            y + (row + quietZone) * moduleSize,
            moduleSize,
            moduleSize,
          );
        }
      }
    }
  }

  return {
    name: "qr-repair-studio-navy-cream.png",
    mimeType: "image/png",
    buffer: artwork.toBuffer("image/png"),
    regions,
  };
}

const fixture = makeFixture();

function makeLogoFixture() {
  const artwork = createCanvas(ART_WIDTH, ART_HEIGHT);
  const context = artwork.getContext("2d");
  context.fillStyle = LIGHT;
  context.fillRect(0, 0, ART_WIDTH, ART_HEIGHT);
  context.fillStyle = "#d6c7b8";
  context.fillRect(0, 0, 64, ART_HEIGHT);
  context.fillRect(ART_WIDTH - 64, 0, 64, ART_HEIGHT);
  context.fillStyle = "#e8d8c8";
  context.fillRect(70, 70, 80, 80);
  context.fillRect(ART_WIDTH - 150, ART_HEIGHT - 150, 80, 80);

  const matrix = QRCode.create(PAYLOAD, { errorCorrectionLevel: "H" }).modules;
  const moduleSize = 8;
  const quietZone = 4;
  const qrSize = matrix.size * moduleSize;
  const totalSize = (matrix.size + quietZone * 2) * moduleSize;
  // jsQR reports the finder-pattern-to-finder-pattern square, not the quiet
  // zone. Keep the corner logo outside both the source finder pattern and the
  // repair engine's centred finder-pattern projection.
  const definitions = [
    {
      x: 100,
      y: 250,
      logo: {
        x: Math.round((qrSize - 56) / 2),
        y: Math.round((qrSize - 56) / 2),
        width: 56,
        height: 56,
      },
      color: CENTER_LOGO_COLOR,
      accent: "#ffd166",
    },
    {
      x: 740,
      y: 250,
      logo: { x: 96, y: 96, width: 40, height: 40 },
      color: CORNER_LOGO_COLOR,
      accent: "#f4a261",
    },
  ];
  const regions = definitions.map(({ x, y }) => ({
    x: x + quietZone * moduleSize,
    y: y + quietZone * moduleSize,
    width: qrSize,
    height: qrSize,
  }));
  const logos = definitions.map(({ logo, color, accent }, index) => {
    const region = regions[index];
    const absolute = {
      x: region.x + logo.x,
      y: region.y + logo.y,
      width: logo.width,
      height: logo.height,
    };
    return { ...absolute, color, accent };
  });

  definitions.forEach(({ x, y, logo, color, accent }) => {
    context.fillStyle = LIGHT;
    context.fillRect(x, y, totalSize, totalSize);
    context.fillStyle = DARK;
    for (let row = 0; row < matrix.size; row += 1) {
      for (let column = 0; column < matrix.size; column += 1) {
        if (matrix.get(column, row)) {
          context.fillRect(
            x + (column + quietZone) * moduleSize,
            y + (row + quietZone) * moduleSize,
            moduleSize,
            moduleSize,
          );
        }
      }
    }

    // Use a two-colour, block-aligned mark rather than a synthetic white
    // cutout. The exact solid-color bounds make the saved-PDF assertion prove
    // both location and extent, while the mark remains a real logo overlay
    // that exercises QR error correction.
    const regionX = x + quietZone * moduleSize;
    const regionY = y + quietZone * moduleSize;
    context.fillStyle = color;
    context.fillRect(regionX + logo.x, regionY + logo.y, logo.width, logo.height);
    context.fillStyle = accent;
    context.fillRect(
      regionX + logo.x + Math.round(logo.width * 0.25),
      regionY + logo.y + Math.round(logo.height * 0.25),
      Math.round(logo.width * 0.5),
      Math.round(logo.height * 0.5),
    );
  });

  return {
    name: "qr-repair-studio-logo-preservation.png",
    mimeType: "image/png",
    buffer: artwork.toBuffer("image/png"),
    regions,
    logos,
  };
}

const logoFixture = makeLogoFixture();

async function loadPopularLogoModule() {
  const source = await fs.readFile(
    new URL("../client/src/builders/spot-uv/lib/popular-qr-logos.ts", import.meta.url),
    "utf8",
  );
  const { code } = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "es2022",
    sourcemap: false,
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`,
  );
  assert.equal(typeof module.renderPopularQRLogo, "function", "popular logo module must expose renderPopularQRLogo");
  assert.ok(Array.isArray(module.POPULAR_QR_LOGOS), "popular logo module must expose its metadata");
  return module;
}

function makePopularLogoFixture(popularLogoModule) {
  const artwork = createCanvas(ART_WIDTH, ART_HEIGHT);
  const context = artwork.getContext("2d");
  context.fillStyle = LIGHT;
  context.fillRect(0, 0, ART_WIDTH, ART_HEIGHT);
  context.fillStyle = "#d6c7b8";
  context.fillRect(0, 0, 64, ART_HEIGHT);
  context.fillRect(ART_WIDTH - 64, 0, 64, ART_HEIGHT);
  context.fillStyle = "#e8d8c8";
  context.fillRect(70, 70, 80, 80);
  context.fillRect(ART_WIDTH - 150, ART_HEIGHT - 150, 80, 80);

  const matrix = QRCode.create(PAYLOAD, { errorCorrectionLevel: "H" }).modules;
  const moduleSize = 8;
  const quietZone = 4;
  const qrSize = matrix.size * moduleSize;
  const totalSize = (matrix.size + quietZone * 2) * moduleSize;
  const logoSide = 64;
  const definitions = [
    { x: 100, y: 250, id: "instagram" },
    { x: 740, y: 250, id: "facebook" },
  ];
  const metadata = new Map(popularLogoModule.POPULAR_QR_LOGOS.map((logo) => [logo.id, logo]));
  const regions = definitions.map(({ x, y }) => ({
    x: x + quietZone * moduleSize,
    y: y + quietZone * moduleSize,
    width: qrSize,
    height: qrSize,
  }));
  const logos = definitions.map(({ id }, index) => {
    const region = regions[index];
    const logo = {
      x: region.x + Math.round((qrSize - logoSide) / 2),
      y: region.y + Math.round((qrSize - logoSide) / 2),
      width: logoSide,
      height: logoSide,
    };
    const logoMetadata = metadata.get(id);
    assert.ok(logoMetadata, `popular logo metadata is missing ${id}`);
    return { ...logo, id, color: logoMetadata.color };
  });

  definitions.forEach(({ x, y }, index) => {
    context.fillStyle = LIGHT;
    context.fillRect(x, y, totalSize, totalSize);
    context.fillStyle = DARK;
    for (let row = 0; row < matrix.size; row += 1) {
      for (let column = 0; column < matrix.size; column += 1) {
        if (matrix.get(column, row)) {
          context.fillRect(
            x + (column + quietZone) * moduleSize,
            y + (row + quietZone) * moduleSize,
            moduleSize,
            moduleSize,
          );
        }
      }
    }
    popularLogoModule.renderPopularQRLogo(context, definitions[index].id, logos[index]);
  });

  return {
    name: "qr-repair-studio-popular-logos.png",
    mimeType: "image/png",
    buffer: artwork.toBuffer("image/png"),
    regions,
    logos,
  };
}

const popularLogoModule = await loadPopularLogoModule();
const popularLogoFixture = makePopularLogoFixture(popularLogoModule);

function makeManualFixture() {
  const artwork = createCanvas(ART_WIDTH, ART_HEIGHT);
  const context = artwork.getContext("2d");
  context.fillStyle = LIGHT;
  context.fillRect(0, 0, ART_WIDTH, ART_HEIGHT);
  context.fillStyle = "#d6c7b8";
  context.fillRect(0, 0, 64, ART_HEIGHT);
  context.fillRect(ART_WIDTH - 64, 0, 64, ART_HEIGHT);
  // This is deliberately a solid, non-QR region. Manual recovery must create
  // a QR from user content instead of relying on detector metadata.
  context.fillStyle = DARK;
  context.fillRect(360, 240, 240, 480);
  context.fillStyle = LIGHT;
  context.fillRect(600, 240, 240, 480);
  context.fillStyle = "#e8d8c8";
  context.fillRect(80, 80, 90, 90);
  context.fillRect(ART_WIDTH - 170, ART_HEIGHT - 170, 90, 90);
  return {
    name: "qr-repair-studio-manual-blank.png",
    mimeType: "image/png",
    buffer: artwork.toBuffer("image/png"),
    region: { x: 360, y: 240, width: 480, height: 480 },
  };
}

const manualFixture = makeManualFixture();

function imageDataForCanvas(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return { data: new Uint8ClampedArray(image.data), width: canvas.width, height: canvas.height };
}

function pdfDictionaryNumber(dictionary, key) {
  const match = dictionary.match(new RegExp(`/${key}\\s+(\\d+)`));
  return match ? Number(match[1]) : undefined;
}

function pdfDictionaryReference(dictionary, key) {
  const match = dictionary.match(new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`));
  return match ? Number(match[1]) : undefined;
}

function unfilterPdfImage(raw, dictionary) {
  const filter = dictionary.match(/\/Filter\s+\/([A-Za-z0-9]+)/)?.[1];
  if (!filter) return Buffer.from(raw);
  if (filter === "FlateDecode") return Buffer.from(inflateSync(raw));
  if (filter === "ASCII85Decode") {
    throw new Error("ASCII85 PDF image streams are not supported by this focused test");
  }
  throw new Error(`Unsupported embedded PDF image filter: ${filter}`);
}

function unfilterPdfPredictor(raw, dictionary, width, channels) {
  const predictor = pdfDictionaryNumber(dictionary, "Predictor");
  const columns = pdfDictionaryNumber(dictionary, "Columns") || width;
  if (!predictor || predictor < 10) return raw;
  const rowBytes = columns * channels;
  const stride = rowBytes + 1;
  if (raw.length < stride || raw.length % stride !== 0) {
    throw new Error(`Invalid PNG-predictor image stream (${raw.length} bytes, ${stride} stride)`);
  }
  const result = Buffer.alloc((raw.length / stride) * rowBytes);
  let sourceOffset = 0;
  let targetOffset = 0;
  let previous = Buffer.alloc(rowBytes);
  for (; sourceOffset < raw.length; sourceOffset += stride, targetOffset += rowBytes) {
    const predictorType = raw[sourceOffset];
    const row = Buffer.from(raw.subarray(sourceOffset + 1, sourceOffset + stride));
    for (let index = 0; index < row.length; index += 1) {
      const left = index >= channels ? row[index - channels] : 0;
      const up = previous[index] || 0;
      const upperLeft = index >= channels ? previous[index - channels] || 0 : 0;
      if (predictorType === 1) row[index] = (row[index] + left) & 0xff;
      else if (predictorType === 2) row[index] = (row[index] + up) & 0xff;
      else if (predictorType === 3) row[index] = (row[index] + Math.floor((left + up) / 2)) & 0xff;
      else if (predictorType === 4) {
        const estimate = left + up - upperLeft;
        const pa = Math.abs(estimate - left);
        const pb = Math.abs(estimate - up);
        const pc = Math.abs(estimate - upperLeft);
        row[index] = (row[index] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft)) & 0xff;
      } else if (predictorType !== 0) {
        throw new Error(`Unsupported PNG predictor row ${predictorType}`);
      }
    }
    row.copy(result, targetOffset);
    previous = row;
  }
  return result;
}

function embeddedPdfImages(pdfBytes) {
  const bytes = Buffer.from(pdfBytes);
  const latin = bytes.toString("latin1");
  const objects = new Map();
  const objectPattern = /(\d+)\s+0\s+obj\b/g;
  let match;
  while ((match = objectPattern.exec(latin))) {
    const id = Number(match[1]);
    const dictionaryStart = latin.indexOf("<<", match.index);
    const dictionaryEnd = latin.indexOf(">>", dictionaryStart + 2);
    const streamStartToken = latin.indexOf("stream", dictionaryEnd + 2);
    const objectEnd = latin.indexOf("endobj", dictionaryEnd + 2);
    if (dictionaryStart < 0 || dictionaryEnd < 0 || objectEnd < 0) continue;
    const dictionary = latin.slice(dictionaryStart, dictionaryEnd + 2);
    if (!/\/Subtype\s*\/Image\b/.test(dictionary) || streamStartToken < 0 || streamStartToken > objectEnd) {
      continue;
    }
    let dataStart = streamStartToken + "stream".length;
    if (bytes[dataStart] === 0x0d) dataStart += bytes[dataStart + 1] === 0x0a ? 2 : 1;
    else if (bytes[dataStart] === 0x0a) dataStart += 1;
    const dataEnd = bytes.indexOf(Buffer.from("\nendstream"), dataStart);
    if (dataEnd < 0) continue;
    const length = pdfDictionaryNumber(dictionary, "Length");
    const raw = length && dataStart + length <= dataEnd
      ? bytes.subarray(dataStart, dataStart + length)
      : bytes.subarray(dataStart, dataEnd);
    objects.set(id, { id, dictionary, raw });
  }

  const decoded = [];
  for (const image of objects.values()) {
    const width = pdfDictionaryNumber(image.dictionary, "Width");
    const height = pdfDictionaryNumber(image.dictionary, "Height");
    const bits = pdfDictionaryNumber(image.dictionary, "BitsPerComponent") || 8;
    const colorSpace = image.dictionary.match(/\/ColorSpace\s+\/([A-Za-z0-9]+)/)?.[1];
    if (!width || !height || bits !== 8 || !colorSpace) continue;
    const channels = colorSpace === "DeviceRGB" ? 3 : colorSpace === "DeviceGray" ? 1 : 0;
    if (!channels) continue;
    const filtered = unfilterPdfImage(image.raw, image.dictionary);
    const raster = unfilterPdfPredictor(filtered, image.dictionary, width, channels);
    if (raster.length < width * height * channels) continue;
    const maskId = pdfDictionaryReference(image.dictionary, "SMask");
    const mask = maskId === undefined ? undefined : objects.get(maskId);
    let alpha;
    if (mask) {
      const maskFiltered = unfilterPdfImage(mask.raw, mask.dictionary);
      alpha = unfilterPdfPredictor(maskFiltered, mask.dictionary, width, 1);
    }
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      const source = index * channels;
      const target = index * 4;
      const gray = raster[source];
      rgba[target] = channels === 1 ? gray : raster[source];
      rgba[target + 1] = channels === 1 ? gray : raster[source + 1];
      rgba[target + 2] = channels === 1 ? gray : raster[source + 2];
      rgba[target + 3] = alpha ? alpha[index] : 255;
    }
    decoded.push({ width, height, data: rgba, objectId: image.id, maskId });
  }
  return decoded;
}

function rgbFromHex(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(match, `expected a six-digit logo color, got ${hex}`);
  return [
    Number.parseInt(match[1].slice(0, 2), 16),
    Number.parseInt(match[1].slice(2, 4), 16),
    Number.parseInt(match[1].slice(4, 6), 16),
  ];
}

function colorBounds(raster, hex, tolerance = 0) {
  const [red, green, blue] = rgbFromHex(hex);
  let minX = raster.width;
  let minY = raster.height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const index = (y * raster.width + x) * 4;
      if (
        Math.abs(raster.data[index] - red) <= tolerance &&
        Math.abs(raster.data[index + 1] - green) <= tolerance &&
        Math.abs(raster.data[index + 2] - blue) <= tolerance
      ) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count += 1;
      }
    }
  }
  return maxX < 0
    ? undefined
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, count };
}

function normalizedBounds(bounds, raster) {
  return {
    x: bounds.x / raster.width,
    y: bounds.y / raster.height,
    width: bounds.width / raster.width,
    height: bounds.height / raster.height,
  };
}

function nearestLogoImage(pdfBytes, logo, label) {
  const expected = {
    x: (logo.x + logo.width / 2) / ART_WIDTH,
    y: (logo.y + logo.height / 2) / ART_HEIGHT,
  };
  const candidates = embeddedPdfImages(pdfBytes)
    .map((image) => {
      const bounds = colorBounds(image, logo.color, 2);
      if (!bounds) return undefined;
      const normalized = normalizedBounds(bounds, image);
      return {
        image,
        bounds,
        normalized,
        distance: Math.hypot(
          normalized.x + normalized.width / 2 - expected.x,
          normalized.y + normalized.height / 2 - expected.y,
        ),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.distance - right.distance);
  assert.ok(candidates.length, `${label}: PDF has no pixels for ${logo.color} logo`);
  const candidate = candidates[0];
  assert.ok(
    candidate.distance < 0.08,
    `${label}: ${logo.color} logo was found at an unexpected PDF location`,
  );
  return candidate;
}

function assertLogoPdfPreserved(beforePdf, afterPdf, logo, label) {
  const before = nearestLogoImage(beforePdf, logo, `${label} before Apply`);
  const after = nearestLogoImage(afterPdf, logo, `${label} after Apply`);
  const expected = {
    x: logo.x / ART_WIDTH,
    y: logo.y / ART_HEIGHT,
    width: logo.width / ART_WIDTH,
    height: logo.height / ART_HEIGHT,
  };
  for (const [edge, tolerance] of [
    ["x", 0.025],
    ["y", 0.025],
    ["width", 0.025],
    ["height", 0.025],
  ]) {
    assert.ok(
      Math.abs(after.normalized[edge] - expected[edge]) <= tolerance,
      `${label}: preserved ${logo.color} logo ${edge} moved or changed extent`,
    );
    assert.ok(
      Math.abs(after.normalized[edge] - before.normalized[edge]) <= tolerance,
      `${label}: preserved ${logo.color} logo ${edge} differs from original PDF`,
    );
  }
  assert.ok(
    after.bounds.count >= before.bounds.count * 0.8,
    `${label}: preserved ${logo.color} logo lost too many source pixels`,
  );
}

function decodeRaster(raster) {
  const { width, height, data } = raster;
  const found = new Set();
  const whole = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
  if (whole?.data) found.add(whole.data);

  // jsQR intentionally returns one code per call. Scan overlapping windows so
  // both equal-payload codes are independently decoded from the actual PNG.
  const windowWidth = Math.min(560, width);
  const windowHeight = Math.min(560, height);
  const xPositions = [...new Set([
    0,
    Math.max(0, Math.round(width * 0.28)),
    Math.max(0, Math.round(width * 0.53)),
    Math.max(0, width - windowWidth),
  ])];
  const yPositions = [...new Set([
    0,
    Math.max(0, Math.round(height * 0.25)),
    Math.max(0, height - windowHeight),
  ])];
  for (const x of xPositions) {
    for (const y of yPositions) {
      const cropWidth = Math.min(windowWidth, width - x);
      const cropHeight = Math.min(windowHeight, height - y);
      const cropData = new Uint8ClampedArray(cropWidth * cropHeight * 4);
      for (let row = 0; row < cropHeight; row += 1) {
        cropData.set(
          data.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + cropWidth) * 4),
          row * cropWidth * 4,
        );
      }
      const result = jsQR(cropData, cropWidth, cropHeight, { inversionAttempts: "attemptBoth" });
      if (result?.data) found.add(result.data);
    }
  }
  return {
    width,
    height,
    payloads: [...found],
    hasDarkNavy: [...data].some((value, index) => index % 4 === 0 && value === 17) &&
      [...data].some((value, index) => index % 4 === 1 && value === 24) &&
      [...data].some((value, index) => index % 4 === 2 && value === 39),
    hasCream: [...data].some((value, index) => index % 4 === 0 && value === 255) &&
      [...data].some((value, index) => index % 4 === 1 && value === 247) &&
      [...data].some((value, index) => index % 4 === 2 && value === 237),
    hasPureBlackOrWhite: data.some((value, index) => {
      if (index % 4 !== 0) return false;
      const green = data[index + 1];
      const blue = data[index + 2];
      return (value === 0 && green === 0 && blue === 0) ||
        (value === 255 && green === 255 && blue === 255);
    }),
  };
}

function rasterFingerprint(rasters) {
  const perRaster = rasters.map((raster) => {
    let hash = 2166136261;
    hash ^= raster.width;
    hash = Math.imul(hash, 16777619);
    hash ^= raster.height;
    hash = Math.imul(hash, 16777619);
    for (let index = 0; index < raster.data.length; index += 397) {
      hash ^= raster.data[index];
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }).sort((left, right) => left - right);
  let hash = 2166136261;
  for (const rasterHash of perRaster) {
    hash ^= rasterHash;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function decodeDownloadedPdf(buffer, label) {
  assert.equal(Buffer.from(buffer).subarray(0, 4).toString("ascii"), "%PDF", `${label}: export is not a PDF`);
  const pdf = await PDFDocument.load(buffer);
  assert.ok(pdf.getPages().length > 0, `${label}: PDF has no pages`);
  const images = embeddedPdfImages(buffer);
  assert.ok(images.length > 0, `${label}: PDF contains no RGB/Gray image streams`);
  const decoded = images.map(decodeRaster);
  const payloads = new Set(decoded.flatMap((result) => result.payloads));
  return {
    images,
    payloads: [...payloads],
    hasDarkNavy: decoded.some((result) => result.hasDarkNavy),
    hasCream: decoded.some((result) => result.hasCream),
    hasPureBlackOrWhite: decoded.some((result) => result.hasPureBlackOrWhite),
    pixelFingerprint: rasterFingerprint(images),
  };
}

async function downloadPrintPdf(page, label) {
  const pdfButton = page.getByRole("button", { name: "Download PDF", exact: true }).first();
  assert.equal(
    await pdfButton.count(),
    1,
    `${label}: the editor must expose its Download PDF action`,
  );
  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await pdfButton.click();
  // Implementations that reuse the no-cutline confirmation may defer the
  // actual download until this confirmation is accepted.
  const yes = page.getByRole("button", { name: "Yes", exact: true });
  if (await yes.count() && await yes.isVisible().catch(() => false)) {
    await yes.click();
  }
  const download = await downloadPromise;
  const path = await download.path();
  assert.ok(path, `${label}: Playwright did not expose a downloaded PDF path`);
  const bytes = await fs.readFile(path);
  return bytes;
}

async function waitForStableScan(page) {
  await page.getByRole("button", { name: /QR Repair Studio/ }).click();
  await page.waitForFunction(
    () => document.body.textContent.includes("Scan complete") ||
      document.body.textContent.includes("Scan error"),
    undefined,
    { timeout: 30_000 },
  );
  // Scan controls are intentionally behind the optional More tools disclosure
  // once scanning has settled. Open it only long enough to inspect the real
  // worker status, then return the modal to its simple default state.
  await setDisclosure(page, "More tools: scan again and diagnostics", true);
  if (await page.getByText(/Scan error/, { exact: false }).count()) {
    throw new Error(`QR scan failed: ${await page.locator('[aria-live="polite"]').last().innerText()}`);
  }
  const scanSummary = await page.getByText(/Found \d+ QR region/, { exact: false }).first().innerText();
  assert.match(scanSummary, /Found 2 QR regions\. Review before repairing\./,
    `detector returned an unexpected QR count: ${scanSummary}`);
  await setDisclosure(page, "More tools: scan again and diagnostics", false);
  await page.getByRole("heading", { name: "Choose a code", exact: true }).waitFor();
}

async function setDisclosure(page, summaryText, open) {
  const currentSummary = summaryText === "More tools: scan again and diagnostics"
    ? "Scan and diagnostics" : summaryText;
  const summary = page.locator("summary").filter({ hasText: currentSummary }).first();
  assert.equal(await summary.count(), 1, `missing disclosure: ${summaryText}`);
  const details = summary.locator("xpath=..");
  const currentOpen = await details.evaluate((element) => element.open);
  if (currentOpen !== open) await summary.click();
  assert.equal(
    await details.evaluate((element) => element.open),
    open,
    `${summaryText} disclosure did not become ${open ? "open" : "closed"}`,
  );
  return details;
}

async function assertSimpleModal(page, viewportLabel) {
  const advanced = page.locator("summary").filter({
    hasText: ADVANCED_OPTIONS_SUMMARY,
  }).first().locator("xpath=..");
  assert.equal(await advanced.count(), 1, `${viewportLabel}: Advanced disclosure is missing`);
  assert.equal(
    await advanced.evaluate((element) => element.open),
    false,
    `${viewportLabel}: Advanced options must be collapsed by default`,
  );

  const hiddenTechnicalControls = [
    page.getByLabel("Detected QR payload read-only"),
    page.getByLabel("Foreground color value"),
    page.getByLabel("Background color value"),
    page.getByRole("combobox", { name: "Error correction level" }),
    page.getByLabel("Quiet zone modules, from 4 to 8"),
    page.getByLabel("Manual region x in source pixels"),
    page.getByLabel("Manual region y in source pixels"),
    page.getByLabel("Manual region width in source pixels"),
    page.getByLabel("Manual region height in source pixels"),
  ];
  for (const control of hiddenTechnicalControls) {
    if (await control.count()) {
      assert.equal(
        await control.first().isVisible(),
        false,
        `${viewportLabel}: technical control unexpectedly visible before disclosure`,
      );
    }
  }

  // These assertions deliberately do not scroll any locator into view. The
  // compact flow must expose its before/after preview and primary actions in
  // both responsive layouts without requiring a technical-controls detour.
  for (const [name, control] of [
    ["Choose a code", page.getByRole("heading", { name: "Choose a code", exact: true })],
    ["Before & after", page.getByRole("heading", { name: "Before & after", exact: true })],
    ["Preview fix", page.getByRole("button", { name: "Preview fix and verify QR repair", exact: true })],
    ["Apply fix", page.getByRole("button", { name: "Apply verified QR repairs", exact: true })],
    ["Close", page.getByRole("button", { name: "Cancel QR repair studio", exact: true })],
  ]) {
    assert.equal(await control.count(), 1, `${viewportLabel}: missing ${name} control`);
    assert.equal(await control.isVisible(), true, `${viewportLabel}: ${name} is not visible without scrolling`);
  }
  assert.match(
    await page.getByRole("button", { name: "Preview fix and verify QR repair", exact: true }).innerText(),
    /Preview fix/,
    `${viewportLabel}: Preview fix visible label changed unexpectedly`,
  );
  assert.match(
    await page.getByRole("button", { name: "Apply verified QR repairs", exact: true }).innerText(),
    /Apply fix/,
    `${viewportLabel}: Apply fix visible label changed unexpectedly`,
  );
  assert.match(
    await page.getByRole("button", { name: "Cancel QR repair studio", exact: true }).innerText(),
    /Close/,
    `${viewportLabel}: Close visible label changed unexpectedly`,
  );
}

async function assertPrimaryButtonBounds(page, viewportLabel) {
  const viewport = page.viewportSize();
  assert.ok(viewport, `${viewportLabel}: Playwright viewport is unavailable`);
  // Radix's short dialog transition can still be settling after a viewport
  // change. Require actual in-viewport bounds, rather than sampling that frame.
  await page.waitForFunction(() => [
    "Preview fix and verify QR repair",
    "Apply verified QR repairs",
    "Cancel QR repair studio",
  ].every((label) => {
    const button = document.querySelector(`button[aria-label="${label}"]`);
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 &&
      rect.right <= innerWidth && rect.bottom <= innerHeight;
  }), undefined, { timeout: 3000 });
  for (const name of [
    "Preview fix and verify QR repair",
    "Apply verified QR repairs",
    "Cancel QR repair studio",
  ]) {
    const bounds = await page.getByRole("button", { name, exact: true }).boundingBox();
    assert.ok(
      bounds &&
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= viewport.width &&
        bounds.y + bounds.height <= viewport.height,
      `${viewportLabel}: primary action is clipped: ${name} ${JSON.stringify(bounds)}`,
    );
  }
}

async function assertPayloadReadOnly(page, expected = PAYLOAD) {
  const payload = page.getByLabel("Detected QR payload read-only");
  assert.equal(await payload.count(), 1, "selected detected QR must expose one exact payload field");
  assert.equal(await payload.inputValue(), expected, "detected payload changed unexpectedly");
  assert.equal(await payload.isEditable(), false, "detected payload must be read-only");
}

async function verifySelected(page) {
  const verify = page.getByRole("button", { name: "Preview fix and verify QR repair", exact: true });
  await verify.click();
  await page.getByText(/^(Payload matches exactly|Matches the original exactly)$/, { exact: true })
    .waitFor({ timeout: 30_000 });
  await page.getByText(/^(Passes the final output scale check\.|Passed at the final print size\.)$/, { exact: true })
    .waitFor({ timeout: 30_000 });
}

async function drawLogoSelection(page, logo, region, label, offsets = {}) {
  const selector = page.getByRole("application", {
    name: /Logo region selector\. Draw or redraw a rectangle around the logo\./i,
  }).first();
  assert.equal(await selector.count(), 1, `${label}: logo region selector is missing`);
  assert.equal(await selector.isVisible(), true, `${label}: logo region selector is not visible`);
  // The QR detector can include a quiet zone (or return a slightly different
  // corner box) than the fixture's nominal module square. Scroll the nested
  // modal before reading geometry, then derive the drag from the actual logo
  // pixels in the cropped canvas rather than assuming either convention.
  await selector.scrollIntoViewIfNeeded();
  const crop = selector.locator('canvas[aria-label="Cropped QR artwork for logo selection"]');
  assert.equal(await crop.count(), 1, `${label}: cropped QR canvas is missing`);
  const cropBox = await crop.boundingBox();
  assert.ok(cropBox && cropBox.width > 0 && cropBox.height > 0, `${label}: logo crop has no drawable area`);
  const viewport = page.viewportSize();
  assert.ok(
    viewport &&
      cropBox.x >= 0 &&
      cropBox.y >= 0 &&
      cropBox.x + cropBox.width <= viewport.width &&
      cropBox.y + cropBox.height <= viewport.height,
    `${label}: logo crop was not scrolled fully into the viewport`,
  );
  const actualLogo = await crop.evaluate((canvas, hex) => {
    const match = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!match) return undefined;
    const [red, green, blue] = [
      Number.parseInt(match[1].slice(0, 2), 16),
      Number.parseInt(match[1].slice(2, 4), 16),
      Number.parseInt(match[1].slice(4, 6), 16),
    ];
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return undefined;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const index = (y * canvas.width + x) * 4;
        if (
          Math.abs(data[index] - red) <= 2 &&
          Math.abs(data[index + 1] - green) <= 2 &&
          Math.abs(data[index + 2] - blue) <= 2
        ) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    return maxX < 0
      ? undefined
      : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }, logo.color);
  assert.ok(actualLogo, `${label}: ${logo.color} pixels are absent from the cropped QR canvas`);

  // `region` documents the fixture's source geometry and scales the redraw
  // offset; actualLogo above is authoritative when quiet-zone padding exists.
  const offsetX = (offsets.x || 0) * cropBox.width / region.width;
  const offsetY = (offsets.y || 0) * cropBox.height / region.height;
  const start = {
    x: cropBox.x + cropBox.width * actualLogo.x / (await crop.evaluate((canvas) => canvas.width)) + offsetX,
    y: cropBox.y + cropBox.height * actualLogo.y / (await crop.evaluate((canvas) => canvas.height)) + offsetY,
  };
  const end = {
    x: start.x + cropBox.width * actualLogo.width / (await crop.evaluate((canvas) => canvas.width)),
    y: start.y + cropBox.height * actualLogo.height / (await crop.evaluate((canvas) => canvas.height)),
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await page.getByText("Kept logo", { exact: true }).last().waitFor();
}

async function assertKeepLogoControl(page, label) {
  const keepLogo = page.getByRole("checkbox", { name: /Keep (?:my|original) logo/i });
  assert.equal(await keepLogo.count(), 1, `${label}: Keep original logo control is missing`);
  assert.equal(await keepLogo.isVisible(), true, `${label}: Keep original logo must be visible outside Advanced`);
  const advanced = page.locator("summary").filter({ hasText: ADVANCED_OPTIONS_SUMMARY })
    .first().locator("xpath=..");
  assert.equal(await advanced.evaluate((element) => element.open), false,
    `${label}: Advanced options should remain collapsed while selecting a logo`);
  return keepLogo;
}

async function assertLogoWidthInvalidatesApply(page, apply, label) {
  await setDisclosure(page, "Enter logo coordinates (%)", true);
  const numericFields = page.locator('input[type="number"]:visible');
  const descriptors = await numericFields.evaluateAll((elements) => elements.map((element) => {
    const input = element;
    const labels = input.labels ? [...input.labels].map((label) => label.textContent || "") : [];
    return [
      input.getAttribute("aria-label") || "",
      input.id || "",
      ...labels,
    ].join(" ");
  }));
  const widthIndex = descriptors.findIndex((text) => /(?:logo|protected).*width|width.*(?:logo|protected)/i.test(text));
  assert.notEqual(
    widthIndex,
    -1,
    `${label}: visible numeric logo width percentage field is missing`,
  );
  const widthField = numericFields.nth(widthIndex);
  assert.equal(await widthField.isVisible(), true, `${label}: logo width field is not visible`);
  const validValue = await widthField.inputValue();
  await widthField.fill("101");
  assert.equal(
    await apply.isDisabled(),
    true,
    `${label}: an out-of-bounds logo width must invalidate Apply`,
  );
  await widthField.fill(validValue);
  await setDisclosure(page, "Enter logo coordinates (%)", false);
}

async function unqueueDetectedDrafts(page) {
  const detectedQueue = page.getByRole("checkbox", {
    name: /Include QR code \d+ when applying fixes/i,
  });
  for (let index = 0; index < await detectedQueue.count(); index += 1) {
    const checkbox = detectedQueue.nth(index);
    if (await checkbox.isChecked()) await checkbox.uncheck();
  }
}

async function addManualDraftFromFixture(page, fixture, label) {
  await setDisclosure(page, "Show QR on artwork", true);
  const art = page.getByRole("application", { name: /Artwork region selector/ }).first();
  const box = await art.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, `${label}: artwork selector is not visible`);
  const start = {
    x: box.x + box.width * fixture.regions[0].x / ART_WIDTH,
    y: box.y + box.height * fixture.regions[0].y / ART_HEIGHT,
  };
  const end = {
    x: box.x + box.width * (fixture.regions[0].x + fixture.regions[0].width) / ART_WIDTH,
    y: box.y + box.height * (fixture.regions[0].y + fixture.regions[0].height) / ART_HEIGHT,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();

  await setDisclosure(page, "Select a QR manually", true);
  await setDisclosure(page, "Enter box coordinates instead", true);
  for (const field of ["x", "y", "width", "height"]) {
    await page.getByLabel(`Manual region ${field} in source pixels`).fill(
      String(fixture.regions[0][field]),
    );
  }
  await page.getByLabel("Manual recovery exact payload").fill(PAYLOAD);
  await page.getByRole("button", {
    name: "Add manual QR recovery candidate to repair queue",
    exact: true,
  }).click();
  await page.getByRole("button", { name: "Edit manual recovery", exact: true }).waitFor();
}

async function logoSelectionStyle(page) {
  const selector = page.getByRole("application", {
    name: /Logo region selector\. Draw or redraw a rectangle around the logo\./i,
  }).first();
  const overlay = selector.locator('div[aria-hidden="true"]').last();
  assert.equal(await overlay.count(), 1, "logo selection overlay is missing");
  return overlay.getAttribute("style");
}

async function waitForLogoRecognition(page, brand) {
  await page.getByText(
    new RegExp(`^(?:Detected|Recognized) ${brand}\\.`),
    { exact: false },
  ).waitFor({ timeout: 30_000 });
}

async function runKeepOriginalLogoAutoLocateScenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // Hold one real recognition call to exercise cancellation deterministically.
  // Its actual pixel matcher still runs after release; no result is mocked.
  await page.route(/\/src\/builders\/spot-uv\/lib\/popular-qr-logos\.ts(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const delayed = original.replace(
      /(async function detectPopularQRLogo\([^)]*\)\s*\{)/,
      "$1\nif (globalThis.__holdLogoSearch) { globalThis.__holdLogoSearch = false; await new Promise(resolve => { globalThis.__releaseLogoSearch = resolve; }); }",
    );
    assert.notEqual(delayed, original, "recognition test delay was not installed");
    await route.fulfill({ response, body: delayed });
  });
  const serverQRRequests = [];
  page.on("request", (request) => {
    if (/\/api\/detect-qr(?:\?|$)/.test(request.url())) serverQRRequests.push(request.url());
  });

  try {
    await page.goto(baseURL);
    await page.locator("input[type=file]").setInputFiles(popularLogoFixture);
    await page.getByRole("button", { name: /QR Repair Studio/ }).waitFor({ timeout: 30_000 });
    const originalDownload = await downloadPrintPdf(page, "keep-original auto-locate before repair");
    const originalDecoded = await decodeDownloadedPdf(
      originalDownload,
      "keep-original auto-locate before repair",
    );
    assert.ok(originalDecoded.payloads.includes(PAYLOAD), "known logo fixture did not decode before repair");

    await waitForStableScan(page);
    assert.deepEqual(serverQRRequests, [], "Keep original logo recognition must stay local");
    await unqueueDetectedDrafts(page);
    await addManualDraftFromFixture(page, popularLogoFixture, "known manual-logo draft");

    const keepOriginal = page.getByRole("checkbox", { name: /Keep (?:my|original) logo/i });
    assert.equal(await keepOriginal.isChecked(), false, "manual recovery starts without logo protection");
    await page.evaluate(() => { globalThis.__holdLogoSearch = true; });
    await keepOriginal.check();
    await page.getByText(/^(?:Looking for a logo…|Checking the source logo…|Checking logo…)/, {
      exact: false,
    }).waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => typeof globalThis.__releaseLogoSearch === "function");
    // Cancel this first pending request immediately, then switch code and
    // close/reopen the studio. A late result must not mutate the deselected
    // manual draft.
    await keepOriginal.uncheck();
    assert.equal(await keepOriginal.isChecked(), false, "Keep original logo did not turn off while pending");
    await page.getByRole("button", { name: "Edit detected QR code 2", exact: true }).click();
    await page.getByRole("button", { name: "Cancel QR repair studio", exact: true }).click();
    await waitForStableScan(page);
    // Closing cancels unsaved manual drafts. Recreate the same selection to
    // ensure the old request cannot attach even to equivalent source bounds.
    await unqueueDetectedDrafts(page);
    await addManualDraftFromFixture(page, popularLogoFixture, "reopened manual-logo draft");
    await page.evaluate(() => {
      globalThis.__holdLogoSearch = false;
      globalThis.__releaseLogoSearch();
    });
    assert.equal(await keepOriginal.isChecked(), false, "stale recognition applied after close/reopen");
    assert.equal(
      await page.getByText(/^(?:Detected|Recognized) Instagram\./, { exact: false }).count(),
      0,
      "stale recognition text survived deselection and close/reopen",
    );
    assert.equal(await page.getByText("Kept logo", { exact: true }).count(), 0,
      "stale recognition drew a late logo region after deselection");

    await keepOriginal.check();
    await waitForLogoRecognition(page, "Instagram");
    assert.equal(await keepOriginal.isChecked(), true, "Keep original logo did not stay checked");
    assert.ok(await page.getByText("Kept logo", { exact: true }).count() >= 1,
      "strong logo match did not draw a normalized protected area");
    const replacement = page.getByRole("combobox", { name: "Logo replacement", exact: true });
    assert.equal(await replacement.count(), 1, "strong logo match did not expose the replacement choice");
    assert.match(await replacement.innerText(), /Keep original/i, "auto-locate must keep the original replacement");
    assert.equal(
      await page.getByRole("button", { name: "Apply verified QR repairs", exact: true }).isDisabled(),
      true,
      "auto-locate must not auto-preview or save a manual draft",
    );
    assert.equal(
      await page.getByText(/Matches the original exactly|Payload matches exactly/, { exact: false }).count(),
      0,
      "auto-locate unexpectedly created a preview result",
    );

    // A user rectangle is authoritative. Turning protection off and on again
    // must not replace that rectangle with a fresh automatic suggestion.
    await drawLogoSelection(
      page,
      popularLogoFixture.logos[0],
      popularLogoFixture.regions[0],
      "known manual-logo override",
      { x: 16, y: 8 },
    );
    const manualOverrideStyle = await logoSelectionStyle(page);
    await keepOriginal.uncheck();
    assert.equal(await keepOriginal.isChecked(), false, "Keep original logo did not turn off");
    await keepOriginal.check();
    assert.equal(await page.getByText("Looking for a logo…", { exact: true }).count(), 0,
      "an existing manual rectangle should not trigger a new search");
    assert.equal(
      await logoSelectionStyle(page),
      manualOverrideStyle,
      "existing manual logo rectangle was overridden after Keep original off/on",
    );

    // Re-enable protection and use a deliberate exact rectangle for the
    // applied preservation assertion. Replacement remains Keep original.
    await drawLogoSelection(
      page,
      popularLogoFixture.logos[0],
      popularLogoFixture.regions[0],
      "known manual-logo final region",
    );
    assert.match(await replacement.innerText(), /Keep original/i);
    await verifySelected(page);
    const apply = page.getByRole("button", { name: "Apply verified QR repairs", exact: true });
    assert.equal(await apply.isDisabled(), false, "manually previewed protected logo should enable Apply");
    await apply.click();
    await page.getByText("QR repairs applied", { exact: true }).waitFor({ timeout: 30_000 });
    const repairedDownload = await downloadPrintPdf(page, "keep-original auto-locate after repair");
    const repairedDecoded = await decodeDownloadedPdf(
      repairedDownload,
      "keep-original auto-locate after repair",
    );
    assert.ok(repairedDecoded.payloads.includes(PAYLOAD), "protected logo repair lost the QR payload");
    // A curated glyph occupies only part of its white badge. Measure the
    // original ink, not the outer badge rectangle used by solid-mark fixtures.
    const originalInk = nearestLogoImage(
      originalDownload, popularLogoFixture.logos[0], "original preserved glyph",
    ).normalized;
    assertLogoPdfPreserved(
      originalDownload,
      repairedDownload,
      {
        ...popularLogoFixture.logos[0],
        x: originalInk.x * ART_WIDTH,
        y: originalInk.y * ART_HEIGHT,
        width: originalInk.width * ART_WIDTH,
        height: originalInk.height * ART_HEIGHT,
      },
      "Keep original logo PDF preservation",
    );

    // An unknown square mark remains a manual fallback. Auto-locate may
    // explain that no supported brand matched, but must not invent a region.
    const unknownPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const unknownRequests = [];
    unknownPage.on("request", (request) => {
      if (/\/api\/detect-qr(?:\?|$)/.test(request.url())) unknownRequests.push(request.url());
    });
    try {
      await unknownPage.goto(baseURL);
      await unknownPage.locator("input[type=file]").setInputFiles(logoFixture);
      await unknownPage.getByRole("button", { name: /QR Repair Studio/ }).waitFor({ timeout: 30_000 });
      await waitForStableScan(unknownPage);
      await unqueueDetectedDrafts(unknownPage);
      await addManualDraftFromFixture(unknownPage, logoFixture, "unknown manual-logo draft");
      const unknownKeep = unknownPage.getByRole("checkbox", { name: /Keep (?:my|original) logo/i });
      await unknownKeep.check();
      await unknownPage.getByText(
        /^(?:No reliable logo area found|No logo match found|No supported brand found|Logo is uncertain)/,
        { exact: false },
      ).waitFor({ timeout: 30_000 });
      assert.equal(
        await unknownPage.getByRole("combobox", { name: "Logo replacement", exact: true }).count(),
        0,
        "unknown logo unexpectedly received a replacement choice without a region",
      );
      assert.equal(
        await unknownPage.getByText("Kept logo", { exact: true }).count(),
        0,
        "unknown logo unexpectedly received an automatic region",
      );
      assert.equal(
        await unknownPage.getByRole("application", { name: /Logo region selector/ }).count(),
        1,
        "unknown logo did not retain the manual rectangle fallback",
      );
      await drawLogoSelection(
        unknownPage,
        logoFixture.logos[0],
        logoFixture.regions[0],
        "unknown manual fallback",
      );
      assert.ok(
        await unknownPage.getByText("Kept logo", { exact: true }).count() >= 1,
        "unknown logo manual fallback did not accept the user rectangle",
      );
      assert.deepEqual(unknownRequests, [], "unknown logo recognition must stay local");
    } finally {
      await unknownPage.close();
    }
    assert.deepEqual(serverQRRequests, [], "Keep original logo scenario must not call server QR detection");
    console.log(
      "Keep original logo scenario: bounded auto-locate, preserve-original/manual preview, unknown fallback, stale invalidation, and PDF payload/logo preservation passed",
    );
  } finally {
    await page.close();
  }
}

async function runLogoPreservationScenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const serverQRRequests = [];
  page.on("request", (request) => {
    if (/\/api\/detect-qr(?:\?|$)/.test(request.url())) serverQRRequests.push(request.url());
  });

  try {
    await page.goto(baseURL);
    await page.locator("input[type=file]").setInputFiles(logoFixture);
    await page.getByRole("button", { name: /QR Repair Studio/ }).waitFor({ timeout: 30_000 });

    const originalDownload = await downloadPrintPdf(page, "logo fixture before repair");
    const originalDecoded = await decodeDownloadedPdf(originalDownload, "logo fixture before repair");
    assert.ok(originalDecoded.payloads.includes(PAYLOAD), "logo fixture before repair did not decode the QR payload");
    for (const logo of logoFixture.logos) {
      nearestLogoImage(originalDownload, logo, "logo fixture before repair");
    }

    await waitForStableScan(page);
    assert.deepEqual(serverQRRequests, [], "logo preservation must use local QR detection");
    await assertSimpleModal(page, "logo preservation");

    // The center-logo QR proves the compact, top-level toggle and the real
    // cropped-QR drag path. A second drag must invalidate a prior preview.
    const firstKeepLogo = await assertKeepLogoControl(page, "center logo");
    await firstKeepLogo.check();
    await drawLogoSelection(page, logoFixture.logos[0], logoFixture.regions[0], "center logo");
    await verifySelected(page);
    const apply = page.getByRole("button", { name: "Apply verified QR repairs", exact: true });
    assert.equal(await apply.isDisabled(), false, "verified center-logo repair should enable Apply");
    await assertLogoWidthInvalidatesApply(page, apply, "center logo");

    const centerLogo = logoFixture.logos[0];
    const centerRegion = logoFixture.regions[0];
    await drawLogoSelection(
      page,
      centerLogo,
      centerRegion,
      "center-logo redraw",
      { x: 16, y: 8 },
    );
    assert.equal(await apply.isDisabled(), true, "redrawing the logo region must invalidate Apply");
    await drawLogoSelection(page, centerLogo, centerRegion, "center-logo final selection");
    await verifySelected(page);
    await page.setViewportSize({ width: 320, height: 740 });
    const logoSelector = page.getByRole("application", { name: /Logo region selector/ });
    await logoSelector.scrollIntoViewIfNeeded();
    for (const name of ["Preview fix and verify QR repair", "Cancel QR repair studio", "Apply verified QR repairs"]) {
      const bounds = await page.getByRole("button", { name, exact: true }).boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 &&
        bounds.x + bounds.width <= 320 && bounds.y + bounds.height <= 740,
      `320px mobile action is clipped: ${name} ${JSON.stringify(bounds)}`);
    }
    await page.screenshot({ path: "/tmp/qr-logo-mobile.png" });
    await page.setViewportSize({ width: 1280, height: 900 });

    // Exercise the same interaction on a noncentral logo. Its rectangle is
    // adjacent to (but does not overlap) any finder pattern, so preserving it
    // proves that the UI is not secretly restricted to a centered logo.
    await page.getByRole("checkbox", { name: /QR code 2/i }).check();
    await page.getByRole("button", { name: "Edit detected QR code 2", exact: true }).click();
    const secondKeepLogo = await assertKeepLogoControl(page, "corner logo");
    await secondKeepLogo.check();
    await drawLogoSelection(page, logoFixture.logos[1], logoFixture.regions[1], "corner logo");
    await verifySelected(page);
    assert.equal(await apply.isDisabled(), false, "verified corner-logo repair should enable Apply");
    await page.screenshot({ path: "/tmp/qr-logo-desktop.png" });

    await apply.click();
    await page.getByText("QR repairs applied", { exact: true }).waitFor({ timeout: 30_000 });
    const repairedDownload = await downloadPrintPdf(page, "logo fixture after repair");
    const repairedDecoded = await decodeDownloadedPdf(repairedDownload, "logo fixture after repair");
    assert.ok(repairedDecoded.payloads.includes(PAYLOAD), "logo repair PDF did not decode the QR payload");
    assertLogoPdfPreserved(originalDownload, repairedDownload, logoFixture.logos[0], "center logo");
    assertLogoPdfPreserved(originalDownload, repairedDownload, logoFixture.logos[1], "corner logo");
    console.log("logo preservation scenario: top-level toggle, cropped-QR draw/redraw invalidation, two logo positions, and PDF pixels passed");
  } finally {
    await page.close();
  }
}

async function runPopularLogoScenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const serverQRRequests = [];
  page.on("request", (request) => {
    if (/\/api\/detect-qr(?:\?|$)/.test(request.url())) serverQRRequests.push(request.url());
  });

  try {
    await page.goto(baseURL);
    await page.locator("input[type=file]").setInputFiles(popularLogoFixture);
    await page.getByRole("button", { name: /QR Repair Studio/ }).waitFor({ timeout: 30_000 });

    const originalDownload = await downloadPrintPdf(page, "popular-logo fixture before repair");
    const originalDecoded = await decodeDownloadedPdf(originalDownload, "popular-logo fixture before repair");
    assert.ok(
      originalDecoded.payloads.includes(PAYLOAD),
      "popular-logo fixture before repair did not decode the QR payload",
    );
    for (const logo of popularLogoFixture.logos) {
      nearestLogoImage(originalDownload, logo, `popular-logo fixture before repair (${logo.id})`);
    }

    await waitForStableScan(page);
    assert.deepEqual(serverQRRequests, [], "popular-logo recognition must use local QR detection");
    await assertSimpleModal(page, "popular-logo replacement");

    // Recognition is based on the actual Simple Icons-backed pixels in the
    // uploaded source. It should fill the protected region and replacement
    // choice without changing the editor image.
    await page.getByText(/^(?:Detected|Recognized) Instagram\./, { exact: false }).waitFor({ timeout: 30_000 });
    const keepLogo = page.getByRole("checkbox", { name: /Keep (?:my|original) logo/i });
    assert.equal(await keepLogo.isChecked(), true, "recognized Instagram logo should enable Keep original logo");
    assert.equal(
      await page.getByRole("application", { name: /Logo region selector/ }).count(),
      1,
      "recognized Instagram logo should expose its protected region",
    );
    const replacement = page.getByRole("combobox", { name: "Logo replacement", exact: true });
    assert.equal(await replacement.count(), 1, "recognized logo should expose the replacement choice");
    assert.match(await replacement.innerText(), /Instagram/, "recognition should choose the matching brand");

    await verifySelected(page);
    const apply = page.getByRole("button", { name: "Apply verified QR repairs", exact: true });
    assert.equal(await apply.isDisabled(), false, "recognized popular-logo preview should be ready to apply");

    // Preview is deliberately not an edit: closing the studio without Apply
    // must leave the downloaded artwork byte-for-byte unchanged.
    await page.getByRole("button", { name: "Cancel QR repair studio", exact: true }).click();
    const previewOnlyDownload = await downloadPrintPdf(page, "popular-logo fixture after preview only");
    const previewOnlyDecoded = await decodeDownloadedPdf(
      previewOnlyDownload,
      "popular-logo fixture after preview only",
    );
    assert.equal(
      previewOnlyDecoded.pixelFingerprint,
      originalDecoded.pixelFingerprint,
      "popular-logo Preview changed artwork before Apply",
    );

    // Reopen the unchanged source and deliberately switch while an explicit
    // recognition request is in flight. The stale first result must not
    // overwrite the selected second QR's Facebook recognition.
    await waitForStableScan(page);
    await page.getByText(/^(?:Detected|Recognized) Instagram\./, { exact: false }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Check logo", exact: true }).click();
    await page.getByRole("button", { name: "Edit detected QR code 2", exact: true }).click();
    await page.getByText(/^(?:Detected|Recognized) Facebook\./, { exact: false }).waitFor({ timeout: 30_000 });
    assert.equal(
      await page.getByText(/^(?:Detected|Recognized) Instagram\./, { exact: false }).count(),
      0,
      "a stale first-logo result leaked into the selected second QR",
    );

    await page.getByRole("button", { name: "Edit detected QR code 1", exact: true }).click();
    await page.getByText(/^(?:Detected|Recognized) Instagram\./, { exact: false }).waitFor({ timeout: 30_000 });
    const restore = page.getByRole("button", { name: "Restore original", exact: true });
    assert.equal(await restore.count(), 1, "recognized replacement should offer Restore original");
    await restore.click();
    await page.getByText(/^(?:Detected|Recognized) Instagram\. Original logo kept\.$/, { exact: true })
      .waitFor({ timeout: 30_000 });
    assert.equal(await apply.isDisabled(), true, "Restore original must invalidate the previous preview");
    await page.waitForTimeout(400);
    assert.equal(
      await page.getByText("Checking logo…", { exact: true }).count(),
      0,
      "Restore original started a recognition resuggestion loop",
    );

    // The manual choice is explicit and independent of the auto-recognized
    // source. YouTube is rendered by the same genuine Simple Icons module as
    // the fixture, then verified before it can be applied.
    await replacement.click();
    await page.getByRole("option", { name: "YouTube", exact: true }).click();
    await page.getByText(/^(?:Detected|Recognized) Instagram\. Replacement: YouTube\.$/, { exact: true })
      .waitFor({ timeout: 30_000 });
    assert.equal(await apply.isDisabled(), true, "manual logo choice must require a fresh preview");
    await verifySelected(page);
    assert.equal(await apply.isDisabled(), false, "verified manual YouTube replacement should enable Apply");
    await page.screenshot({ path: "/tmp/popular-logo-replacement.png" });

    await apply.click();
    await page.getByText("QR repairs applied", { exact: true }).waitFor({ timeout: 30_000 });
    const repairedDownload = await downloadPrintPdf(page, "popular-logo fixture after YouTube replacement");
    const repairedDecoded = await decodeDownloadedPdf(
      repairedDownload,
      "popular-logo fixture after YouTube replacement",
    );
    assert.ok(
      repairedDecoded.payloads.includes(PAYLOAD),
      "popular-logo replacement PDF did not decode the original payload",
    );
    const firstLogo = popularLogoFixture.logos[0];
    const secondLogo = popularLogoFixture.logos[1];
    const youtube = popularLogoModule.POPULAR_QR_LOGOS.find((logo) => logo.id === "youtube");
    assert.ok(youtube, "popular logo metadata is missing YouTube");
    nearestLogoImage(
      repairedDownload,
      { ...firstLogo, color: youtube.color },
      "applied YouTube replacement",
    );
    nearestLogoImage(repairedDownload, secondLogo, "unselected Facebook source logo");

    // The pre-existing square marks are intentionally not one of the curated
    // templates. Check-logo must report an unknown/unsupported brand rather
    // than proposing a replacement.
    const unknownPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const unknownRequests = [];
    unknownPage.on("request", (request) => {
      if (/\/api\/detect-qr(?:\?|$)/.test(request.url())) unknownRequests.push(request.url());
    });
    try {
      await unknownPage.goto(baseURL);
      await unknownPage.locator("input[type=file]").setInputFiles(logoFixture);
      await unknownPage.getByRole("button", { name: /QR Repair Studio/ }).waitFor({ timeout: 30_000 });
      await waitForStableScan(unknownPage);
      const unknownKeep = await assertKeepLogoControl(unknownPage, "unknown square logo");
      await unknownKeep.check();
      await drawLogoSelection(
        unknownPage,
        logoFixture.logos[0],
        logoFixture.regions[0],
        "unknown square logo",
      );
      await unknownPage.getByRole("button", { name: "Check logo", exact: true }).click();
      await unknownPage.getByText(
        /^(?:No supported brand found\. Keep the original or choose a brand manually\.|No logo match found\. Keep the original or choose a replacement manually\.|Logo is uncertain\. Keep the original or choose a brand only if you know it\.|Logo is uncertain\. Keep the original or choose a replacement only if you know it\.)$/,
      ).waitFor({ timeout: 30_000 });
      assert.equal(
        await unknownPage.getByText(/^(?:Detected|Recognized) (?:Instagram|Facebook|WhatsApp|YouTube)\./, { exact: false }).count(),
        0,
        "an unknown square logo was auto-recognized as a popular brand",
      );
      assert.deepEqual(unknownRequests, [], "unknown-logo recognition must stay local");
    } finally {
      await unknownPage.close();
    }

    console.log(
      "popular logo scenario: authentic Simple Icons recognition, preview-only behavior, stale-result guard, restore/manual choice, unknown logo handling, PDF pixels, and payload passed",
    );
  } finally {
    await page.close();
  }
}

async function runRepairScenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const serverQRRequests = [];
  page.on("request", (request) => {
    if (/\/api\/detect-qr(?:\?|$)/.test(request.url())) serverQRRequests.push(request.url());
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await page.goto(baseURL);
    await page.locator("input[type=file]").setInputFiles(fixture);
    await page.getByRole("button", { name: /QR Repair Studio/ }).waitFor({ timeout: 30_000 });
    await waitForStableScan(page);

    assert.deepEqual(serverQRRequests, [], "normal QR detection must remain local; no server scan request is allowed");
    assert.equal(await page.getByText("QR code 1", { exact: true }).count(), 1);
    assert.equal(await page.getByText("QR code 2", { exact: true }).count(), 1);
    await assertSimpleModal(page, "desktop");
    await assertPrimaryButtonBounds(page, "desktop default modal");

    // Capture the default modal before Advanced is opened and verify that the
    // compact flow keeps all primary actions inside the viewport.
    await page.screenshot({ path: "/tmp/simple-qr-default-desktop.png", fullPage: true });
    await page.screenshot({ path: "/tmp/simple-qr-before.png", fullPage: true });
    await page.setViewportSize({ width: 320, height: 740 });
    await assertSimpleModal(page, "320px mobile default modal");
    await assertPrimaryButtonBounds(page, "320px mobile default modal");
    await page.screenshot({ path: "/tmp/simple-qr-default-mobile-320.png", fullPage: true });
    await page.screenshot({ path: "/tmp/simple-qr-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Cancel QR repair studio", exact: true }).click();

    const originalDownload = await downloadPrintPdf(page, "before repair");
    const originalDecoded = await decodeDownloadedPdf(originalDownload, "before repair");
    assert.ok(originalDecoded.payloads.includes(PAYLOAD), "original PNG did not decode the QR payload");
    assert.ok(originalDecoded.hasDarkNavy && originalDecoded.hasCream, "original PNG lost the fixture's colored QR pixels");
    await waitForStableScan(page);

    // The ordinary three-step path is usable with Advanced still collapsed:
    // choose the first code, preview the fix, then inspect its safety status.
    await verifySelected(page);

    // Color, ECC, and quiet-zone behavior remain covered, but are deliberately
    // exercised only after opening the technical options disclosure.
    await setDisclosure(page, ADVANCED_OPTIONS_SUMMARY, true);
    await assertPayloadReadOnly(page);

    // Color edits need a fresh scan, not a false failure from a contrast rule.
    await page.getByLabel("Foreground color value").fill("#777777");
    await page.getByLabel("Background color value").fill("#ffffff");
    assert.equal(
      await page.getByRole("button", { name: "Apply verified QR repairs", exact: true }).isDisabled(),
      true,
      "edited colors must invalidate the old scan",
    );
    await verifySelected(page);
    await page.getByText("Low contrast — a print warning, not a failed scan.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Apply verified QR repairs", exact: true }).isDisabled(), false,
      "an exact, print-size readable code must not fail solely for contrast below 4.5");
    assert.equal(await page.getByLabel("Foreground color value").inputValue(), "#777777",
      "verification must never substitute the chosen color");

    // Exercise the safe suggestion, then intentionally match the sampled
    // source colors for the final repair.
    await page.getByRole("button", { name: "Suggest safe similar QR colors", exact: true }).click();
    const suggestedDark = await page.getByLabel("Foreground color value").inputValue();
    const suggestedLight = await page.getByLabel("Background color value").inputValue();
    assert.notEqual(suggestedDark.toLowerCase(), "#777777");
    assert.notEqual(suggestedLight.toLowerCase(), "#999999");
    await page.getByRole("button", { name: "Match original QR colors", exact: true }).click();
    assert.equal((await page.getByLabel("Foreground color value").inputValue()).toLowerCase(), DARK);
    assert.equal((await page.getByLabel("Background color value").inputValue()).toLowerCase(), LIGHT);

    // ECC and quiet zone are real controls, not decorative fields.
    await page.getByRole("combobox", { name: "Error correction level" }).click();
    await page.getByRole("option", { name: /H — 30% recovery/ }).click();
    await page.getByLabel("Quiet zone modules, from 4 to 8").fill("6");
    await verifySelected(page);

    // Queue the second code, keep equal payloads as two distinct repair
    // candidates, and verify it independently.
    const secondQueue = page.getByRole("checkbox", { name: /QR code 2/i });
    assert.equal(await secondQueue.count(), 1, "second QR code queue checkbox is missing");
    await secondQueue.check();
    await page.getByRole("button", { name: "Edit detected QR code 2", exact: true }).click();
    await assertPayloadReadOnly(page);
    await verifySelected(page);
    assert.equal(
      await page.getByRole("button", { name: "Apply verified QR repairs", exact: true }).isDisabled(),
      false,
      "two independently verified codes should enable multi-code Apply",
    );

    await page.screenshot({ path: "/tmp/simple-qr-before-apply.png", fullPage: true });
    await page.getByRole("button", { name: "Apply verified QR repairs", exact: true }).click();
    await page.getByText("QR repairs applied", { exact: true }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /QR Repair Studio/ }).waitFor();

    const repairedDownload = await downloadPrintPdf(page, "after repair");
    const repairedDecoded = await decodeDownloadedPdf(repairedDownload, "after repair");
    assert.ok(repairedDecoded.payloads.includes(PAYLOAD), "repaired print PNG did not exactly decode the QR payload");
    assert.ok(repairedDecoded.hasDarkNavy && repairedDecoded.hasCream,
      "repaired print PNG lost colored foreground/background");
    assert.notEqual(repairedDecoded.pixelFingerprint, originalDecoded.pixelFingerprint,
      "Apply did not change editor pixels");

    // A repaired image must not route through the former black/white overlay
    // path. The local detector may legitimately repopulate QR metadata after
    // the real pixel edit, so assert against the actual embedded print raster
    // rather than treating a toolbar count as overlay state.
    assert.equal(
      repairedDecoded.hasPureBlackOrWhite,
      false,
      "old black/white QR overlay pixels survived Apply",
    );

    // The modal can be reopened against the repaired image and is still a
    // real QR Repair Studio rather than an unmounted/blank overlay.
    await page.getByRole("button", { name: /QR Repair Studio/ }).click();
    await page.getByRole("heading", { name: "Fix QR code", exact: true }).waitFor();
    await page.screenshot({ path: "/tmp/simple-qr-after.png", fullPage: true });
    await page.getByRole("button", { name: "Cancel QR repair studio", exact: true }).click();

    // Undo must restore the original pixels and Redo must restore the repair.
    await page.getByTitle("Undo").click();
    await page.waitForTimeout(1_000);
    const undoneDownload = await downloadPrintPdf(page, "after Undo");
    const undoneDecoded = await decodeDownloadedPdf(undoneDownload, "after Undo");
    assert.equal(
      undoneDecoded.pixelFingerprint,
      originalDecoded.pixelFingerprint,
      "Undo did not restore the original embedded print pixels",
    );
    await page.getByTitle("Redo").click();
    await page.waitForTimeout(1_000);
    const redoneDownload = await downloadPrintPdf(page, "after Redo");
    const redoneDecoded = await decodeDownloadedPdf(redoneDownload, "after Redo");
    assert.equal(
      redoneDecoded.pixelFingerprint,
      repairedDecoded.pixelFingerprint,
      "Redo did not restore the repaired embedded print pixels",
    );

    assert.deepEqual(errors, [], "browser page errors during QR repair scenario");
    console.log("repair scenario: local two-code repair, real PNG decode, mobile modal, Undo/Redo passed");
  } finally {
    await page.close();
  }
}

async function runManualRecoveryScenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const serverQRRequests = [];
  page.on("request", (request) => {
    if (/\/api\/detect-qr(?:\?|$)/.test(request.url())) serverQRRequests.push(request.url());
  });
  try {
    await page.goto(baseURL);
    await page.locator("input[type=file]").setInputFiles(manualFixture);
    await page.getByRole("button", { name: /QR Repair Studio/ }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /QR Repair Studio/ }).click();
    await page.waitForFunction(() => document.body.textContent.includes("Scan complete"), undefined, { timeout: 30_000 });
    await setDisclosure(page, "More tools: scan again and diagnostics", true);
    await page.getByText(/No readable QR found/, { exact: false }).waitFor({ timeout: 30_000 });
    assert.equal(await page.getByText("QR code 1", { exact: true }).count(), 0,
      "manual blank fixture unexpectedly produced a detected QR");
    assert.deepEqual(serverQRRequests, [], "manual recovery must also use local QR detection");
    await setDisclosure(page, "More tools: scan again and diagnostics", false);

    const art = page.getByRole("application", { name: /Artwork region selector/ });
    const box = await art.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, "manual artwork selector is not visible");
    const start = {
      x: box.x + box.width * manualFixture.region.x / ART_WIDTH,
      y: box.y + box.height * manualFixture.region.y / ART_HEIGHT,
    };
    const end = {
      x: box.x + box.width * (manualFixture.region.x + manualFixture.region.width) / ART_WIDTH,
      y: box.y + box.height * (manualFixture.region.y + manualFixture.region.height) / ART_HEIGHT,
    };
    // First use the visible drag affordance, then commit the exact source
    // pixels through the numeric fields exposed for keyboard/pointer users.
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 4 });
    await page.mouse.up();
    await setDisclosure(page, "Select a QR manually", true);
    await setDisclosure(page, "Enter box coordinates instead", true);
    for (const field of ["x", "y", "width", "height"]) {
      await page.getByLabel(`Manual region ${field} in source pixels`).fill(
        String(manualFixture.region[field]),
      );
    }
    assert.equal(await page.getByLabel("Manual region width in source pixels").inputValue(), "480");
    assert.equal(await page.getByLabel("Manual region height in source pixels").inputValue(), "480");

    await page.getByLabel("Manual recovery exact payload").fill(PAYLOAD);
    await page.getByRole("button", { name: "Add manual QR recovery candidate to repair queue", exact: true }).click();
    await page.getByRole("button", { name: "Edit manual recovery", exact: true }).waitFor();
    const manualPayload = page.getByLabel("Manual QR payload");
    assert.equal(await manualPayload.inputValue(), PAYLOAD);
    assert.equal(await manualPayload.isEditable(), true, "manual payload must remain user-editable");

    await verifySelected(page);
    assert.equal(
      await page.getByRole("button", { name: "Apply verified QR repairs", exact: true }).isDisabled(),
      false,
      "verified manual recovery candidate should enable Apply",
    );
    await page.getByRole("button", { name: "Apply verified QR repairs", exact: true }).click();
    await page.getByText("QR repairs applied", { exact: true }).waitFor({ timeout: 30_000 });
    const repairedDownload = await downloadPrintPdf(page, "manual recovery after repair");
    const repairedDecoded = await decodeDownloadedPdf(repairedDownload, "manual recovery after repair");
    assert.ok(
      repairedDecoded.payloads.includes(PAYLOAD),
      "manual recovery print PDF did not decode the exact user-provided payload",
    );
    assert.ok(
      repairedDecoded.hasDarkNavy && repairedDecoded.hasCream,
      "manual recovery print PDF lost colored QR artwork",
    );
    console.log("manual recovery scenario: zero-code blank fixture, drag/numeric region, exact payload, and PDF decode passed");
  } finally {
    await page.close();
  }
}

async function runScanStatusScenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let workerStubRequests = 0;
  // Vite serves a small Worker constructor at ?worker and the actual worker
  // script at ?worker_file. Only replace the latter; replacing the wrapper
  // makes the application module fail before the upload control mounts.
  await page.route(/qr-detect-worker(?:\.ts|\.js)\?worker_file/, async (route) => {
    workerStubRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        self.onmessage = (event) => {
          if (event.data && event.data.deep) {
            self.postMessage({ type: "error", code: "timeout" });
          }
        };
      `,
    });
  });

  try {
    await page.goto(baseURL);
    await page.locator("input[type=file]").setInputFiles(fixture);
    await page.getByRole("button", { name: /QR Repair Studio/ }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /QR Repair Studio/ }).click();
    await page.getByRole("button", { name: "Cancel scan", exact: true }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Cancel scan", exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes("Scan cancelled"), undefined, { timeout: 30_000 });
    await setDisclosure(page, "More tools: scan again and diagnostics", true);
    await page.getByText(/Scan cancelled/, { exact: false }).waitFor();

    // Deep scan is an optional tool, so open its disclosure only for this
    // deadline-status contract.
    await page.getByRole("button", { name: "Deep scan", exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes("Scan error"), undefined, { timeout: 30_000 });
    await setDisclosure(page, "More tools: scan again and diagnostics", true);
    await page.getByText(/Scan error/, { exact: false }).waitFor({ timeout: 30_000 });
    await page.getByText(/Deep QR detection timed out after 20 seconds/, { exact: false }).waitFor({ timeout: 30_000 });
    assert.ok(workerStubRequests >= 2, "status scenario did not use the synthetic worker for normal and deep scans");
    console.log("scan status scenario: Cancel scan and Deep scan deadline status passed");
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ["--no-sandbox"],
});

const failures = [];
for (const [name, scenario] of [
  ["Keep original logo auto-locate", runKeepOriginalLogoAutoLocateScenario],
  ["logo preservation", runLogoPreservationScenario],
  ["popular logo replacement", runPopularLogoScenario],
  ["detected QR repair", runRepairScenario],
  ["manual recovery", runManualRecoveryScenario],
  ["scan status", runScanStatusScenario],
].filter(([name]) => !process.env.QR_STUDIO_SCENARIO || name === process.env.QR_STUDIO_SCENARIO)) {
  try {
    await scenario(browser);
  } catch (error) {
    failures.push({ name, error });
    // Keep the independent scenarios running so one functional failure does
    // not hide manual recovery or scan-status regressions.
    console.error(`qr-repair-studio-browser: ${name} FAIL`);
    console.error(error);
  }
}
await browser.close();
if (failures.length) {
  console.error(`qr-repair-studio-browser: FAIL (${failures.length} scenario${failures.length === 1 ? "" : "s"})`);
  process.exitCode = 1;
} else {
  console.log("qr-repair-studio-browser: PASS");
}