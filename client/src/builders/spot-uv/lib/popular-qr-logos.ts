/*
 * Conservative, local recognition of a very small curated logo set.
 *
 * The path data below is copied from the Simple Icons project:
 * https://github.com/simple-icons/simple-icons/tree/develop/icons
 * (the individual SVG files are CC0; Simple Icons documents that this
 * licence does not grant permission to use a trademark).  Keeping the paths
 * here makes both rendering and recognition deterministic and means that a
 * browser never downloads an image or sends artwork to a service.
 */

export type PopularQRLogoId = "instagram" | "facebook" | "whatsapp" | "youtube";

export interface PopularQRLogoMetadata {
  id: PopularQRLogoId;
  label: string;
  color: string;
}

export const POPULAR_QR_LOGOS: readonly PopularQRLogoMetadata[] = [
  { id: "instagram", label: "Instagram", color: "#E4405F" },
  { id: "facebook", label: "Facebook", color: "#1877F2" },
  { id: "whatsapp", label: "WhatsApp", color: "#25D366" },
  { id: "youtube", label: "YouTube", color: "#FF0000" },
] as const;

type PixelRect = { x: number; y: number; width: number; height: number };
type NormalizedRect = PixelRect;
type DrawContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const WHITE = "#FFFFFF";
const SVG_VIEWBOX = 24;
const MAX_ANALYSIS_EDGE = 256;
const MAX_CANDIDATES = 620;

/*
 * These are the original Simple Icons `d` attributes.  They are deliberately
 * not approximations or hand-drawn substitutes: changing them changes the
 * asset that is offered to the user and the template used by recognition.
 */
const PATHS: Record<PopularQRLogoId, string> = {
  instagram:
    "M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077Z",
  facebook:
    "M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z",
  whatsapp:
    "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z",
  youtube:
    "M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
};

function logoFor(id: PopularQRLogoId): PopularQRLogoMetadata {
  const logo = POPULAR_QR_LOGOS.find((item) => item.id === id);
  if (!logo) throw new Error(`Unsupported popular QR logo: ${String(id)}`);
  return logo;
}

function validRect(rect: PixelRect): boolean {
  return !!rect &&
    [rect.x, rect.y, rect.width, rect.height].every((value) => Number.isFinite(value)) &&
    rect.width > 0 && rect.height > 0;
}

function roundedRectPath(ctx: DrawContext, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/*
 * Path2D is present in browsers, but is not a global in the @napi-rs/canvas
 * test shim.  This small SVG-path fallback executes the same path data
 * directly on a 2D context, so tests and non-Path2D canvas implementations do
 * not need a native package.  It supports the SVG commands used by these
 * four upstream assets, including elliptical arcs.
 */
type PathToken = string;
const PATH_TOKEN_RE = /([a-zA-Z])|([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/gi;

function svgPathTokens(path: string): PathToken[] {
  const tokens: PathToken[] = [];
  for (const match of path.matchAll(PATH_TOKEN_RE)) tokens.push(match[1] ?? match[2]);
  return tokens;
}

function drawSvgPathFallback(ctx: DrawContext, path: string): void {
  // SVG arc flags may be compacted as `00` in upstream minified paths.  They
  // are two independent flags, not the number zero with two digits.
  const tokens = svgPathTokens(path).flatMap((token) => {
    if (/^0{2,}$/.test(token)) return token.split("");
    // The compact form `00.502` is the two arc flags followed by the
    // endpoint `0.502`.
    if (/^00\./.test(token)) return ["0", "0", token.slice(2)];
    return [token];
  });
  const arity: Record<string, number> = {
    m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0,
  };
  let index = 0;
  let command = "";
  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;
  let lastCubicX: number | undefined;
  let lastCubicY: number | undefined;
  let lastQuadraticX: number | undefined;
  let lastQuadraticY: number | undefined;
  let firstMove = true;

  const isCommand = (value: string): boolean => /^[a-zA-Z]$/.test(value);
  const number = (value: string): number => Number(value);
  const relative = (): boolean => command === command.toLowerCase();
  const point = (x: number, y: number): [number, number] => (
    relative() ? [currentX + x, currentY + y] : [x, y]
  );
  const resetReflections = (): void => {
    lastCubicX = lastCubicY = lastQuadraticX = lastQuadraticY = undefined;
  };

  while (index < tokens.length) {
    if (isCommand(tokens[index])) command = tokens[index++];
    if (!command) break;
    const lower = command.toLowerCase();
    if (lower === "z") {
      ctx.closePath();
      currentX = startX;
      currentY = startY;
      firstMove = true;
      resetReflections();
      command = "";
      continue;
    }
    const count = arity[lower];
    if (!count) break;
    if (index + count > tokens.length || tokens.slice(index, index + count).some(isCommand)) break;
    const values = tokens.slice(index, index + count).map(number);
    index += count;
    const isRelative = relative();

    if (lower === "m") {
      const [x, y] = point(values[0], values[1]);
      if (firstMove) {
        ctx.moveTo(x, y);
        startX = x;
        startY = y;
        firstMove = false;
      } else {
        ctx.lineTo(x, y);
      }
      currentX = x;
      currentY = y;
      resetReflections();
      command = isRelative ? "l" : "L";
      continue;
    }
    if (lower === "l") {
      const [x, y] = point(values[0], values[1]);
      ctx.lineTo(x, y);
      currentX = x;
      currentY = y;
      resetReflections();
      continue;
    }
    if (lower === "h") {
      const x = isRelative ? currentX + values[0] : values[0];
      ctx.lineTo(x, currentY);
      currentX = x;
      resetReflections();
      continue;
    }
    if (lower === "v") {
      const y = isRelative ? currentY + values[0] : values[0];
      ctx.lineTo(currentX, y);
      currentY = y;
      resetReflections();
      continue;
    }
    if (lower === "c") {
      const [x1, y1] = point(values[0], values[1]);
      const [x2, y2] = point(values[2], values[3]);
      const [x, y] = point(values[4], values[5]);
      ctx.bezierCurveTo(x1, y1, x2, y2, x, y);
      currentX = x;
      currentY = y;
      lastCubicX = x2;
      lastCubicY = y2;
      lastQuadraticX = lastQuadraticY = undefined;
      continue;
    }
    if (lower === "s") {
      const [x2, y2] = point(values[0], values[1]);
      const [x, y] = point(values[2], values[3]);
      const [x1, y1] = lastCubicX === undefined || lastCubicY === undefined
        ? [currentX, currentY]
        : [2 * currentX - lastCubicX, 2 * currentY - lastCubicY];
      ctx.bezierCurveTo(x1, y1, x2, y2, x, y);
      currentX = x;
      currentY = y;
      lastCubicX = x2;
      lastCubicY = y2;
      lastQuadraticX = lastQuadraticY = undefined;
      continue;
    }
    if (lower === "q") {
      const [x1, y1] = point(values[0], values[1]);
      const [x, y] = point(values[2], values[3]);
      ctx.quadraticCurveTo(x1, y1, x, y);
      currentX = x;
      currentY = y;
      lastQuadraticX = x1;
      lastQuadraticY = y1;
      lastCubicX = lastCubicY = undefined;
      continue;
    }
    if (lower === "t") {
      const [x, y] = point(values[0], values[1]);
      const [x1, y1] = lastQuadraticX === undefined || lastQuadraticY === undefined
        ? [currentX, currentY]
        : [2 * currentX - lastQuadraticX, 2 * currentY - lastQuadraticY];
      ctx.quadraticCurveTo(x1, y1, x, y);
      currentX = x;
      currentY = y;
      lastQuadraticX = x1;
      lastQuadraticY = y1;
      lastCubicX = lastCubicY = undefined;
      continue;
    }
    if (lower === "a") {
      const rx = Math.abs(values[0]);
      const ry = Math.abs(values[1]);
      const rotation = values[2] * Math.PI / 180;
      const largeArc = values[3] !== 0;
      const sweep = values[4] !== 0;
      const [x, y] = point(values[5], values[6]);
      if (!rx || !ry || (x === currentX && y === currentY)) {
        ctx.lineTo(x, y);
      } else if (typeof ctx.ellipse === "function") {
        const cosPhi = Math.cos(rotation);
        const sinPhi = Math.sin(rotation);
        const dx = (currentX - x) / 2;
        const dy = (currentY - y) / 2;
        const xPrime = cosPhi * dx + sinPhi * dy;
        const yPrime = -sinPhi * dx + cosPhi * dy;
        const scale = (xPrime * xPrime) / (rx * rx) + (yPrime * yPrime) / (ry * ry);
        const adjustedRx = scale > 1 ? rx * Math.sqrt(scale) : rx;
        const adjustedRy = scale > 1 ? ry * Math.sqrt(scale) : ry;
        const numerator = Math.max(0, adjustedRx * adjustedRx * adjustedRy * adjustedRy -
          adjustedRx * adjustedRx * yPrime * yPrime - adjustedRy * adjustedRy * xPrime * xPrime);
        const denominator = adjustedRx * adjustedRx * yPrime * yPrime +
          adjustedRy * adjustedRy * xPrime * xPrime;
        const factor = denominator === 0 ? 0 :
          (largeArc === sweep ? -1 : 1) * Math.sqrt(numerator / denominator);
        const cxPrime = factor * adjustedRx * yPrime / adjustedRy;
        const cyPrime = factor * -adjustedRy * xPrime / adjustedRx;
        const cx = cosPhi * cxPrime - sinPhi * cyPrime + (currentX + x) / 2;
        const cy = sinPhi * cxPrime + cosPhi * cyPrime + (currentY + y) / 2;
        const unitX = (xPrime - cxPrime) / adjustedRx;
        const unitY = (yPrime - cyPrime) / adjustedRy;
        const unitEndX = (-xPrime - cxPrime) / adjustedRx;
        const unitEndY = (-yPrime - cyPrime) / adjustedRy;
        const angle = (ux: number, uy: number): number => Math.atan2(uy, ux);
        let startAngle = angle(1, 0) - angle(unitX, unitY);
        let delta = angle(unitEndX, unitEndY) - angle(unitX, unitY);
        if (!sweep && delta > 0) delta -= Math.PI * 2;
        if (sweep && delta < 0) delta += Math.PI * 2;
        // A path's current point is already at the start of the arc.
        if ([cx, cy, adjustedRx, adjustedRy, startAngle, delta].every(Number.isFinite)) {
          ctx.ellipse(cx, cy, adjustedRx, adjustedRy, rotation, startAngle, startAngle + delta, !sweep);
        } else {
          ctx.lineTo(x, y);
        }
      } else {
        // All supported browser and test contexts expose ellipse.  This
        // branch is only a conservative fallback for very old contexts.
        ctx.lineTo(x, y);
      }
      currentX = x;
      currentY = y;
      resetReflections();
    }
  }
}

function fillIconPath(ctx: DrawContext, id: PopularQRLogoId): void {
  const path = PATHS[id];
  const PathCtor = (globalThis as typeof globalThis & {
    Path2D?: new (path?: string) => Path2D;
  }).Path2D;
  if (PathCtor) {
    try {
      ctx.fill(new PathCtor(path));
      return;
    } catch {
      // Fall through to the context-path implementation.
    }
  }
  ctx.beginPath();
  drawSvgPathFallback(ctx, path);
  // Simple Icons uses compound paths (the YouTube play mark is a hole in
  // the red field).  Even-odd matches that SVG representation in canvas
  // implementations whose non-zero arc winding differs from SVG's parser.
  ctx.fill("evenodd");
}

function fillIconAt(ctx: DrawContext, id: PopularQRLogoId, rect: PixelRect): void {
  ctx.save();
  ctx.translate(rect.x, rect.y);
  ctx.scale(rect.width / SVG_VIEWBOX, rect.height / SVG_VIEWBOX);
  fillIconPath(ctx, id);
  ctx.restore();
}

function paintLogoBadge(ctx: DrawContext, id: PopularQRLogoId, rect: PixelRect): void {
  const logo = logoFor(id);
  const side = Math.min(rect.width, rect.height);
  const badge: PixelRect = {
    x: rect.x + (rect.width - side) / 2,
    y: rect.y + (rect.height - side) / 2,
    width: side,
    height: side,
  };
  ctx.save();
  // Bound every canvas implementation to the approved logo slot, including
  // the SVG-path fallback used outside browsers.
  ctx.beginPath();
  ctx.rect(badge.x, badge.y, badge.width, badge.height);
  ctx.clip();
  // The upstream path remains the foreground asset in its documented brand
  // colour.  A white fitted field gives all four glyphs a consistent,
  // legible badge without altering their geometry (especially YouTube's
  // compound path).
  ctx.fillStyle = WHITE;
  roundedRectPath(ctx, badge.x, badge.y, badge.width, badge.height, badge.width * 0.18);
  ctx.fill();
  ctx.fillStyle = logo.color;
  // Leave a deliberate brand-colour field around the upstream glyph.  Apart
  // from making the four badges legible at QR size, that field is an
  // important anti-colour-only recognition cue.
  const inner = side * 0.64;
  fillIconAt(ctx, id, {
    x: badge.x + (side - inner) / 2,
    y: badge.y + (side - inner) / 2,
    width: inner,
    height: inner,
  });
  ctx.restore();
}

/**
 * Paints one of the four curated Simple Icons assets as a compact badge.
 * The badge is opaque only within the fitted square; the surrounding part of
 * an intentionally non-square destination remains untouched.
 */
export function renderPopularQRLogo(
  ctx: CanvasRenderingContext2D,
  id: PopularQRLogoId,
  rect: PixelRect,
): void {
  if (!ctx || typeof ctx.save !== "function") throw new Error("A 2D canvas context is required");
  if (!validRect(rect)) throw new Error("Popular QR logo rectangle must be finite and positive");
  logoFor(id);
  paintLogoBadge(ctx, id, rect);
}

interface SourceDimensions {
  width: number;
  height: number;
}

function sourceDimensions(source: HTMLImageElement | HTMLCanvasElement): SourceDimensions | null {
  if (!source || typeof source !== "object") return null;
  const candidate = source as HTMLImageElement & HTMLCanvasElement;
  const width = Number(candidate.naturalWidth || candidate.width);
  const height = Number(candidate.naturalHeight || candidate.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

function validPixelRegion(region: PixelRect, source: SourceDimensions): boolean {
  return validRect(region) &&
    region.x >= 0 && region.y >= 0 &&
    region.x + region.width <= source.width &&
    region.y + region.height <= source.height;
}

function validNormalizedRegion(region: NormalizedRect): boolean {
  return validRect(region) &&
    region.x >= 0 && region.y >= 0 &&
    region.x + region.width <= 1 && region.y + region.height <= 1;
}

function createScratchCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  const documentLike = (globalThis as typeof globalThis & {
    document?: { createElement(name: string): HTMLCanvasElement };
  }).document;
  if (documentLike) {
    const canvas = documentLike.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(width));
    canvas.height = Math.max(1, Math.ceil(height));
    return canvas;
  }
  const Offscreen = (globalThis as typeof globalThis & {
    OffscreenCanvas?: new (width: number, height: number) => OffscreenCanvas;
  }).OffscreenCanvas;
  if (Offscreen) return new Offscreen(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
  throw new Error("No local canvas implementation is available");
}

interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function rasterizeCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): Raster {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The local canvas has no 2D context");
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: image.data };
}

function buildTemplate(id: PopularQRLogoId): { badge: Raster; mask: Raster } {
  const badgeCanvas = createScratchCanvas(32, 32);
  const badgeContext = badgeCanvas.getContext("2d");
  if (!badgeContext) throw new Error("The local canvas has no 2D context");
  badgeContext.clearRect(0, 0, 32, 32);
  paintLogoBadge(badgeContext, id, { x: 0, y: 0, width: 32, height: 32 });

  const maskCanvas = createScratchCanvas(32, 32);
  const maskContext = maskCanvas.getContext("2d");
  if (!maskContext) throw new Error("The local canvas has no 2D context");
  maskContext.clearRect(0, 0, 32, 32);
  maskContext.fillStyle = "#000000";
  const inner = 32 * 0.64;
  fillIconAt(maskContext, id, {
    x: (32 - inner) / 2,
    y: (32 - inner) / 2,
    width: inner,
    height: inner,
  });
  return { badge: rasterizeCanvas(badgeCanvas), mask: rasterizeCanvas(maskCanvas) };
}

const templateCache = new Map<PopularQRLogoId, { badge: Raster; mask: Raster }>();

function templateFor(id: PopularQRLogoId): { badge: Raster; mask: Raster } {
  let template = templateCache.get(id);
  if (!template) {
    template = buildTemplate(id);
    templateCache.set(id, template);
  }
  return template;
}

interface AnalysisRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function pixelAt(raster: Raster, x: number, y: number): [number, number, number, number] {
  const px = Math.max(0, Math.min(raster.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(raster.height - 1, Math.round(y)));
  const offset = (py * raster.width + px) * 4;
  return [
    raster.data[offset],
    raster.data[offset + 1],
    raster.data[offset + 2],
    raster.data[offset + 3],
  ];
}

function colourDistance(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 765;
}

function alphaCompositeDistance(
  actual: [number, number, number, number],
  expected: [number, number, number, number],
): number {
  const alphaDifference = Math.abs(actual[3] - expected[3]) / 255;
  if (expected[3] < 12) return actual[3] < 245 ? 0 : 0.08;
  return colourDistance(actual, expected) * 0.82 + alphaDifference * 0.18;
}

function sampleTemplateScore(
  raster: Raster,
  badgeTemplate: Raster,
  maskTemplate: Raster,
  candidate: AnalysisRect,
  colour: string,
): number {
  const side = Math.min(candidate.width, candidate.height);
  if (side < 7) return 0;
  const offsetX = (candidate.width - side) / 2;
  const offsetY = (candidate.height - side) / 2;
  const target = hexToRgb(colour);
  let foregroundTotal = 0;
  let foregroundCount = 0;
  let backgroundTotal = 0;
  let backgroundCount = 0;
  for (let row = 0; row < 32; row++) {
    for (let column = 0; column < 32; column++) {
      const expected = pixelAt(badgeTemplate, column, row);
      if (expected[3] < 12) continue;
      const actual = pixelAt(
        raster,
        candidate.x + offsetX + (column + 0.5) * side / 32,
        candidate.y + offsetY + (row + 0.5) * side / 32,
      );
      const maskAlpha = pixelAt(maskTemplate, column, row)[3] / 255;
      if (maskAlpha > 0.2) {
        // Shape pixels are expected to be the brand-colour foreground. This
        // separate term stops a solid brand-colour swatch from scoring as a
        // badge merely because its background colour is plausible.
        foregroundTotal += (1 - colourDistance(actual, [target[0], target[1], target[2], 255])) * maskAlpha;
        foregroundCount += maskAlpha;
      } else {
        backgroundTotal += 1 - alphaCompositeDistance(actual, [255, 255, 255, expected[3]]);
        backgroundCount++;
      }
    }
  }
  if (!foregroundCount || !backgroundCount) return 0;
  const foregroundScore = Math.max(0, foregroundTotal / foregroundCount);
  const backgroundScore = Math.max(0, backgroundTotal / backgroundCount);
  // A candidate must contain both a credible contrasting mark and its
  // expected colour field.  This rejects a small white part of an unrelated
  // icon (and a large solid swatch) instead of allowing either one to win on
  // colour or luminance alone.
  if (foregroundScore < 0.82 || backgroundScore < 0.72) return 0;
  return foregroundScore * 0.55 + backgroundScore * 0.45;
}

function standaloneTemplateScore(
  raster: Raster,
  template: Raster,
  candidate: AnalysisRect,
  colour: string,
): number {
  const side = Math.min(candidate.width, candidate.height);
  if (side < 7) return 0;
  const target = hexToRgb(colour);
  const offsetX = (candidate.width - side) / 2;
  const offsetY = (candidate.height - side) / 2;
  let foreground = 0;
  let foregroundCount = 0;
  let background = 0;
  let backgroundCount = 0;
  let colouredCount = 0;
  let colouredMinX = 32;
  let colouredMinY = 32;
  let colouredMaxX = -1;
  let colouredMaxY = -1;
  for (let row = 0; row < 32; row++) {
    for (let column = 0; column < 32; column++) {
      const expectedMask = pixelAt(template, column, row)[3] / 255;
      const actual = pixelAt(
        raster,
        candidate.x + offsetX + (column + 0.5) * side / 32,
        candidate.y + offsetY + (row + 0.5) * side / 32,
      );
      const closeness = 1 - colourDistance(actual, [target[0], target[1], target[2], 255]);
      if (closeness > 0.86) {
        colouredCount++;
        colouredMinX = Math.min(colouredMinX, column);
        colouredMaxX = Math.max(colouredMaxX, column);
        colouredMinY = Math.min(colouredMinY, row);
        colouredMaxY = Math.max(colouredMaxY, row);
      }
      if (expectedMask > 0.34) {
        foreground += closeness * expectedMask;
        foregroundCount += expectedMask;
      } else if (expectedMask < 0.06) {
        // A large solid swatch has colour in the supposed empty part. This
        // term is what keeps colour-only detection from becoming recognition.
        background += Math.max(0, 1 - closeness);
        backgroundCount++;
      }
    }
  }
  if (!foregroundCount || !backgroundCount) return 0;
  if (colouredCount > 20 && colouredMaxX >= colouredMinX && colouredMaxY >= colouredMinY) {
    const colouredBox = (colouredMaxX - colouredMinX + 1) * (colouredMaxY - colouredMinY + 1);
    // A full rectangular swatch is a common decoration, not evidence of a
    // glyph.  Genuine Simple Icons retain a visible non-colour silhouette
    // (including the finder/camera/play details) in this bounded raster.
    if (colouredCount / colouredBox > 0.93) return 0;
  }
  return (foreground / foregroundCount) * 0.72 + (background / backgroundCount) * 0.28;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function isNearBrandColour(raster: Raster, x: number, y: number, colour: string): boolean {
  const actual = pixelAt(raster, x, y);
  if (actual[3] < 20) return false;
  const target = hexToRgb(colour);
  const saturation = Math.max(actual[0], actual[1], actual[2]) -
    Math.min(actual[0], actual[1], actual[2]);
  return saturation > 30 && colourDistance(actual, [target[0], target[1], target[2], 255]) < 0.28;
}

function addCandidate(
  candidates: AnalysisRect[],
  candidate: AnalysisRect,
  width: number,
  height: number,
  minimumSide = 7,
): void {
  const x = Math.max(0, Math.min(width, candidate.x));
  const y = Math.max(0, Math.min(height, candidate.y));
  const right = Math.max(x, Math.min(width, candidate.x + candidate.width));
  const bottom = Math.max(y, Math.min(height, candidate.y + candidate.height));
  const bounded = { x, y, width: right - x, height: bottom - y };
  if (bounded.width < minimumSide || bounded.height < minimumSide) return;
  // Tiny fragments of a larger decoration can resemble the broad white
  // portion of a social icon.  Automatic detection is intentionally bounded
  // to marks at least this large relative to the QR search area; a caller
  // with a smaller, known crop can still use selectedRegion.
  const key = [bounded.x, bounded.y, bounded.width, bounded.height]
    .map((value) => Math.round(value * 2) / 2).join(",");
  if (candidates.some((item) => [item.x, item.y, item.width, item.height]
    .map((value) => Math.round(value * 2) / 2).join(",") === key)) return;
  candidates.push(bounded);
}

function colourCandidates(raster: Raster, logo: PopularQRLogoMetadata): AnalysisRect[] {
  const active = new Uint8Array(raster.width * raster.height);
  let activeCount = 0;
  let globalMinX = raster.width;
  let globalMinY = raster.height;
  let globalMaxX = -1;
  let globalMaxY = -1;
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      if (isNearBrandColour(raster, x, y, logo.color)) {
        active[y * raster.width + x] = 1;
        activeCount++;
        globalMinX = Math.min(globalMinX, x);
        globalMaxX = Math.max(globalMaxX, x);
        globalMinY = Math.min(globalMinY, y);
        globalMaxY = Math.max(globalMaxY, y);
      }
    }
  }
  const candidates: AnalysisRect[] = [];
  const visited = new Uint8Array(active.length);
  const queue: number[] = [];
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const start = y * raster.width + x;
      if (!active[start] || visited[start]) continue;
      visited[start] = 1;
      queue.length = 0;
      queue.push(start);
      let head = 0;
      let count = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      while (head < queue.length) {
        const at = queue[head++];
        const cy = Math.floor(at / raster.width);
        const cx = at - cy * raster.width;
        count++;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= raster.width || ny >= raster.height) continue;
            const next = ny * raster.width + nx;
            if (active[next] && !visited[next]) {
              visited[next] = 1;
              queue.push(next);
            }
          }
        }
      }
      const componentWidth = maxX - minX + 1;
      const componentHeight = maxY - minY + 1;
      if (count < Math.max(4, (componentWidth * componentHeight) * 0.012)) continue;
      const centerX = (minX + maxX + 1) / 2;
      const centerY = (minY + maxY + 1) / 2;
      const side = Math.max(componentWidth, componentHeight);
      for (const factor of [0.92, 1, 1.08, 1.2, 1.35]) {
        const size = side * factor;
        addCandidate(candidates, {
          x: centerX - size / 2,
          y: centerY - size / 2,
          width: size,
          height: size,
        }, raster.width, raster.height);
      }
    }
  }
  // Some genuine glyphs (notably the YouTube play mark on a red badge) leave
  // only a few disconnected background pixels around the foreground.  The
  // colour cue is still useful as a proposal, but the later full template
  // comparison must validate its shape.
  if (activeCount >= 8 && globalMaxX >= globalMinX && globalMaxY >= globalMinY) {
    const width = globalMaxX - globalMinX + 1;
    const height = globalMaxY - globalMinY + 1;
    const size = Math.max(width, height);
    addCandidate(candidates, {
      x: (globalMinX + globalMaxX + 1) / 2 - size / 2,
      y: (globalMinY + globalMaxY + 1) / 2 - size / 2,
      width: size,
      height: size,
    }, raster.width, raster.height);
  }
  return candidates;
}

function fallbackCandidates(width: number, height: number): AnalysisRect[] {
  const candidates: AnalysisRect[] = [];
  const sizes = [0.07, 0.1, 0.14, 0.19, 0.26, 0.36];
  const anchors = [0.1, 0.25, 0.5, 0.75, 0.9];
  const base = Math.min(width, height);
  for (const sizeRatio of sizes) {
    const size = base * sizeRatio;
    for (const anchorY of anchors) {
      for (const anchorX of anchors) {
        addCandidate(candidates, {
          x: anchorX * width - size / 2,
          y: anchorY * height - size / 2,
          width: size,
          height: size,
        }, width, height);
      }
    }
  }
  return candidates;
}

function mapToNormalized(candidate: AnalysisRect, qrRegion: PixelRect, analysis: Raster): NormalizedRect {
  const scaleX = qrRegion.width / analysis.width;
  const scaleY = qrRegion.height / analysis.height;
  // Round at the source-pixel edge first.  Returning fractions derived from
  // unrounded analysis coordinates can put a detected right/bottom edge just
  // outside the QR box after a browser resample.
  const left = Math.round(qrRegion.x + candidate.x * scaleX);
  const top = Math.round(qrRegion.y + candidate.y * scaleY);
  const right = Math.round(qrRegion.x + (candidate.x + candidate.width) * scaleX);
  const bottom = Math.round(qrRegion.y + (candidate.y + candidate.height) * scaleY);
  const normalizedX = Math.max(0, Math.min(1, (left - qrRegion.x) / qrRegion.width));
  const normalizedY = Math.max(0, Math.min(1, (top - qrRegion.y) / qrRegion.height));
  const normalizedRight = Math.max(normalizedX, Math.min(1, (right - qrRegion.x) / qrRegion.width));
  const normalizedBottom = Math.max(normalizedY, Math.min(1, (bottom - qrRegion.y) / qrRegion.height));
  return {
    x: normalizedX,
    y: normalizedY,
    width: Math.min(1 - normalizedX, Math.max(1 / qrRegion.width, normalizedRight - normalizedX)),
    height: Math.min(1 - normalizedY, Math.max(1 / qrRegion.height, normalizedBottom - normalizedY)),
  };
}

export type PopularQRLogoDetection =
  | {
    status: "matched";
    brand: PopularQRLogoId;
    /** Normalized to qrRegion (0..1), not source-canvas pixel coordinates. */
    region: NormalizedRect;
    confidence: number;
  }
  | {
    status: "uncertain" | "none";
    reason: string;
  };

function uncertain(reason: string): PopularQRLogoDetection {
  return { status: "uncertain", reason };
}

function none(reason: string): PopularQRLogoDetection {
  return { status: "none", reason };
}

/**
 * Looks only at pixels in `qrRegion` and never consults a QR payload,
 * destination, URL, network service, or upload API.  `selectedRegion`, when
 * supplied, is normalized to the QR rectangle and restricts recognition to
 * that exact user-selected area.  Automatic matching is intentionally narrow:
 * a color cue proposes areas, then the corresponding Simple Icons shape and
 * badge geometry must match strongly and beat every other brand.
 * A matched `region` is normalized to `qrRegion` (its edges are rounded at
 * source-pixel boundaries before conversion), so it can be passed directly
 * to the QR repair logo-region contract.
 *
 * Supported artwork is the opaque badge emitted by renderPopularQRLogo and a
 * bounded transparent, brand-colour Simple Icon on a contrasting background.
 * This is template matching, not general logo or AI recognition.  Unknown
 * decoration is returned as none/uncertain and is never replaced.
 */
export async function detectPopularQRLogo(
  source: HTMLImageElement | HTMLCanvasElement,
  qrRegion: PixelRect,
  selectedRegion?: NormalizedRect,
): Promise<PopularQRLogoDetection> {
  const dimensions = sourceDimensions(source);
  if (!dimensions) return uncertain("The source has no usable image dimensions");
  if (!validPixelRegion(qrRegion, dimensions)) {
    return uncertain("The QR pixel region is outside the source or is not positive and finite");
  }
  if (selectedRegion !== undefined && !validNormalizedRegion(selectedRegion)) {
    return uncertain("The selected logo region must be a positive normalized rectangle inside the QR region");
  }
  if (qrRegion.width < 8 || qrRegion.height < 8) return none("The QR region is too small for a supported logo template");

  const scale = Math.min(
    1,
    MAX_ANALYSIS_EDGE / qrRegion.width,
    MAX_ANALYSIS_EDGE / qrRegion.height,
  );
  const analysisWidth = Math.max(1, Math.round(qrRegion.width * scale));
  const analysisHeight = Math.max(1, Math.round(qrRegion.height * scale));
  let analysisCanvas: HTMLCanvasElement | OffscreenCanvas;
  try {
    analysisCanvas = createScratchCanvas(analysisWidth, analysisHeight);
    const analysisContext = analysisCanvas.getContext("2d");
    if (!analysisContext) return uncertain("The local canvas has no 2D context");
    analysisContext.clearRect(0, 0, analysisWidth, analysisHeight);
    analysisContext.drawImage(
      source,
      qrRegion.x,
      qrRegion.y,
      qrRegion.width,
      qrRegion.height,
      0,
      0,
      analysisWidth,
      analysisHeight,
    );
  } catch {
    return uncertain("The source pixels could not be read locally");
  }

  let analysis: Raster;
  try {
    analysis = rasterizeCanvas(analysisCanvas);
  } catch {
    return uncertain("The source pixels could not be read locally");
  }

  const candidates: AnalysisRect[] = [];
  if (selectedRegion) {
    addCandidate(candidates, {
      x: selectedRegion.x * analysis.width,
      y: selectedRegion.y * analysis.height,
      width: selectedRegion.width * analysis.width,
      height: selectedRegion.height * analysis.height,
    }, analysis.width, analysis.height);
  } else {
    for (const logo of POPULAR_QR_LOGOS) {
      for (const candidate of colourCandidates(analysis, logo)) {
        addCandidate(
          candidates,
          candidate,
          analysis.width,
          analysis.height,
          Math.min(analysis.width, analysis.height) * 0.16,
        );
      }
    }
    for (const candidate of fallbackCandidates(analysis.width, analysis.height)) {
      addCandidate(
        candidates,
        candidate,
        analysis.width,
        analysis.height,
        Math.min(analysis.width, analysis.height) * 0.16,
      );
    }
  }
  if (candidates.length > MAX_CANDIDATES) candidates.length = MAX_CANDIDATES;

  const bestByBrand = new Map<PopularQRLogoId, {
    score: number;
    candidate: AnalysisRect;
    badge: number;
    standalone: number;
  }>();
  for (const logo of POPULAR_QR_LOGOS) {
    const template = templateFor(logo.id);
    for (const candidate of candidates) {
      const badge = sampleTemplateScore(analysis, template.badge, template.mask, candidate, logo.color);
      const standalone = standaloneTemplateScore(analysis, template.mask, candidate, logo.color);
      const score = Math.max(badge, standalone);
      if (!bestByBrand.has(logo.id) || score > (bestByBrand.get(logo.id)?.score ?? 0)) {
        bestByBrand.set(logo.id, { score, candidate, badge, standalone });
      }
    }
  }

  const ranked = [...bestByBrand.entries()].sort((a, b) => b[1].score - a[1].score);
  if (!ranked.length || ranked[0][1].score < 0.68) {
    const hasColourCue = POPULAR_QR_LOGOS.some((logo) =>
      colourCandidates(analysis, logo).length > 0);
    return hasColourCue
      ? uncertain("A coloured area was found, but no supported logo shape matched strongly")
      : none("No supported logo-shaped area was found");
  }

  const [winner, winnerResult] = ranked[0];
  const runnerUp = ranked[1]?.[1].score ?? 0;
  const minimum = winnerResult.badge >= 0.82 ? 0.82 : 0.79;
  // Requiring both an absolute score and a brand-level margin prevents a
  // simple swatch, a plain QR, or a nearly identical wrong template from
  // silently becoming a brand replacement.
  if (winnerResult.score < minimum || winnerResult.score - runnerUp < 0.075) {
    return uncertain("Logo evidence was not strong or distinct enough for automatic use");
  }

  return {
    status: "matched",
    brand: winner,
    region: mapToNormalized(winnerResult.candidate, qrRegion, analysis),
    confidence: Math.min(0.99, Math.max(0, winnerResult.score)),
  };
}
