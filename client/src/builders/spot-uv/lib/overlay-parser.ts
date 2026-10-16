import { isEPSFile, isSVGFile, SvgTooComplexError } from "./vector-file";
import {
  analyseRawSvgExpansion,
  analyseSvgExpansion,
} from "./svg-expansion";

function isPDFFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function parseSvgLengthToInches(raw: string): number | null {
  const m = raw.trim().match(/^([\d.]+(?:e[+-]?\d+)?)\s*(in|cm|mm|pt|px|pc|)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch ((m[2] ?? "").toLowerCase()) {
    case "in": return n;
    case "cm": return n / 2.54;
    case "mm": return n / 25.4;
    case "pt": return n / 72;
    case "pc": return n / 6;
    case "px": return n / 96;
    default: return n / 96;
  }
}
import {
  closeNearlyOpenPaths,
  countOverlaySegments,
  overlayHasClosedPath,
  overlayInkBox,
  type OverlayParseResult,
  type OverlayPath,
  type OverlaySeg,
  type OverlaySourceKind,
} from "./imported-overlay";

export const MAX_OVERLAY_BYTES = 25 * 1024 * 1024;
export const MAX_OVERLAY_SEGMENTS = 20_000;

export class OverlayParseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OverlayParseError";
    this.code = code;
  }
}

const SPOT_LABEL_PATTERNS: Array<{ label: string; match: RegExp }> = [
  { label: "PerfCutContour", match: /perf[\s_-]?cut/i },
  { label: "KissCut", match: /kiss[\s_-]?cut/i },
  { label: "CutContour", match: /cut[\s_-]?contour/i },
  { label: "RDG_GLOSS", match: /rdg[\s_-]?gloss|varnish/i },
  { label: "RDG_WHITE", match: /rdg[\s_-]?white/i },
];

export function detectOverlayLabel(name: string): string | null {
  return SPOT_LABEL_PATTERNS.find((entry) => entry.match.test(name))?.label ?? null;
}

export function overlayKindFromFile(file: File): OverlaySourceKind | null {
  if (isEPSFile(file)) return "eps";
  if (isPDFFile(file)) return "pdf";
  if (isSVGFile(file)) return "svg";
  return null;
}

export async function parseOverlayFile(file: File): Promise<OverlayParseResult> {
  if (file.size > MAX_OVERLAY_BYTES) {
    throw new OverlayParseError("too_large", "This vector file is too large. Maximum is 25 MB.");
  }
  const kind = overlayKindFromFile(file);
  if (!kind) {
    throw new OverlayParseError("unsupported", "Upload an EPS, PDF, or SVG for the cutline or spot layer.");
  }
  const buffer = await file.arrayBuffer();
  if (kind === "eps") return parseOverlayEps(buffer, file.name);
  if (kind === "pdf") return parseOverlayPdf(buffer, file.name);
  return parseOverlaySvg(new TextDecoder("utf-8").decode(buffer), file.name);
}

export function parseOverlayEps(buffer: ArrayBuffer, filename: string): OverlayParseResult {
  const bytes = new Uint8Array(buffer);
  const text = extractEpsPostScript(bytes);
  const bbox = parseEpsBbox(text);
  if (!(bbox.w > 0.5 && bbox.h > 0.5)) {
    throw new OverlayParseError("empty", "This EPS has no usable page size.");
  }

  const pageStart = text.indexOf("%%EndPageSetup");
  const page = pageStart >= 0 ? text.slice(pageStart) : text;
  const stopAt = page.search(/%%PageTrailer|%%Trailer|%%EOF/);
  const body = stopAt >= 0 ? page.slice(0, stopAt) : page;
  const rawPaths = parsePostScriptPaths(body, bbox.w, bbox.h);
  const paths = finalizePaths(rawPaths, bbox.w, bbox.h, "cutline-or-spot");

  if (paths.length === 0) {
    throw new OverlayParseError(
      "no_paths",
      "This EPS cannot be read as vector paths. Export it as PDF or SVG and try again.",
    );
  }

  return {
    kind: "eps",
    filename,
    nativePage: { widthInches: bbox.w / 72, heightInches: bbox.h / 72 },
    paths: pathsToInches(paths, 72),
    detectedLabel: detectOverlayLabel(filename) ?? detectOverlayLabel(text.slice(0, 4000)),
    warnings: [],
    pageCount: 1,
  };
}

function extractEpsPostScript(bytes: Uint8Array): string {
  let start = 0;
  let length = bytes.length;
  if (bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    start = view.getUint32(4, true);
    length = view.getUint32(8, true);
  } else {
    const marker = indexOfBytes(bytes, "%!PS-Adobe");
    if (marker >= 0) start = marker;
  }
  const slice = bytes.subarray(start, start + length);
  return new TextDecoder("latin1").decode(slice).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function indexOfBytes(haystack: Uint8Array, needle: string): number {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i <= haystack.length - n.length; i++) {
    for (let j = 0; j < n.length; j++) {
      if (haystack[i + j] !== n[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function parseEpsBbox(text: string): { x0: number; y0: number; x1: number; y1: number; w: number; h: number } {
  const hires = text.match(/%%HiResBoundingBox:\s+([^\n]+)/);
  const box = text.match(/%%BoundingBox:\s+([^\n]+)/);
  const raw = (hires || box)?.[1] ?? "0 0 72 72";
  const [x0, y0, x1, y1] = raw.trim().split(/\s+/).map(Number);
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

function parsePostScriptPaths(body: string, pageW: number, pageH: number): OverlayPath[] {
  const tokenRe = /([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|(\b(?:mo|li|cv|cp|m|l|c|h|re)\b)/g;
  const paths: OverlayPath[] = [];
  let current: OverlaySeg[] = [];
  let nums: number[] = [];
  let closed = false;

  const flush = () => {
    if (current.length) {
      paths.push({ segs: current, closed });
      current = [];
      closed = false;
    }
  };

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(body))) {
    if (match[1] != null) {
      nums.push(Number(match[1]));
      continue;
    }
    const op = match[2];
    if ((op === "mo" || op === "m") && nums.length >= 2) {
      flush();
      current = [{ op: "m", x: nums.at(-2)!, y: nums.at(-1)! }];
    } else if ((op === "li" || op === "l") && nums.length >= 2) {
      current.push({ op: "l", x: nums.at(-2)!, y: nums.at(-1)! });
    } else if ((op === "cv" || op === "c") && nums.length >= 6) {
      current.push({
        op: "c",
        x1: nums.at(-6)!,
        y1: nums.at(-5)!,
        x2: nums.at(-4)!,
        y2: nums.at(-3)!,
        x: nums.at(-2)!,
        y: nums.at(-1)!,
      });
    } else if (op === "cp" || op === "h") {
      current.push({ op: "h" });
      closed = true;
    } else if (op === "re" && nums.length >= 4) {
      const x = nums.at(-4)!;
      const y = nums.at(-3)!;
      const w = nums.at(-2)!;
      const h = nums.at(-1)!;
      flush();
      current = [
        { op: "m", x, y },
        { op: "l", x: x + w, y },
        { op: "l", x: x + w, y: y + h },
        { op: "l", x, y: y + h },
        { op: "h" },
      ];
      closed = true;
    }
    nums = [];
  }
  flush();
  return dropPageClip(paths, pageW, pageH);
}

function dropPageClip(paths: OverlayPath[], pageW: number, pageH: number): OverlayPath[] {
  return paths.filter((path) => {
    const pts = path.segs.filter((seg) => seg.op !== "h") as Array<{ x: number; y: number }>;
    if (pts.length < 2) return false;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    return !(pts.length <= 6 && Math.abs(w - pageW) < 0.75 && Math.abs(h - pageH) < 0.75);
  });
}

function finalizePaths(paths: OverlayPath[], pageW: number, pageH: number, roleHint: string): OverlayPath[] {
  const closed = closeNearlyOpenPaths(paths);
  if (countOverlaySegments(closed) > MAX_OVERLAY_SEGMENTS) {
    throw new OverlayParseError(
      "too_complex",
      `This file has too many vector segments (limit ${MAX_OVERLAY_SEGMENTS.toLocaleString()}).`,
    );
  }
  const box = overlayInkBox(closed);
  if (!box || box.width < 0.01 || box.height < 0.01) {
    throw new OverlayParseError("empty", "This file has no visible vector artwork.");
  }
  if (roleHint === "cutline" && !overlayHasClosedPath(closed)) {
    throw new OverlayParseError("open_cut", "The cutline must be a closed path.");
  }
  void pageW;
  void pageH;
  return closed;
}

function pathsToInches(paths: OverlayPath[], unitsPerInch: number): OverlayPath[] {
  const s = 1 / unitsPerInch;
  return paths.map((path) => ({
    closed: path.closed,
    segs: path.segs.map((seg) => {
      if (seg.op === "h") return seg;
      if (seg.op === "c") {
        return {
          op: "c",
          x1: seg.x1 * s,
          y1: seg.y1 * s,
          x2: seg.x2 * s,
          y2: seg.y2 * s,
          x: seg.x * s,
          y: seg.y * s,
        };
      }
      return { ...seg, x: seg.x * s, y: seg.y * s };
    }),
  }));
}

export async function parseOverlayPdf(buffer: ArrayBuffer, filename: string): Promise<OverlayParseResult> {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFStream } = await import("pdf-lib");
  const pdfDoc = await PDFDocument.load(buffer);
  const pages = pdfDoc.getPages();
  if (pages.length === 0) {
    throw new OverlayParseError("empty", "This PDF has no pages.");
  }
  const warnings: string[] = [];
  if (pages.length > 1) {
    warnings.push("This PDF has more than one page. Only page 1 is used — upload each layer as its own file.");
  }

  const page = pages[0];
  const { width, height } = page.getSize();
  const resources = page.node.Resources();
  const context = pdfDoc.context;
  let detectedLabel: string | null = detectOverlayLabel(filename);
  let preferredCs: string | null = null;

  if (resources) {
    const colorSpaces = resources.get(PDFName.of("ColorSpace"));
    if (colorSpaces instanceof PDFDict) {
      for (const [name, value] of colorSpaces.entries()) {
        let resolved = value;
        try {
          resolved = context.lookup(value as any) || value;
        } catch {
          // keep original
        }
        if (!(resolved instanceof PDFArray)) continue;
        if (resolved.get(0)?.toString() !== "/Separation") continue;
        const spot = String(resolved.get(1) ?? "").replace(/^\/+/, "");
        const label = detectOverlayLabel(spot) ?? spot;
        if (!detectedLabel) detectedLabel = label;
        preferredCs = name.toString().replace(/^\//, "");
      }
    }
  }

  const contents = page.node.Contents();
  let contentStr = "";
  const decodeStream = (stream: unknown) => {
    if (stream instanceof PDFStream) {
      contentStr += new TextDecoder("latin1").decode(stream.getContents()) + "\n";
    }
  };
  if (contents instanceof PDFStream) {
    decodeStream(contents);
  } else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      let stream: any = contents.get(i);
      if (stream && !(stream instanceof PDFStream)) {
        try {
          stream = context.lookup(stream);
        } catch {
          continue;
        }
      }
      decodeStream(stream);
    }
  }

  const rawPaths = extractPdfContentPaths(contentStr, width, height, preferredCs);
  const paths = finalizePaths(rawPaths, width, height, "cutline-or-spot");
  if (paths.length === 0) {
    throw new OverlayParseError("no_paths", "This PDF has no vector paths to use as a cutline or spot layer.");
  }

  return {
    kind: "pdf",
    filename,
    nativePage: { widthInches: width / 72, heightInches: height / 72 },
    paths: pathsToInches(paths, 72),
    detectedLabel,
    warnings,
    pageCount: pages.length,
  };
}

function extractPdfContentPaths(
  content: string,
  pageW: number,
  pageH: number,
  preferredCs: string | null,
): OverlayPath[] {
  const tokens = content.match(/-?\d+\.?\d*(?:[eE][+-]?\d+)?|\/[^\s<>\[\]()]+|[a-zA-Z*]+/g) || [];
  const paths: OverlayPath[] = [];
  let current: OverlaySeg[] = [];
  let stack: number[] = [];
  let capture = !preferredCs;
  let closed = false;

  const flush = () => {
    if (current.length) {
      paths.push({ segs: current, closed });
      current = [];
      closed = false;
    }
  };

  for (const token of tokens) {
    if (token.startsWith("/")) {
      if (token === "/CS" || token === "CS" || token === "cs") continue;
      if (preferredCs && (token.slice(1) === preferredCs || detectOverlayLabel(token.slice(1)))) {
        capture = true;
      }
      continue;
    }
    if (token === "CS" || token === "cs") {
      const name = String(stack.at(-1) ?? "");
      if (preferredCs) capture = name === preferredCs || detectOverlayLabel(name) != null;
      stack = [];
      continue;
    }
    const n = Number(token);
    if (Number.isFinite(n) && token !== "e" && !/^[a-zA-Z]/.test(token)) {
      stack.push(n);
      continue;
    }
    if (!capture && preferredCs) {
      stack = [];
      continue;
    }
    if (token === "m" && stack.length >= 2) {
      flush();
      current = [{ op: "m", x: stack.at(-2)!, y: pageH - stack.at(-1)! }];
    } else if (token === "l" && stack.length >= 2) {
      current.push({ op: "l", x: stack.at(-2)!, y: pageH - stack.at(-1)! });
    } else if (token === "c" && stack.length >= 6) {
      current.push({
        op: "c",
        x1: stack.at(-6)!,
        y1: pageH - stack.at(-5)!,
        x2: stack.at(-4)!,
        y2: pageH - stack.at(-3)!,
        x: stack.at(-2)!,
        y: pageH - stack.at(-1)!,
      });
    } else if (token === "h") {
      current.push({ op: "h" });
      closed = true;
    } else if (token === "re" && stack.length >= 4) {
      const x = stack.at(-4)!;
      const y = stack.at(-3)!;
      const w = stack.at(-2)!;
      const h = stack.at(-1)!;
      flush();
      current = [
        { op: "m", x, y: pageH - y },
        { op: "l", x: x + w, y: pageH - y },
        { op: "l", x: x + w, y: pageH - (y + h) },
        { op: "l", x, y: pageH - (y + h) },
        { op: "h" },
      ];
      closed = true;
    } else if (["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"].includes(token)) {
      flush();
    }
    stack = [];
  }
  flush();
  return dropPageClip(paths, pageW, pageH);
}

export function parseOverlaySvg(raw: string, filename: string): OverlayParseResult {
  const sourceExpansion = analyseRawSvgExpansion(raw);
  if (sourceExpansion?.exceeded) throw new SvgTooComplexError(sourceExpansion);

  const parsed = parseSvgDocument(raw);
  if (parsed.expansionExceeded) {
    throw new OverlayParseError("too_complex", "This SVG expands to too many shapes to import safely.");
  }
  const { widthInches, heightInches, paths, warnings } = parsed;
  const finalized = finalizePaths(paths, widthInches, heightInches, "cutline-or-spot");
  if (finalized.length === 0) {
    throw new OverlayParseError("no_paths", "This SVG has no vector paths to use as a cutline or spot layer.");
  }
  return {
    kind: "svg",
    filename,
    nativePage: { widthInches, heightInches },
    paths: finalized,
    detectedLabel: detectOverlayLabel(filename),
    warnings,
    pageCount: 1,
  };
}

function parseSvgDocument(raw: string): {
  widthInches: number;
  heightInches: number;
  paths: OverlayPath[];
  warnings: string[];
  expansionExceeded: boolean;
} {
  const warnings: string[] = [];
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
    if (doc.querySelector("parsererror")) {
      throw new OverlayParseError("empty", "Could not parse this SVG.");
    }
    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== "svg") {
      throw new OverlayParseError("empty", "This file is not a valid SVG.");
    }
    try {
      const expansion = analyseSvgExpansion(root);
      if (expansion.exceeded) return { widthInches: 1, heightInches: 1, paths: [], warnings, expansionExceeded: true };
    } catch {
      // keep going if the analyser cannot run
    }
    const dims = svgRootDimensions(root);
    const vb = parseViewBox(root.getAttribute("viewBox"));
    const scaleX = vb ? dims.widthInches / vb.w : 1 / 96;
    const scaleY = vb ? dims.heightInches / vb.h : 1 / 96;
    const ox = vb ? vb.x : 0;
    const oy = vb ? vb.y : 0;
    const paths: OverlayPath[] = [];
    const walk = (el: Element) => {
      const tag = el.tagName.toLowerCase().replace(/^.*:/, "");
      if (tag === "path") {
        const d = el.getAttribute("d");
        if (d) paths.push(...svgPathToOverlay(d, ox, oy, scaleX, scaleY));
      } else if (tag === "rect") {
        const x = Number(el.getAttribute("x") || 0);
        const y = Number(el.getAttribute("y") || 0);
        const w = Number(el.getAttribute("width") || 0);
        const h = Number(el.getAttribute("height") || 0);
        if (w > 0 && h > 0) {
          paths.push(rectPath((x - ox) * scaleX, (y - oy) * scaleY, w * scaleX, h * scaleY));
        }
      } else if (tag === "circle" || tag === "ellipse") {
        const cx = Number(el.getAttribute("cx") || 0);
        const cy = Number(el.getAttribute("cy") || 0);
        const rx = Number(el.getAttribute(tag === "circle" ? "r" : "rx") || 0);
        const ry = Number(el.getAttribute(tag === "circle" ? "r" : "ry") || rx);
        if (rx > 0 && ry > 0) {
          paths.push(ellipsePath((cx - ox) * scaleX, (cy - oy) * scaleY, rx * scaleX, ry * scaleY));
        }
      } else if (tag === "polygon" || tag === "polyline") {
        const pts = (el.getAttribute("points") || "")
          .trim()
          .split(/[\s,]+/)
          .map(Number)
          .filter(Number.isFinite);
        const segs: OverlaySeg[] = [];
        for (let i = 0; i + 1 < pts.length; i += 2) {
          const x = (pts[i] - ox) * scaleX;
          const y = (pts[i + 1] - oy) * scaleY;
          segs.push({ op: i === 0 ? "m" : "l", x, y });
        }
        if (tag === "polygon") segs.push({ op: "h" });
        if (segs.length) paths.push({ segs, closed: tag === "polygon" });
      }
      for (const child of Array.from(el.children)) walk(child);
    };
    walk(root);
    return { widthInches: dims.widthInches, heightInches: dims.heightInches, paths, warnings, expansionExceeded: false };
  }

  const vbMatch = raw.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  const vb = parseViewBox(vbMatch?.[1] ?? null);
  const wMatch = raw.match(/\bwidth\s*=\s*["']([^"']+)["']/i);
  const hMatch = raw.match(/\bheight\s*=\s*["']([^"']+)["']/i);
  const wIn = wMatch ? parseSvgLengthToInches(wMatch[1]) : null;
  const hIn = hMatch ? parseSvgLengthToInches(hMatch[1]) : null;
  const widthInches = wIn ?? (vb ? vb.w / 96 : 1);
  const heightInches = hIn ?? (vb ? vb.h / 96 : 1);
  const scaleX = vb ? widthInches / vb.w : 1 / 96;
  const scaleY = vb ? heightInches / vb.h : 1 / 96;
  const ox = vb?.x ?? 0;
  const oy = vb?.y ?? 0;
  const paths: OverlayPath[] = [];
  const pathRe = /<path\b[^>]*\bd\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(raw))) {
    paths.push(...svgPathToOverlay(m[1], ox, oy, scaleX, scaleY));
  }
  return { widthInches, heightInches, paths, warnings, expansionExceeded: false };
}

function svgRootDimensions(root: Element): { widthInches: number; heightInches: number } {
  const w = root.getAttribute("width");
  const h = root.getAttribute("height");
  const wIn = w ? parseSvgLengthToInches(w) : null;
  const hIn = h ? parseSvgLengthToInches(h) : null;
  if (wIn && hIn) return { widthInches: wIn, heightInches: hIn };
  const vb = parseViewBox(root.getAttribute("viewBox"));
  if (vb) return { widthInches: vb.w / 96, heightInches: vb.h / 96 };
  return { widthInches: 300 / 72, heightInches: 150 / 72 };
}

function parseViewBox(raw: string | null): { x: number; y: number; w: number; h: number } | null {
  if (!raw) return null;
  const parts = raw.trim().split(/[\s,]+/).map(Number);
  if (parts.length < 4 || parts.slice(2).some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function rectPath(x: number, y: number, w: number, h: number): OverlayPath {
  return {
    closed: true,
    segs: [
      { op: "m", x, y },
      { op: "l", x: x + w, y },
      { op: "l", x: x + w, y: y + h },
      { op: "l", x, y: y + h },
      { op: "h" },
    ],
  };
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): OverlayPath {
  const k = 0.5522847498307936;
  return {
    closed: true,
    segs: [
      { op: "m", x: cx + rx, y: cy },
      { op: "c", x1: cx + rx, y1: cy + ry * k, x2: cx + rx * k, y2: cy + ry, x: cx, y: cy + ry },
      { op: "c", x1: cx - rx * k, y1: cy + ry, x2: cx - rx, y2: cy + ry * k, x: cx - rx, y: cy },
      { op: "c", x1: cx - rx, y1: cy - ry * k, x2: cx - rx * k, y2: cy - ry, x: cx, y: cy - ry },
      { op: "c", x1: cx + rx * k, y1: cy - ry, x2: cx + rx, y2: cy - ry * k, x: cx + rx, y: cy },
      { op: "h" },
    ],
  };
}

export function svgPathToOverlay(d: string, ox: number, oy: number, sx: number, sy: number): OverlayPath[] {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[+-]?\d+)?/g) || [];
  const paths: OverlayPath[] = [];
  let segs: OverlaySeg[] = [];
  let cmd = "";
  let nums: number[] = [];
  let cx = 0;
  let cy = 0;
  let sx0 = 0;
  let sy0 = 0;
  let closed = false;

  const mapX = (x: number) => (x - ox) * sx;
  const mapY = (y: number) => (y - oy) * sy;
  const flush = () => {
    if (segs.length) {
      paths.push({ segs, closed });
      segs = [];
      closed = false;
    }
  };
  const take = (n: number) => {
    const out = nums.slice(0, n);
    nums = nums.slice(n);
    return out;
  };

  const apply = () => {
    while (true) {
      if (cmd === "M" || cmd === "m") {
        if (nums.length < 2) return;
        const [x, y] = take(2);
        const abs = cmd === "M";
        cx = abs ? x : cx + x;
        cy = abs ? y : cy + y;
        flush();
        segs = [{ op: "m", x: mapX(cx), y: mapY(cy) }];
        sx0 = cx;
        sy0 = cy;
        cmd = cmd === "M" ? "L" : "l";
      } else if (cmd === "L" || cmd === "l") {
        if (nums.length < 2) return;
        const [x, y] = take(2);
        cx = cmd === "L" ? x : cx + x;
        cy = cmd === "L" ? y : cy + y;
        segs.push({ op: "l", x: mapX(cx), y: mapY(cy) });
      } else if (cmd === "H" || cmd === "h") {
        if (nums.length < 1) return;
        const [x] = take(1);
        cx = cmd === "H" ? x : cx + x;
        segs.push({ op: "l", x: mapX(cx), y: mapY(cy) });
      } else if (cmd === "V" || cmd === "v") {
        if (nums.length < 1) return;
        const [y] = take(1);
        cy = cmd === "V" ? y : cy + y;
        segs.push({ op: "l", x: mapX(cx), y: mapY(cy) });
      } else if (cmd === "C" || cmd === "c") {
        if (nums.length < 6) return;
        const [x1, y1, x2, y2, x, y] = take(6);
        const ax1 = cmd === "C" ? x1 : cx + x1;
        const ay1 = cmd === "C" ? y1 : cy + y1;
        const ax2 = cmd === "C" ? x2 : cx + x2;
        const ay2 = cmd === "C" ? y2 : cy + y2;
        cx = cmd === "C" ? x : cx + x;
        cy = cmd === "C" ? y : cy + y;
        segs.push({
          op: "c",
          x1: mapX(ax1),
          y1: mapY(ay1),
          x2: mapX(ax2),
          y2: mapY(ay2),
          x: mapX(cx),
          y: mapY(cy),
        });
      } else if (cmd === "Z" || cmd === "z") {
        segs.push({ op: "h" });
        closed = true;
        cx = sx0;
        cy = sy0;
        return;
      } else {
        nums = [];
        return;
      }
    }
  };

  for (const token of tokens) {
    if (/^[a-zA-Z]$/.test(token)) {
      cmd = token;
      nums = [];
      if (cmd === "Z" || cmd === "z") apply();
    } else {
      nums.push(Number(token));
      apply();
    }
  }
  flush();
  return paths;
}
