import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DetectedQR } from "./lib/qr";
import {
  sampleQRRepairColors,
  suggestQRRepairColors,
  buildQRRepair,
  verifyQRRepairAtScale,
} from "./lib/qr-repair";
import {
  detectPopularQRLogo,
  POPULAR_QR_LOGOS,
  type PopularQRLogoId,
} from "./lib/popular-qr-logos";
import type {
  QRRepairDraft,
  QRRepairOptions,
  QRRepairRegion,
  QRRepairResult,
} from "./lib/qr-repair-types";
import { LogoRegionSelector, type LogoRegion } from "./logo-region-selector";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import "./qr-repair-studio.css";
import {
  Check,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  LockKeyhole,
  MousePointer2,
  ScanLine,
  ShieldAlert,
  Sparkles,
  XCircle,
} from "lucide-react";

export interface QRRepairStudioProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  image: HTMLImageElement;
  qrCodes: DetectedQR[];
  onApply: (drafts: QRRepairDraft[]) => Promise<void>;
  onScan: (deep: boolean) => void;
  onCancelScan: () => void;
  scanStatus: {
    state: "idle" | "scanning" | "complete" | "cancelled" | "error";
    message: string;
  };
  /** Final output pixels per source preview pixel (normally 300 dpi output). */
  printScale: number;
  /** Optional vertical output scale for unlocked aspect-ratio transforms. */
  printScaleY?: number;
}

type DraftMap = Record<string, QRRepairDraft>;
type SampledColorMap = Record<string, { dark: string; light: string }>;
type ScaleCheck = {
  verified: boolean;
  pixelsPerModule: number;
  warning?: string;
};
type TestedDraft = {
  signature: string;
  printScale: number;
  printScaleY: number;
  result: QRRepairResult;
  scale: ScaleCheck;
};
type DetectionMeta = {
  bbox: QRRepairRegion;
  payload: string;
};
type ArtContentRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
type StudioRepairOptions = QRRepairOptions & {
  logoRegion?: LogoRegion;
  replacementLogo?: PopularQRLogoId;
};
type LogoRecognitionState = {
  status: "checking" | "matched" | "uncertain" | "none" | "error";
  brand?: PopularQRLogoId;
  region?: LogoRegion;
  reason?: string;
};

const DEFAULT_DARK = "#111827";
const DEFAULT_LIGHT = "#ffffff";
const INITIAL_MANUAL_REGION: QRRepairRegion = { x: 0, y: 0, width: 0, height: 0 };
const KEEP_ORIGINAL_LOGO = "__keep_original__";

function imageDimensions(image: HTMLImageElement) {
  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
  };
}

function imageIdentity(image: HTMLImageElement) {
  // Use the source URL rather than natural dimensions: dimensions commonly
  // change once an image finishes loading, which must not erase an edit in
  // progress. The element identity below still catches a new image object
  // that happens to reuse the same URL.
  return image.src || image.currentSrc || "";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function rounded(value: number) {
  return Math.round(Number.isFinite(value) ? value : 0);
}

function boundedRegion(region: QRRepairRegion, image: HTMLImageElement): QRRepairRegion {
  const { width: imageWidth, height: imageHeight } = imageDimensions(image);
  const x = clamp(rounded(region.x), 0, Math.max(0, imageWidth));
  const y = clamp(rounded(region.y), 0, Math.max(0, imageHeight));
  const width = clamp(rounded(region.width), 0, Math.max(0, imageWidth - x));
  const height = clamp(rounded(region.height), 0, Math.max(0, imageHeight - y));
  return { x, y, width, height };
}

function validRegion(region: QRRepairRegion) {
  return region.width > 1 && region.height > 1;
}

function sameRegion(a: QRRepairRegion, b: QRRepairRegion) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function bboxIoU(a: QRRepairRegion, b: QRRepairRegion) {
  const intersectionWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const intersectionHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = intersectionWidth * intersectionHeight;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function bboxCenterDistance(a: QRRepairRegion, b: QRRepairRegion) {
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
}

/**
 * A repair patch is axis-aligned and replaces every pixel in its region.
 * Rotated or perspective detections must therefore be handled by the user,
 * rather than silently painting an AABB over artwork around the QR.
 */
function isSafeAutoDetection(code: DetectedQR) {
  const { bbox, corners } = code;
  const edge = Math.max(1, Math.max(bbox.width, bbox.height));
  const angle = Math.atan2(
    corners.topRight.y - corners.topLeft.y,
    corners.topRight.x - corners.topLeft.x,
  );
  const axisAligned = Math.abs(Math.sin(angle)) < 0.025;
  const squareEnough = Math.max(bbox.width, bbox.height) / Math.max(1, Math.min(bbox.width, bbox.height)) < 1.2;
  const near = (actual: number, expected: number) => Math.abs(actual - expected) <= Math.max(1, edge * 0.01);
  const cornersOnAabb =
    near(corners.topLeft.x, bbox.x) &&
    near(corners.topLeft.y, bbox.y) &&
    near(corners.topRight.x, bbox.x + bbox.width) &&
    near(corners.topRight.y, bbox.y) &&
    near(corners.bottomLeft.x, bbox.x) &&
    near(corners.bottomLeft.y, bbox.y + bbox.height) &&
    near(corners.bottomRight.x, bbox.x + bbox.width) &&
    near(corners.bottomRight.y, bbox.y + bbox.height);
  return axisAligned && squareEnough && cornersOnAabb;
}

function detectionsMatch(incoming: DetectedQR, existing: DetectionMeta) {
  const incomingRegion = incoming.bbox;
  const overlap = bboxIoU(incomingRegion, existing.bbox);
  // IoU handles normal detector jitter. The center fallback handles a
  // slightly resized bbox without allowing equal-payload codes far apart to
  // collapse into one draft.
  const centerLimit = Math.max(
    8,
    Math.min(Math.max(incomingRegion.width, incomingRegion.height), Math.max(existing.bbox.width, existing.bbox.height)) * 0.65,
  );
  return overlap >= 0.12 || bboxCenterDistance(incomingRegion, existing.bbox) <= centerLimit;
}

function colorInputValue(value: string) {
  const normalized = value.trim();
  const sixDigit = normalized.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  return sixDigit ? `#${sixDigit[1]}` : DEFAULT_DARK;
}

function qrId(code: DetectedQR) {
  const b = code.bbox;
  // Payload plus the complete bbox keeps equal payloads in different regions separate,
  // and lets delayed scan results merge into the draft the user is already editing.
  return `detected-${encodeURIComponent(
    `${code.payload}|${rounded(b.x)}:${rounded(b.y)}:${rounded(b.width)}:${rounded(b.height)}`,
  )}`;
}

function draftSignature(draft: QRRepairDraft) {
  const options = draft.options as StudioRepairOptions;
  return JSON.stringify({
    id: draft.id,
    region: draft.region,
    options: {
      ...draft.options,
      // Keep this explicit so a selected logo rectangle is always part of the
      // tested identity, including when older drafts omit the optional field.
      logoRegion: options.logoRegion ?? null,
      // Replacement assets are part of the rendered pixels and therefore
      // must invalidate a previously verified preview.
      replacementLogo: options.replacementLogo ?? null,
    },
    originalPayload: draft.originalPayload,
  });
}

function draftLogoRegion(options: QRRepairOptions): LogoRegion | undefined {
  return (options as StudioRepairOptions).logoRegion;
}

function draftReplacementLogo(options: QRRepairOptions): PopularQRLogoId | undefined {
  return (options as StudioRepairOptions).replacementLogo;
}

function popularLogoLabel(id: PopularQRLogoId | undefined) {
  return id
    ? POPULAR_QR_LOGOS.find((logo) => logo.id === id)?.label ?? id
    : "Keep original";
}

function validLogoRegion(region: LogoRegion | undefined): region is LogoRegion {
  if (!region) return false;
  const values = [region.x, region.y, region.width, region.height];
  return values.every(Number.isFinite) &&
    region.x >= 0 &&
    region.y >= 0 &&
    region.width > 0 &&
    region.height > 0 &&
    region.x + region.width <= 1 &&
    region.y + region.height <= 1;
}

function isManualDraft(draft: QRRepairDraft) {
  return draft.originalPayload === undefined;
}

function sampleColors(
  image: HTMLImageElement,
  region: QRRepairRegion,
): { colors: { dark: string; light: string }; error?: string } {
  try {
    const colors = sampleQRRepairColors(image, region);
    return {
      colors: {
        dark: colors.dark || DEFAULT_DARK,
        light: colors.light || DEFAULT_LIGHT,
      },
    };
  } catch (error) {
    return {
      colors: { dark: DEFAULT_DARK, light: DEFAULT_LIGHT },
      error: error instanceof Error ? error.message : "Unable to sample the original QR colors.",
    };
  }
}

function makeDraft(
  id: string,
  image: HTMLImageElement,
  region: QRRepairRegion,
  payload: string,
  originalPayload?: string,
) {
  const sampled = sampleColors(image, region);
  const draft: QRRepairDraft = {
    id,
    region,
    originalPayload,
    options: {
      payload,
      dark: sampled.colors.dark,
      light: sampled.colors.light,
      errorCorrectionLevel: "M",
      quietZone: 4,
      preserveLogo: false,
      logoScale: 0.15,
    },
  };
  return { draft, sampled: sampled.colors, sampleError: sampled.error };
}

function scanStatusLabel(state: QRRepairStudioProps["scanStatus"]["state"]) {
  switch (state) {
    case "scanning":
      return "Scanning";
    case "complete":
      return "Scan complete";
    case "cancelled":
      return "Scan cancelled";
    case "error":
      return "Scan error";
    default:
      return "Ready to scan";
  }
}

function OriginalCropPreview({
  image,
  region,
}: {
  image: HTMLImageElement;
  region: QRRepairRegion;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !validRegion(region)) return;
    const ratio = region.width / Math.max(1, region.height);
    const width = Math.min(520, Math.max(160, region.width));
    const height = Math.max(80, Math.round(width / Math.max(0.1, ratio)));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    try {
      context.drawImage(
        image,
        region.x,
        region.y,
        region.width,
        region.height,
        0,
        0,
        width,
        height,
      );
    } catch {
      context.fillStyle = "#172033";
      context.fillRect(0, 0, width, height);
    }
  }, [image, region]);

  if (!validRegion(region)) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-slate-700 bg-slate-950/50 px-4 text-center text-xs text-slate-500">
        Select or draw a QR region to preview the original crop.
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className="block max-h-52 w-full rounded-lg border border-slate-700 bg-white object-contain [image-rendering:auto]"
      aria-label="Original QR crop"
    />
  );
}

function RebuiltPreview({ result }: { result?: QRRepairResult }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const target = canvasRef.current;
    if (!target || !result?.canvas) return;
    target.width = result.canvas.width;
    target.height = result.canvas.height;
    const context = target.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, target.width, target.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(result.canvas, 0, 0);
  }, [result]);

  if (!result) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-slate-700 bg-slate-950/50 px-4 text-center text-xs text-slate-500">
        Verify this draft to render its rebuilt QR preview.
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className="block max-h-52 w-full rounded-lg border border-emerald-400/40 bg-white object-contain [image-rendering:pixelated]"
      aria-label="Verified rebuilt QR preview"
    />
  );
}

function StatusIcon({ ok, pending = false, untested = false }: { ok: boolean; pending?: boolean; untested?: boolean }) {
  if (pending) return <Loader2 className="h-4 w-4 animate-spin text-sky-300" aria-hidden="true" />;
  if (untested) return <span className="h-4 w-4 rounded-full border border-slate-500" aria-hidden="true" />;
  return ok ? (
    <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />
  ) : (
    <XCircle className="h-4 w-4 text-rose-400" aria-hidden="true" />
  );
}

export function QRRepairStudio({
  open,
  onOpenChange,
  image,
  qrCodes,
  onApply,
  onScan,
  onCancelScan,
  scanStatus,
  printScale,
  printScaleY: printScaleYProp,
}: QRRepairStudioProps) {
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [sampledColors, setSampledColors] = useState<SampledColorMap>({});
  const [editedIds, setEditedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [queueIds, setQueueIds] = useState<Set<string>>(new Set());
  const [tested, setTested] = useState<Record<string, TestedDraft>>({});
  const [error, setError] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [logoCropUnavailableId, setLogoCropUnavailableId] = useState<string | null>(null);
  const [manualRegion, setManualRegion] = useState<QRRepairRegion>(INITIAL_MANUAL_REGION);
  const [manualPayload, setManualPayload] = useState("");
  const [unsafeDetectionCount, setUnsafeDetectionCount] = useState(0);
  const [artContentRect, setArtContentRect] = useState<ArtContentRect>({ left: 0, top: 0, width: 100, height: 100 });
  const [artLoadVersion, setArtLoadVersion] = useState(0);
  const [logoRecognition, setLogoRecognition] = useState<Record<string, LogoRecognitionState>>({});
  const manualCounter = useRef(0);
  const manualPointerStart = useRef<{ x: number; y: number } | null>(null);
  const artRef = useRef<HTMLDivElement>(null);
  const artImageRef = useRef<HTMLImageElement>(null);
  const measureArtRef = useRef<() => void>(() => undefined);
  const draftsRef = useRef<DraftMap>({});
  const detectedMetaRef = useRef<Record<string, DetectionMeta>>({});
  const lastImageIdentity = useRef<string | null>(null);
  const lastImageElement = useRef<HTMLImageElement | null>(null);
  const sourceRecognitionIds = useRef(new WeakMap<HTMLImageElement, string>());
  const sourceRecognitionCounter = useRef(0);
  const recognitionAttempts = useRef(new Set<string>());
  const recognitionRequest = useRef(0);
  const logoChoiceVersions = useRef<Record<string, number>>({});
  const manuallyEditedLogoChoices = useRef(new Set<string>());
  const keepOriginalLogoChoices = useRef(new Set<string>());
  const openRef = useRef(open);
  const selectedIdRef = useRef<string | null>(selectedId);
  const previousRecognitionSelection = useRef<string | null>(selectedId);
  const currentImageIdentity = imageIdentity(image);
  const dimensions = imageDimensions(image);
  const printScaleY = printScaleYProp ?? printScale;
  openRef.current = open;
  selectedIdRef.current = selectedId;
  const sourceRecognitionId = useMemo(() => {
    const existing = sourceRecognitionIds.current.get(image);
    if (existing) return existing;
    sourceRecognitionCounter.current += 1;
    const next = `source-${sourceRecognitionCounter.current}`;
    sourceRecognitionIds.current.set(image, next);
    return next;
  }, [image]);
  const sourceUrl = useMemo(() => {
    // The retained Image is drawable even after its upload blob URL has been
    // revoked. A new <img> cannot reload that URL; use a bounded display copy.
    const size = imageDimensions(image);
    if (!size.width || !size.height) return "";
    const scale = Math.min(1, 1024 / Math.max(size.width, size.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(size.width * scale));
    canvas.height = Math.max(1, Math.round(size.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return "";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  }, [image]);
  const safeDetectedCodes = useMemo(
    () => qrCodes.filter(isSafeAutoDetection),
    [qrCodes],
  );

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  // object-contain may leave horizontal or vertical letterbox space. Keep the
  // overlay and pointer coordinate system on the actual rendered image
  // content, not on that empty space.
  useLayoutEffect(() => {
    const measure = () => {
      const container = artRef.current;
      const renderedImage = artImageRef.current;
      const currentDimensions = imageDimensions(image);
      if (!container || !renderedImage || !currentDimensions.width || !currentDimensions.height) return;
      const containerRect = container.getBoundingClientRect();
      const imageRect = renderedImage.getBoundingClientRect();
      if (!containerRect.width || !containerRect.height || !imageRect.width || !imageRect.height) return;
      const sourceRatio = currentDimensions.width / currentDimensions.height;
      const boxRatio = imageRect.width / imageRect.height;
      const contentWidth = boxRatio > sourceRatio ? imageRect.height * sourceRatio : imageRect.width;
      const contentHeight = boxRatio > sourceRatio ? imageRect.height : imageRect.width / sourceRatio;
      const contentLeft = imageRect.left - containerRect.left + (imageRect.width - contentWidth) / 2;
      const contentTop = imageRect.top - containerRect.top + (imageRect.height - contentHeight) / 2;
      const next = {
        left: clamp((contentLeft / containerRect.width) * 100, 0, 100),
        top: clamp((contentTop / containerRect.height) * 100, 0, 100),
        width: clamp((contentWidth / containerRect.width) * 100, 0, 100),
        height: clamp((contentHeight / containerRect.height) * 100, 0, 100),
      };
      setArtContentRect((previous) =>
        Math.abs(previous.left - next.left) < 0.05 &&
        Math.abs(previous.top - next.top) < 0.05 &&
        Math.abs(previous.width - next.width) < 0.05 &&
        Math.abs(previous.height - next.height) < 0.05
          ? previous
          : next,
      );
    };
    measureArtRef.current = measure;
    measure();
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(measure)
      : null;
    if (observer) {
      if (artRef.current) observer.observe(artRef.current);
      if (artImageRef.current) observer.observe(artImageRef.current);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      measureArtRef.current = () => undefined;
    };
  }, [artLoadVersion, dimensions.height, dimensions.width, image, sourceUrl]);

  const createDetectedDrafts = useCallback(() => {
    const next: DraftMap = {};
    const colors: SampledColorMap = {};
    const detectedMeta: Record<string, DetectionMeta> = {};
    let nextSampleError: string | null = null;
    for (const code of safeDetectedCodes) {
      const id = qrId(code);
      const region = boundedRegion(code.bbox, image);
      // A detector that finds a region but cannot decode its content must
      // remain an editable manual candidate. Never lock an empty payload.
      const originalPayload = code.payload.trim() ? code.payload : undefined;
      const made = makeDraft(id, image, region, code.payload, originalPayload);
      next[id] = made.draft;
      colors[id] = made.sampled;
      detectedMeta[id] = { bbox: region, payload: code.payload };
      if (made.sampleError) nextSampleError = made.sampleError;
    }
    return { next, colors, detectedMeta, nextSampleError };
  }, [image, safeDetectedCodes]);

  // A new source image is a hard boundary: never carry a rendered result or a
  // draft from a previous design into the new design.
  useEffect(() => {
    if (
      lastImageElement.current === image &&
      lastImageIdentity.current === currentImageIdentity
    ) return;
    lastImageElement.current = image;
    lastImageIdentity.current = currentImageIdentity;
    const seeded = createDetectedDrafts();
    const firstId = Object.keys(seeded.next)[0] ?? null;
    draftsRef.current = seeded.next;
    detectedMetaRef.current = seeded.detectedMeta;
    setDrafts(seeded.next);
    setSampledColors(seeded.colors);
    setEditedIds(new Set());
    setTested({});
    setError(null);
    setSampleError(seeded.nextSampleError);
    setLogoCropUnavailableId(null);
    setLogoRecognition({});
    recognitionAttempts.current = new Set();
    logoChoiceVersions.current = {};
    manuallyEditedLogoChoices.current = new Set();
    keepOriginalLogoChoices.current = new Set();
    recognitionRequest.current += 1;
    setSelectedId(firstId);
    setQueueIds(firstId ? new Set([firstId]) : new Set());
    setManualRegion(INITIAL_MANUAL_REGION);
    setManualPayload("");
  }, [createDetectedDrafts, currentImageIdentity]);

  useEffect(() => {
    setUnsafeDetectionCount(qrCodes.length - safeDetectedCodes.length);
  }, [qrCodes.length, safeDetectedCodes.length]);

  // Scans can return after the modal has opened. Reconcile by region rather
  // than exact bbox coordinates: detector jitter must update one draft's
  // geometry and invalidate its render, not create an independently applicable
  // duplicate. Matching is one-to-one so equal payloads at separate positions
  // remain separate repairs.
  useEffect(() => {
    const completedEmptyScan = scanStatus.state === "complete" && qrCodes.length === 0;
    if (
      lastImageIdentity.current !== currentImageIdentity ||
      (qrCodes.length === 0 && !completedEmptyScan)
    ) return;
    const previous = draftsRef.current;
    const previousMeta = detectedMetaRef.current;
    const usedPreviousIds = new Set<string>();
    const next = { ...previous };
    const nextMeta: Record<string, DetectionMeta> = {};
    const nextColors: SampledColorMap = {};
    const invalidatedIds = new Set<string>();
    const contentConflictIds: string[] = [];
    let nextSampleError: string | null = null;
    let changed = false;

    for (const code of safeDetectedCodes) {
      const region = boundedRegion(code.bbox, image);
      const candidates = Object.entries(previousMeta)
        .filter(([id, meta]) => !usedPreviousIds.has(id) && detectionsMatch(code, meta))
        .sort(([, a], [, b]) => {
          const score = (meta: DetectionMeta) =>
            bboxIoU(region, meta.bbox) * 100 -
            bboxCenterDistance(region, meta.bbox) /
              Math.max(1, Math.max(region.width, region.height)) +
            (meta.payload === code.payload ? 5 : 0);
          return score(b) - score(a);
        });
      const matchedId = candidates[0]?.[0];
      const id = matchedId ?? qrId(code);
      if (matchedId) usedPreviousIds.add(matchedId);

      if (!matchedId || !next[id]) {
        const originalPayload = code.payload.trim() ? code.payload : undefined;
        const made = makeDraft(id, image, region, code.payload, originalPayload);
        next[id] = made.draft;
        nextColors[id] = made.sampled;
        if (made.sampleError) nextSampleError = made.sampleError;
        changed = true;
      } else {
        const existing = next[id];
        const userEdited = editedIds.has(id);
        const regionChanged = !sameRegion(existing.region, region);
        const incomingPayload = code.payload;
        const previousPayload = previousMeta[id]?.payload ?? "";
        const contentConflict = previousPayload !== incomingPayload;
        const payloadChanged = contentConflict || (!userEdited && existing.options.payload !== incomingPayload);
        const updated: QRRepairDraft = contentConflict
          ? {
              ...existing,
              region,
              // A rescan disagreement is never resolved by trusting either
              // payload. Preserve colors/ECC/etc., but require the user to
              // enter and verify the exact content again.
              originalPayload: undefined,
              options: { ...existing.options, payload: "" },
            }
          : {
              ...existing,
              region,
              ...(!userEdited
                ? {
                    originalPayload: incomingPayload.trim() ? incomingPayload : undefined,
                    options: { ...existing.options, payload: incomingPayload },
                  }
                : {}),
            };
        next[id] = updated;
        nextMeta[id] = { bbox: region, payload: incomingPayload };
        if (regionChanged || payloadChanged) {
          invalidatedIds.add(id);
          changed = true;
          if (contentConflict) contentConflictIds.push(id);
          const sampled = sampleColors(image, region);
          nextColors[id] = sampled.colors;
          if (sampled.error) nextSampleError = sampled.error;
        }
      }
      nextMeta[id] ??= { bbox: region, payload: code.payload };
    }

    const removedIds = Object.keys(previousMeta).filter((id) => !usedPreviousIds.has(id));
    for (const id of removedIds) {
      delete next[id];
      delete nextColors[id];
      changed = true;
    }
    // The current scan is authoritative for detected drafts. User-created
    // manual candidates are not in previousMeta and are intentionally kept.
    detectedMetaRef.current = nextMeta;
    if (!changed) return;
    draftsRef.current = next;
    setDrafts(next);
    setSampledColors((old) => {
      const updated = { ...old };
      for (const id of removedIds) delete updated[id];
      Object.assign(updated, nextColors);
      return updated;
    });
    if (nextSampleError) setSampleError(nextSampleError);
    if (removedIds.length > 0) {
      setEditedIds((old) => {
        let changedEditedIds = false;
        const updated = new Set(old);
        for (const id of removedIds) {
          if (updated.delete(id)) changedEditedIds = true;
        }
        return changedEditedIds ? updated : old;
      });
    }
    setTested((old) => {
      const updated = { ...old };
      for (const id of [...removedIds, ...invalidatedIds]) delete updated[id];
      return updated;
    });
    const firstRemainingId = Object.keys(next)[0] ?? null;
    setSelectedId((current) => (current && next[current] ? current : firstRemainingId));
    setQueueIds((old) => {
      const updated = new Set([...old].filter((id) => Boolean(next[id])));
      if (!updated.size && firstRemainingId) updated.add(firstRemainingId);
      return updated;
    });
    if (contentConflictIds.length > 0) {
      setError(
        "QR content changed during a rescan for the same region. The payload was cleared; manually re-enter the exact content and verify it before applying.",
      );
    }
  }, [currentImageIdentity, editedIds, image, qrCodes.length, safeDetectedCodes, scanStatus.state]);

  const selectedDraft = selectedId ? drafts[selectedId] : undefined;
  const selectedTest = selectedId && selectedDraft
    ? tested[selectedId]?.signature === draftSignature(selectedDraft) &&
      tested[selectedId]?.printScale === printScale &&
      tested[selectedId]?.printScaleY === printScaleY
      ? tested[selectedId]
      : undefined
    : undefined;

  useEffect(() => {
    const previousId = previousRecognitionSelection.current;
    if (previousId === selectedId) return;
    previousRecognitionSelection.current = selectedId;
    recognitionRequest.current += 1;
    if (!previousId) return;
    setLogoRecognition((previous) => {
      if (previous[previousId]?.status !== "checking") return previous;
      const next = { ...previous };
      delete next[previousId];
      return next;
    });
  }, [selectedId]);

  // Recognition is deliberately separate from QR decoding. It receives only
  // the retained source pixels and the bounded QR rectangle, never payload
  // text. A source/draft key prevents a selection from starting duplicate
  // background recognizers when unrelated controls rerender the dialog.
  useEffect(() => {
    if (
      !open ||
      !selectedDraft ||
      draftsRef.current[selectedDraft.id] !== selectedDraft ||
      isManualDraft(selectedDraft) ||
      !validRegion(selectedDraft.region)
    ) {
      return;
    }
    const region = boundedRegion(selectedDraft.region, image);
    if (!validRegion(region)) return;
    const requestKey = [
      sourceRecognitionId,
      selectedDraft.id,
      region.x,
      region.y,
      region.width,
      region.height,
    ].join(":");
    if (recognitionAttempts.current.has(requestKey)) return;
    recognitionAttempts.current.add(requestKey);

    const requestId = ++recognitionRequest.current;
    const requestedDraft = selectedDraft;
    const requestedSignature = draftSignature(requestedDraft);
    const requestedLogoVersion = logoChoiceVersions.current[requestedDraft.id] ?? 0;
    let active = true;
    setLogoRecognition((previous) => ({
      ...previous,
      [requestedDraft.id]: { status: "checking" },
    }));

    void (async () => {
      try {
        const detected = await detectPopularQRLogo(image, region);
        if (!active || requestId !== recognitionRequest.current || !openRef.current) return;

        if (
          detected.status !== "matched" ||
          !validLogoRegion(detected.region)
        ) {
          setLogoRecognition((previous) => ({
            ...previous,
            [requestedDraft.id]: {
              status: detected.status,
              reason: "reason" in detected ? detected.reason : "Logo match was not usable.",
            },
          }));
          return;
        }

        const current = draftsRef.current[requestedDraft.id];
        const currentLogoVersion = logoChoiceVersions.current[requestedDraft.id] ?? 0;
        const choicesChanged =
          !current ||
          draftSignature(current) !== requestedSignature ||
          currentLogoVersion !== requestedLogoVersion ||
          manuallyEditedLogoChoices.current.has(requestedDraft.id);

        // A strong result is useful even when a user changed a logo control
        // while it was pending, but it must never replace that choice.
        if (choicesChanged) {
          setLogoRecognition((previous) => ({
            ...previous,
            [requestedDraft.id]: {
              status: "matched",
              brand: detected.brand,
              region: detected.region,
              reason: "Detected, but your logo choice was kept.",
            },
          }));
          return;
        }

        const nextDraft: QRRepairDraft = {
          ...current,
          options: {
            ...current.options,
            preserveLogo: true,
            logoRegion: { ...detected.region },
            replacementLogo: detected.brand,
          },
        };
        const result = await buildQRRepair(image, nextDraft);
        const scaleResult = verifyQRRepairAtScale(result, { x: printScale, y: printScaleY });
        if (
          !active ||
          requestId !== recognitionRequest.current ||
          !openRef.current ||
          draftsRef.current[requestedDraft.id] === undefined ||
          draftSignature(draftsRef.current[requestedDraft.id]) !== requestedSignature ||
          (logoChoiceVersions.current[requestedDraft.id] ?? 0) !== requestedLogoVersion ||
          manuallyEditedLogoChoices.current.has(requestedDraft.id)
        ) {
          return;
        }

        draftsRef.current = { ...draftsRef.current, [requestedDraft.id]: nextDraft };
        setDrafts((previous) => ({ ...previous, [requestedDraft.id]: nextDraft }));
        setLogoCropUnavailableId((previous) =>
          previous === requestedDraft.id ? null : previous,
        );
        const scale: ScaleCheck = {
          verified: Boolean(scaleResult.verified),
          pixelsPerModule: scaleResult.pixelsPerModule,
          warning: scaleResult.warning,
        };
        setTested((previous) => ({
          ...previous,
          [requestedDraft.id]: {
            signature: draftSignature(nextDraft),
            printScale,
            printScaleY,
            result,
            scale,
          },
        }));
        setLogoRecognition((previous) => ({
          ...previous,
          [requestedDraft.id]: {
            status: "matched",
            brand: detected.brand,
            region: detected.region,
            reason:
              result.verified && scale.verified
                ? "Detected and preview checked. Nothing has been saved."
                : "Detected, but the preview still needs attention before it can be applied.",
          },
        }));
      } catch (recognitionError) {
        if (!active || requestId !== recognitionRequest.current || !openRef.current) return;
        setLogoRecognition((previous) => ({
          ...previous,
          [requestedDraft.id]: {
            status: "error",
            reason:
              recognitionError instanceof Error
                ? recognitionError.message
                : "Logo recognition is unavailable.",
          },
        }));
      }
    })();

    return () => {
      active = false;
      setLogoRecognition((previous) => {
        if (requestId !== recognitionRequest.current) return previous;
        if (previous[requestedDraft.id]?.status !== "checking") return previous;
        const next = { ...previous };
        delete next[requestedDraft.id];
        return next;
      });
    };
  }, [image, open, printScale, printScaleY, selectedDraft, sourceRecognitionId]);

  const handleLogoCropAvailability = useCallback(
    (available: boolean) => {
      if (!selectedDraft) return;
      setLogoCropUnavailableId((current) => (
        available
          ? current === selectedDraft.id ? null : current
          : selectedDraft.id
      ));
    },
    [selectedDraft?.id],
  );

  const updateDraft = useCallback(
    (id: string, update: (draft: QRRepairDraft) => QRRepairDraft) => {
      const existing = draftsRef.current[id];
      if (!existing) return;
      const nextDraft = update(existing);
      draftsRef.current = { ...draftsRef.current, [id]: nextDraft };
      setDrafts((previous) => ({ ...previous, [id]: nextDraft }));
      setEditedIds((previous) => {
        const next = new Set(previous);
        next.add(id);
        return next;
      });
      setTested((previous) => {
        if (!previous[id]) return previous;
        const next = { ...previous };
        delete next[id];
        return next;
      });
      setError(null);
    },
    [],
  );

  const handleCheckLogo = useCallback(async () => {
    if (!selectedDraft) return;
    const selectedOptions = selectedDraft.options as StudioRepairOptions;
    const selectedRegion = selectedOptions.logoRegion;
    if (!validLogoRegion(selectedRegion)) {
      setError("Draw a logo rectangle first. We will not guess its location.");
      return;
    }
    const region = boundedRegion(selectedDraft.region, image);
    if (!validRegion(region)) {
      setError("Select a usable QR region before checking its logo.");
      return;
    }

    const requestId = ++recognitionRequest.current;
    const draftId = selectedDraft.id;
    const requestedSignature = draftSignature(selectedDraft);
    const requestedLogoVersion = logoChoiceVersions.current[draftId] ?? 0;
    setError(null);
    setLogoRecognition((previous) => ({
      ...previous,
      [draftId]: { status: "checking" },
    }));

    try {
      const detected = await detectPopularQRLogo(image, region, selectedRegion);
      if (
        requestId !== recognitionRequest.current ||
        !openRef.current ||
        selectedIdRef.current !== draftId
      ) {
        return;
      }
      if (detected.status !== "matched" || !validLogoRegion(detected.region)) {
        setLogoRecognition((previous) => ({
          ...previous,
          [draftId]: {
            status: detected.status,
            reason: "reason" in detected ? detected.reason : "Logo match was not usable.",
          },
        }));
        return;
      }

      const current = draftsRef.current[draftId];
      if (!current) return;
      const choicesChanged =
        draftSignature(current) !== requestedSignature ||
        (logoChoiceVersions.current[draftId] ?? 0) !== requestedLogoVersion;
      if (choicesChanged) return;

      const currentReplacement = draftReplacementLogo(current.options);
      const keepOriginal =
        keepOriginalLogoChoices.current.has(draftId) ||
        (currentReplacement !== undefined && currentReplacement !== detected.brand);
      if (!keepOriginal && currentReplacement !== detected.brand) {
        // This is an explicit user request to check the selected crop, so a
        // confirmed brand can fill the replacement slot. It still invalidates
        // any old verification and requires the normal Preview fix action.
        updateDraft(draftId, (draft) => ({
          ...draft,
          options: {
            ...draft.options,
            preserveLogo: true,
            logoRegion: { ...selectedRegion },
            replacementLogo: detected.brand,
          },
        }));
      }
      setLogoRecognition((previous) => ({
        ...previous,
        [draftId]: {
          status: "matched",
          brand: detected.brand,
          region: detected.region,
          reason: keepOriginal
            ? "Detected, but your original-logo choice was kept."
            : "Detected. Preview fix to check this selected replacement.",
        },
      }));
    } catch (recognitionError) {
      if (
        requestId !== recognitionRequest.current ||
        !openRef.current ||
        selectedIdRef.current !== draftId
      ) {
        return;
      }
      setLogoRecognition((previous) => ({
        ...previous,
        [draftId]: {
          status: "error",
          reason:
            recognitionError instanceof Error
              ? recognitionError.message
              : "Logo recognition is unavailable.",
        },
      }));
    }
  }, [image, selectedDraft, updateDraft]);

  const updateOptions = useCallback(
    (
      id: string,
      update: Partial<StudioRepairOptions>,
      markLogoChoice = true,
    ) => {
      const logoChoiceEdited =
        "preserveLogo" in update ||
        "logoRegion" in update ||
        "replacementLogo" in update;
      if (logoChoiceEdited && markLogoChoice) {
        recognitionRequest.current += 1;
        logoChoiceVersions.current[id] = (logoChoiceVersions.current[id] ?? 0) + 1;
        manuallyEditedLogoChoices.current.add(id);
        setLogoRecognition((previous) => {
          if (!previous[id]) return previous;
          // Choosing a replacement (or restoring the original) does not
          // change the source pixels that were recognized. Keep that context;
          // moving the region or toggling protection must clear it.
          if (
            previous[id].status === "matched" &&
            !("logoRegion" in update) &&
            !("preserveLogo" in update)
          ) return previous;
          const next = { ...previous };
          delete next[id];
          return next;
        });
      }
      updateDraft(id, (draft) => {
        const options: StudioRepairOptions = { ...draft.options, ...update };
        // The engine intentionally rejects a replacement without an explicit
        // protected source region. Never leave an invalid replacement behind
        // while the user is toggling or redrawing the logo selection.
        if (
          options.preserveLogo !== true ||
          !validLogoRegion(options.logoRegion)
        ) {
          delete options.replacementLogo;
        }
        return { ...draft, options };
      });
    },
    [updateDraft],
  );

  const handleKeepLogo = useCallback(async (checked: boolean) => {
    if (!selectedDraft || applying) return;
    const id = selectedDraft.id;
    if (checked) keepOriginalLogoChoices.current.add(id);
    // "Keep" always means the source pixels, even if a clean replacement was
    // previously suggested. Toggling off also cancels any pending recognition.
    updateOptions(id, { preserveLogo: checked, replacementLogo: undefined });
    if (!checked) return;

    const requested = draftsRef.current[id];
    // A previously selected area is more authoritative than a fresh guess.
    if (!requested || validLogoRegion(draftLogoRegion(requested.options))) return;
    const region = boundedRegion(requested.region, image);
    if (!validRegion(region)) {
      setLogoRecognition((previous) => ({
        ...previous,
        [id]: { status: "error", reason: "Select a usable QR region before looking for a logo." },
      }));
      return;
    }

    const requestId = ++recognitionRequest.current;
    const signature = draftSignature(requested);
    const version = logoChoiceVersions.current[id] ?? 0;
    const isCurrent = () =>
      requestId === recognitionRequest.current &&
      openRef.current &&
      selectedIdRef.current === id &&
      !!draftsRef.current[id] &&
      draftSignature(draftsRef.current[id]) === signature &&
      (logoChoiceVersions.current[id] ?? 0) === version;
    setLogoRecognition((previous) => ({ ...previous, [id]: { status: "checking" } }));
    try {
      // Let the checkbox/checking state render before the bounded local search.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (!isCurrent()) return;
      const detected = await detectPopularQRLogo(image, region);
      if (!isCurrent()) return;
      if (detected.status !== "matched" || !validLogoRegion(detected.region)) {
        setLogoRecognition((previous) => ({
          ...previous,
          [id]: {
            status: detected.status === "matched" ? "uncertain" : detected.status,
            reason: "No reliable logo area found. Draw a rectangle around your logo.",
          },
        }));
        return;
      }
      updateOptions(id, {
        preserveLogo: true,
        logoRegion: { ...detected.region },
        replacementLogo: undefined,
      }, false);
      setLogoRecognition((previous) => ({
        ...previous,
        [id]: {
          status: "matched",
          brand: detected.brand,
          region: detected.region,
          reason: "Logo found. Original artwork kept; preview the fix before applying.",
        },
      }));
    } catch {
      if (!isCurrent()) return;
      setLogoRecognition((previous) => ({
        ...previous,
        [id]: { status: "error", reason: "Logo search is unavailable. Draw a rectangle around your logo instead." },
      }));
    } finally {
      // Unrelated draft edits can also make this result stale. Do not leave a
      // spinner behind, or clear a newer request's checking state.
      if (requestId === recognitionRequest.current) {
        setLogoRecognition((previous) => {
          if (previous[id]?.status !== "checking") return previous;
          const next = { ...previous };
          delete next[id];
          return next;
        });
      }
    }
  }, [applying, image, selectedDraft, updateOptions]);

  const selectDraft = (id: string) => {
    recognitionRequest.current += 1;
    setLogoRecognition((previous) => {
      if (!selectedId || previous[selectedId]?.status !== "checking") return previous;
      const next = { ...previous };
      delete next[selectedId];
      return next;
    });
    setSelectedId(id);
    setError(null);
  };

  const toggleQueue = (id: string, checked: boolean | "indeterminate") => {
    if (checked === "indeterminate") return;
    setQueueIds((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleMatchOriginal = () => {
    if (!selectedDraft) return;
    const sampled = sampleColors(image, selectedDraft.region);
    setSampledColors((previous) => ({ ...previous, [selectedDraft.id]: sampled.colors }));
    if (sampled.error) {
      setSampleError(sampled.error);
      return;
    }
    setSampleError(null);
    updateOptions(selectedDraft.id, sampled.colors);
  };

  const handleSuggestion = () => {
    if (!selectedDraft) return;
    try {
      const suggestion = suggestQRRepairColors(
        selectedDraft.options.dark,
        selectedDraft.options.light,
      ) as { dark?: string; light?: string };
      if (!suggestion.dark || !suggestion.light) {
        throw new Error("The color engine did not return a safe foreground/background pair.");
      }
      updateOptions(selectedDraft.id, { dark: suggestion.dark, light: suggestion.light });
      setError(null);
    } catch (suggestionError) {
      setError(
        suggestionError instanceof Error
          ? suggestionError.message
          : "Unable to suggest safe QR colors.",
      );
    }
  };

  const handleVerify = async () => {
    if (!selectedDraft) return;
    const signature = draftSignature(selectedDraft);
    if (!selectedDraft.options.payload.trim()) {
      setError("Enter the exact payload before verifying this manual recovery candidate.");
      return;
    }
    if (!validRegion(selectedDraft.region)) {
      setError("Select a non-empty QR region before verifying this draft.");
      return;
    }
    if (selectedDraft.options.preserveLogo) {
      const logoRegion = draftLogoRegion(selectedDraft.options);
      if (!validLogoRegion(logoRegion)) {
        setError(
          logoRegion
            ? "Logo coordinates must stay inside the QR crop before previewing."
            : "Keep my logo is on. Draw a logo rectangle in the QR crop before previewing.",
        );
        return;
      }
    }
    if (selectedDraft.options.preserveLogo && logoCropUnavailableId === selectedDraft.id) {
      setError("The selected logo crop could not be rendered. Choose another QR region or try again before previewing.");
      return;
    }
    if (
      !Number.isFinite(printScale) ||
      printScale <= 0 ||
      !Number.isFinite(printScaleY) ||
      printScaleY <= 0
    ) {
      setError("Final-size verification is unavailable until a valid print scale is provided.");
      return;
    }
    setVerifyingId(selectedDraft.id);
    setError(null);
    try {
      const result = await buildQRRepair(image, selectedDraft);
      const scaleResult = verifyQRRepairAtScale(result, { x: printScale, y: printScaleY });
      const scale: ScaleCheck = {
        verified: Boolean(scaleResult.verified),
        pixelsPerModule: scaleResult.pixelsPerModule,
        warning: scaleResult.warning,
      };
      // If a control changed while rendering, keep the old edits and do not
      // mark this now-stale render as tested.
      if (draftsRef.current[selectedDraft.id] && draftSignature(draftsRef.current[selectedDraft.id]) === signature) {
        setTested((previous) => ({
          ...previous,
          [selectedDraft.id]: { signature, printScale, printScaleY, result, scale },
        }));
      }
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : "Unable to verify this QR repair.");
      setTested((previous) => {
        if (!previous[selectedDraft.id]) return previous;
        const next = { ...previous };
        delete next[selectedDraft.id];
        return next;
      });
    } finally {
      setVerifyingId(null);
    }
  };

  const addManualDraft = () => {
    const region = boundedRegion(manualRegion, image);
    if (!validRegion(region)) {
      setError("Draw a QR region or enter a width and height before adding manual recovery.");
      return;
    }
    manualCounter.current += 1;
    const id = `manual-${manualCounter.current}`;
    const made = makeDraft(id, image, region, manualPayload, undefined);
    draftsRef.current = { ...draftsRef.current, [id]: made.draft };
    setDrafts((previous) => ({ ...previous, [id]: made.draft }));
    setSampledColors((previous) => ({ ...previous, [id]: made.sampled }));
    setEditedIds((previous) => new Set(previous).add(id));
    setSelectedId(id);
    setQueueIds((previous) => new Set(previous).add(id));
    if (made.sampleError) setSampleError(made.sampleError);
    setError(null);
  };

  const updateManualRegionField = (field: keyof QRRepairRegion, rawValue: string) => {
    const value = Number(rawValue);
    setManualRegion((previous) =>
      boundedRegion(
        { ...previous, [field]: Number.isFinite(value) ? value : 0 },
        image,
      ),
    );
  };

  const pointInArt = (event: React.PointerEvent<HTMLDivElement>, clampOutside = true) => {
    const element = artRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const currentDimensions = imageDimensions(image);
    if (!rect.width || !rect.height || !currentDimensions.width || !currentDimensions.height) return null;
    const content = {
      left: rect.left + (artContentRect.left / 100) * rect.width,
      top: rect.top + (artContentRect.top / 100) * rect.height,
      width: (artContentRect.width / 100) * rect.width,
      height: (artContentRect.height / 100) * rect.height,
    };
    if (!content.width || !content.height) return null;
    if (
      !clampOutside &&
      (event.clientX < content.left ||
        event.clientX > content.left + content.width ||
        event.clientY < content.top ||
        event.clientY > content.top + content.height)
    ) return null;
    return {
      x: clamp(((event.clientX - content.left) / content.width) * currentDimensions.width, 0, currentDimensions.width),
      y: clamp(((event.clientY - content.top) / content.height) * currentDimensions.height, 0, currentDimensions.height),
    };
  };

  const handleArtPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (applying) return;
    const point = pointInArt(event, false);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    manualPointerStart.current = point;
    setManualRegion({ x: rounded(point.x), y: rounded(point.y), width: 0, height: 0 });
  };

  const handleArtPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!manualPointerStart.current) return;
    const point = pointInArt(event);
    if (!point) return;
    const start = manualPointerStart.current;
    setManualRegion(
      boundedRegion(
        {
          x: Math.min(start.x, point.x),
          y: Math.min(start.y, point.y),
          width: Math.abs(point.x - start.x),
          height: Math.abs(point.y - start.y),
        },
        image,
      ),
    );
  };

  const handleArtPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!manualPointerStart.current) return;
    handleArtPointerMove(event);
    manualPointerStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const queueDrafts = useMemo(
    () => Array.from(queueIds).map((id) => drafts[id]).filter((draft): draft is QRRepairDraft => Boolean(draft)),
    [drafts, queueIds],
  );

  const applyReadiness = useMemo(() => {
    if (!queueDrafts.length) {
      return { ready: false, reason: "Select at least one pending repair." };
    }
    for (const draft of queueDrafts) {
      if (logoRecognition[draft.id]?.status === "checking") {
        return { ready: false, reason: "Checking a queued logo; wait for the logo check to finish." };
      }
      if (!draft.options.payload.trim()) {
        return { ready: false, reason: `${draft.id.startsWith("manual-") ? "Manual" : "Detected"} payload is empty.` };
      }
      if (draft.options.preserveLogo) {
        const logoRegion = draftLogoRegion(draft.options);
        if (!validLogoRegion(logoRegion)) {
          return {
            ready: false,
            reason: logoRegion
              ? "Logo coordinates must stay inside the QR crop before previewing or applying."
              : "Keep my logo is on; draw a logo rectangle before previewing or applying.",
          };
        }
      }
      if (draft.options.preserveLogo && logoCropUnavailableId === draft.id) {
        return { ready: false, reason: "The selected logo crop could not be rendered; preview it again before applying." };
      }
      const check = tested[draft.id];
      if (!check || check.signature !== draftSignature(draft)) {
        return { ready: false, reason: "Settings changed or not checked yet. Click Preview fix for each selected code." };
      }
      if (check.printScale !== printScale || check.printScaleY !== printScaleY) {
        return { ready: false, reason: "Print scale changed; verify every queued draft again." };
      }
      if (!check.result.verified || check.result.decodedPayload !== draft.options.payload) {
        return { ready: false, reason: "A queued draft did not digitally decode to its exact payload." };
      }
      if (!check.scale.verified) {
        return { ready: false, reason: check.scale.warning || "A queued draft fails final-size verification." };
      }
    }
    return { ready: true, reason: "All queued drafts are digitally and final-size verified." };
  }, [logoCropUnavailableId, logoRecognition, printScale, printScaleY, queueDrafts, tested]);

  const handleApply = async () => {
    if (!applyReadiness.ready || applying) return;
    setApplying(true);
    setError(null);
    try {
      await onApply(queueDrafts);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Unable to apply the verified QR repairs.");
    } finally {
      setApplying(false);
    }
  };

  const handleDialogChange = (nextOpen: boolean) => {
    if (!nextOpen && applying) return;
    if (!nextOpen) {
      recognitionRequest.current += 1;
      setLogoRecognition((previous) => {
        if (!selectedId || previous[selectedId]?.status !== "checking") return previous;
        const next = { ...previous };
        delete next[selectedId];
        return next;
      });
    }
    onOpenChange(nextOpen);
  };

  const displayedArtCodes = qrCodes;
  const selectedRegion = selectedDraft?.region ?? manualRegion;
  const selectedLogoRegion = selectedDraft ? draftLogoRegion(selectedDraft.options) : undefined;
  const selectedLogoRegionIsValid = validLogoRegion(selectedLogoRegion);
  const selectedReplacementLogo = selectedDraft
    ? draftReplacementLogo(selectedDraft.options)
    : undefined;
  const selectedLogoRecognition = selectedDraft
    ? logoRecognition[selectedDraft.id]
    : undefined;
  const selectedOriginalColors = selectedDraft ? sampledColors[selectedDraft.id] : undefined;
  const manualRegionIsValid = validRegion(manualRegion);
  const scanBusy = scanStatus.state === "scanning";

  return (
    <Dialog open={open} onOpenChange={handleDialogChange}>
      <DialogContent
        className="qr-repair-studio flex max-h-[92dvh] w-[min(96vw,980px)] max-w-none flex-col gap-0 overflow-hidden border-border bg-background p-0 text-foreground shadow-lg"
        onPointerDownOutside={(event) => {
          if (applying) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (applying) event.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border bg-card px-5 py-4 pr-12">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <DialogTitle className="flex items-center gap-2 text-lg text-foreground">
                <ScanLine className="h-5 w-5 text-primary" aria-hidden="true" />
                Fix QR code
              </DialogTitle>
              <DialogDescription className="mt-1 text-muted-foreground">
                Keep the original colors. We check the rebuilt code before anything is changed.
              </DialogDescription>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="rounded-full border border-sky-800/80 bg-sky-950/40 px-2.5 py-1">
                {Object.keys(drafts).length} code{Object.keys(drafts).length === 1 ? "" : "s"} found
              </span>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-4 p-4">
            <section className="rounded-xl border border-border bg-card p-3" aria-labelledby="detected-codes-heading">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2 id="detected-codes-heading" className="text-sm font-semibold text-white">Choose a code</h2>
                  <span className="text-xs text-slate-500">The first code is selected for you</span>
                </div>
                {Object.values(drafts).length === 0 ? (
                  <div className="rounded-lg border border-dashed border-sky-700/70 bg-sky-950/20 px-3 py-4">
                    <p className="text-sm font-medium text-slate-200">{scanBusy ? "Looking for a QR code…" : scanStatus.state === "complete" ? "We could not read a QR code." : "Select a QR code to fix."}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-400">Try another scan, or select the QR yourself and enter its exact URL or content. We never guess where a code goes.</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button type="button" variant="outline" className="border-sky-700 bg-sky-950/30 text-sky-100 hover:bg-sky-900/50" onClick={() => onScan(false)} disabled={applying || scanBusy}>Try again</Button>
                      <Button type="button" variant="outline" className="border-slate-700 bg-slate-900/50 text-slate-200 hover:bg-slate-800" onClick={() => document.getElementById("manual-recovery")?.setAttribute("open", "")} disabled={applying}>Select QR manually</Button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {Object.values(drafts).map((draft, index) => {
                      const active = draft.id === selectedId;
                      const draftTested =
                        tested[draft.id]?.signature === draftSignature(draft) &&
                        tested[draft.id]?.printScale === printScale &&
                        tested[draft.id]?.printScaleY === printScaleY;
                      return (
                        <div
                          key={draft.id}
                          className={cn(
                            "min-w-0 rounded-lg border p-2 transition-colors",
                             active ? "border-primary bg-primary/10" : "border-border bg-muted/30",
                          )}
                        >
                          <div className="flex items-start gap-2">
                            <Checkbox
                              id={`queue-${draft.id}`}
                              checked={queueIds.has(draft.id)}
                              onCheckedChange={(checked) => toggleQueue(draft.id, checked)}
                              disabled={applying}
                              className="mt-1 border-slate-600 data-[state=checked]:border-sky-400 data-[state=checked]:bg-sky-500"
                              aria-label={`Include ${isManualDraft(draft) ? "manual selection" : `QR code ${index + 1}`} when applying fixes`}
                            />
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e1a30]"
                              onClick={() => selectDraft(draft.id)}
                              disabled={applying}
                              aria-label={`Edit ${isManualDraft(draft) ? "manual recovery" : `detected QR code ${index + 1}`}`}
                            >
                              <span className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-200">
                                <span>{isManualDraft(draft) ? "Selected QR" : `QR code ${index + 1}`}</span>
                                {draftTested ? <Check className="h-3.5 w-3.5 text-emerald-400" aria-label="Verified draft" /> : null}
                              </span>
                              <span className="mt-1 block truncate text-[11px] text-slate-500">
                                {draft.options.payload || "No payload entered"}
                              </span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="mt-2 text-[11px] leading-4 text-slate-500">Check each code you want fixed. You can preview one at a time.</p>
            </section>

            <div className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]">
            <main className="min-w-0 space-y-4">
              <details id="qr-source-artwork" open={Object.values(drafts).length === 0} className="rounded-xl border border-slate-800 bg-[#0e1a30] p-3">
                <summary className="cursor-pointer text-sm font-medium text-slate-300">Show QR on artwork</summary>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div>
                    <h2 id="artwork-heading" className="text-sm font-semibold text-white">Your artwork</h2>
                    <p className="text-[11px] text-slate-500">The blue outline is the code being fixed.</p>
                  </div>
                  <ImageIcon className="h-4 w-4 text-slate-500" aria-hidden="true" />
                </div>
                <div
                  ref={artRef}
                  className="relative overflow-hidden rounded-lg border border-slate-700 bg-slate-950"
                  onPointerDown={handleArtPointerDown}
                  onPointerMove={handleArtPointerMove}
                  onPointerUp={handleArtPointerUp}
                  onPointerCancel={handleArtPointerUp}
                  role="application"
                  aria-label="Artwork region selector. Drag to select a manual QR region."
                >
                  {sourceUrl ? (
                    <img
                      ref={artImageRef}
                      src={sourceUrl}
                      alt="Full source artwork with QR detection bounds"
                      className="block h-auto max-h-[34vh] min-h-32 w-full select-none object-contain"
                      draggable={false}
                      onLoad={() => {
                        setArtLoadVersion((version) => version + 1);
                        measureArtRef.current();
                      }}
                    />
                  ) : (
                    <div className="flex h-40 items-center justify-center text-xs text-slate-500">Source artwork is not available.</div>
                  )}
                  <div
                    className="pointer-events-none absolute"
                    style={{
                      left: `${artContentRect.left}%`,
                      top: `${artContentRect.top}%`,
                      width: `${artContentRect.width}%`,
                      height: `${artContentRect.height}%`,
                    }}
                  >
                    {displayedArtCodes.map((code) => {
                      const safe = isSafeAutoDetection(code);
                      const active = Boolean(
                        safe &&
                        selectedDraft &&
                        bboxIoU(code.bbox, selectedDraft.region) >= 0.12,
                      );
                      return (
                        <div
                          key={qrId(code)}
                          className={cn(
                            "absolute rounded border-2",
                            !safe
                              ? "border-rose-300 bg-rose-300/10"
                              : active
                                ? "border-sky-300 bg-sky-300/10 shadow-[0_0_0_1px_rgba(56,189,248,0.45)]"
                                : "border-amber-300/80",
                          )}
                          style={{
                            left: `${(code.bbox.x / Math.max(1, dimensions.width)) * 100}%`,
                            top: `${(code.bbox.y / Math.max(1, dimensions.height)) * 100}%`,
                            width: `${(code.bbox.width / Math.max(1, dimensions.width)) * 100}%`,
                            height: `${(code.bbox.height / Math.max(1, dimensions.height)) * 100}%`,
                          }}
                          aria-hidden="true"
                        >
                          <span className={cn(
                            "absolute -top-5 left-0 rounded bg-slate-950/90 px-1.5 py-0.5 text-[10px] font-medium",
                            safe ? "text-sky-200" : "text-rose-200",
                          )}>
                            {safe ? `QR ${qrCodes.findIndex((candidate) => qrId(candidate) === qrId(code)) + 1}` : "Needs manual region"}
                          </span>
                        </div>
                      );
                    })}
                    {manualRegionIsValid && (
                      <div
                        className="absolute rounded border-2 border-dashed border-fuchsia-300 bg-fuchsia-300/10"
                        style={{
                          left: `${(manualRegion.x / Math.max(1, dimensions.width)) * 100}%`,
                          top: `${(manualRegion.y / Math.max(1, dimensions.height)) * 100}%`,
                          width: `${(manualRegion.width / Math.max(1, dimensions.width)) * 100}%`,
                          height: `${(manualRegion.height / Math.max(1, dimensions.height)) * 100}%`,
                        }}
                        aria-hidden="true"
                      />
                    )}
                    {selectedDraft?.options.preserveLogo && selectedLogoRegionIsValid ? (
                      <div
                        className="absolute rounded border-2 border-fuchsia-300 bg-fuchsia-300/20 shadow-[0_0_0_1px_rgba(232,121,249,0.35)]"
                        style={{
                          left: `${((selectedDraft.region.x + selectedLogoRegion!.x * selectedDraft.region.width) / Math.max(1, dimensions.width)) * 100}%`,
                          top: `${((selectedDraft.region.y + selectedLogoRegion!.y * selectedDraft.region.height) / Math.max(1, dimensions.height)) * 100}%`,
                          width: `${((selectedLogoRegion!.width * selectedDraft.region.width) / Math.max(1, dimensions.width)) * 100}%`,
                          height: `${((selectedLogoRegion!.height * selectedDraft.region.height) / Math.max(1, dimensions.height)) * 100}%`,
                        }}
                        aria-label="Selected logo source region"
                      >
                        <span className="absolute -top-5 left-0 rounded bg-slate-950/90 px-1.5 py-0.5 text-[10px] font-medium text-fuchsia-100">
                          Kept logo
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <div className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1.5 rounded bg-slate-950/85 px-2 py-1 text-[10px] text-slate-300">
                    <MousePointer2 className="h-3 w-3 text-fuchsia-300" aria-hidden="true" /> Draw a box only when selecting manually
                  </div>
                </div>
                {unsafeDetectionCount > 0 && (
                  <p role="alert" className="mt-2 flex items-start gap-1.5 rounded-lg border border-rose-400/30 bg-rose-950/25 px-2.5 py-2 text-[11px] leading-4 text-rose-200">
                    <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {unsafeDetectionCount} rotated or perspective QR {unsafeDetectionCount === 1 ? "detection was" : "detections were"} skipped for automatic repair. Repairs are upright squares; manual selection replaces every pixel in the selected region.
                  </p>
                )}
              </details>

              <section className="rounded-xl border border-slate-800 bg-[#0e1a30] p-3" aria-labelledby="preview-heading">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 id="preview-heading" className="text-sm font-semibold text-white">Before & after</h2>
                  {selectedDraft ? (
                    <span className="max-w-[55%] truncate text-xs text-slate-500">{selectedDraft.options.payload || "Manual payload required"}</span>
                  ) : null}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">Before</p>
                    <OriginalCropPreview image={image} region={selectedRegion} />
                  </div>
                  <div className="min-w-0">
                    <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-emerald-300/80">After</p>
                    <RebuiltPreview result={selectedTest?.result} />
                  </div>
                </div>
                <p className="mt-3 flex items-start gap-2 text-[11px] leading-4 text-slate-500">
                  <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-600" aria-hidden="true" />
                  The rebuild only targets the selected QR region; source artwork outside it is not edited.
                </p>
                {selectedDraft?.originalPayload?.trim() ? (
                  <p className="mt-2 text-[11px] font-medium text-emerald-200">
                    Original code scans. Rebuilding is optional.
                  </p>
                ) : null}
              </section>

              <section className="rounded-xl border border-slate-800 bg-[#0e1a30] p-3" aria-labelledby="verification-heading">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2 id="verification-heading" className="text-sm font-semibold text-white">Safety check</h2>
                  <span className="text-[11px] text-slate-500">Test a final print too.</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg border border-slate-800 bg-slate-950/45 px-3 py-2">
                    <div className="flex items-center gap-2 text-xs text-slate-300">
                      <StatusIcon ok={Boolean(selectedTest?.result.decodedPayload === selectedDraft?.options.payload)} untested={!selectedTest} pending={verifyingId === selectedId} />
                      Same destination
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {selectedTest ? (selectedTest.result.decodedPayload === selectedDraft?.options.payload ? "Matches the original exactly" : "Does not match") : "Preview fix to check"}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/45 px-3 py-2">
                    <div className="flex items-center gap-2 text-xs text-slate-300">
                      {selectedTest && selectedTest.result.contrastRatio < 4.5
                        ? <ShieldAlert className="h-4 w-4 text-amber-300" aria-hidden="true" />
                        : <StatusIcon ok={Boolean(selectedTest)} untested={!selectedTest} pending={verifyingId === selectedId} />}
                      Print contrast guidance
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {selectedTest ? (selectedTest.result.contrastRatio >= 4.5 ? "Color contrast passed" : "Low contrast — a print warning, not a failed scan.") : "Preview fix to check"}
                    </p>
                  </div>
                  <div className="hidden rounded-lg border border-slate-800 bg-slate-950/45 px-3 py-2">
                    <div className="flex items-center gap-2 text-xs text-slate-300">
                      <StatusIcon ok={Boolean(selectedTest?.result.moduleCount)} pending={verifyingId === selectedId} />
                      Module density
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {selectedTest ? `${selectedTest.result.moduleCount} modules · ${selectedTest.scale.pixelsPerModule.toFixed(2)} px/module final` : "Not tested"}
                    </p>
                  </div>
                </div>
                <div className="mt-2 rounded-lg border border-slate-800 bg-slate-950/45 px-3 py-2">
                  <div className="flex items-center gap-2 text-xs text-slate-300">
                    <StatusIcon ok={Boolean(selectedTest?.scale.verified)} untested={!selectedTest} pending={verifyingId === selectedId} />
                    <span>Ready at print size</span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {selectedTest?.scale.warning || (selectedTest ? (selectedTest.scale.verified ? "Passed at the final print size." : "This size is not safe to apply.") : "Preview fix to check the final print size.")}
                  </p>
                </div>
                {selectedTest?.result.warnings.length ? (
                  <div className="mt-2 space-y-1 rounded-lg border border-amber-400/20 bg-amber-950/20 px-3 py-2 text-[11px] leading-4 text-amber-200">
                    {selectedTest.result.warnings.map((warning, index) => <p key={`${warning}-${index}`}>{warning}</p>)}
                  </div>
                ) : null}
              </section>
            </main>

            <section className="min-w-0 space-y-4" aria-labelledby="settings-heading">
              <div className="rounded-xl border border-slate-800 bg-[#0e1a30] p-3">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 id="settings-heading" className="text-sm font-semibold text-white">Fix this code</h2>
                </div>
                {!selectedDraft ? (
                  <p className="rounded-lg border border-dashed border-slate-700 px-3 py-4 text-xs leading-5 text-slate-500">
                    Select a detected code or add a manual recovery candidate to edit repair settings.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {isManualDraft(selectedDraft) && <div>
                      <label htmlFor="qr-payload" className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-300">
                        {isManualDraft(selectedDraft) ? "Manual payload (exact, user provided)" : "Detected payload (read-only)"}
                        {!isManualDraft(selectedDraft) && <LockKeyhole className="h-3 w-3 text-slate-500" aria-hidden="true" />}
                      </label>
                      <Input
                        id="qr-payload"
                        value={selectedDraft.options.payload}
                        readOnly={!isManualDraft(selectedDraft)}
                        onChange={(event) => {
                          if (isManualDraft(selectedDraft)) updateOptions(selectedDraft.id, { payload: event.target.value });
                        }}
                        className="border-slate-700 bg-slate-950/70 text-xs text-slate-100 read-only:cursor-not-allowed read-only:opacity-80"
                        placeholder={isManualDraft(selectedDraft) ? "Enter the exact QR payload" : undefined}
                        aria-label={isManualDraft(selectedDraft) ? "Manual QR payload" : "Detected QR payload read-only"}
                      />
                      {isManualDraft(selectedDraft) ? (
                        <p className="mt-1 text-[11px] leading-4 text-amber-200/80">Manual recovery never guesses content. Enter the exact payload before verifying.</p>
                      ) : null}
                    </div>}

                    <p className="text-center text-[11px] text-muted-foreground">Original colors stay on by default.</p>

                    <div className="rounded-lg border border-fuchsia-400/25 bg-fuchsia-950/10 p-2.5">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="qr-preserve-logo"
                          checked={selectedDraft.options.preserveLogo}
                          onCheckedChange={(checked) => {
                            if (checked !== "indeterminate") void handleKeepLogo(checked);
                          }}
                          disabled={applying}
                          className="border-slate-600 data-[state=checked]:border-fuchsia-300 data-[state=checked]:bg-fuchsia-500"
                        />
                        <label htmlFor="qr-preserve-logo" className="text-xs font-medium text-slate-200">
                          Keep original logo
                        </label>
                      </div>
                      <p className="mt-1.5 text-[11px] leading-4 text-slate-400">
                        One protected area per code. We look for a supported logo and keep its original artwork. You can adjust the area.
                      </p>
                      <p className="mt-1 text-[11px] leading-4 text-amber-200/90">
                        If the code has multiple logos or artwork near its corners, review the rebuilt preview and safety check before applying.
                      </p>
                      {!selectedDraft.options.preserveLogo && selectedLogoRecognition ? (
                        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-slate-400" aria-live="polite">
                          {selectedLogoRecognition.status === "checking" ? (
                            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-sky-300" aria-hidden="true" />
                          ) : null}
                          <span>
                            {selectedLogoRecognition.status === "checking"
                              ? "Checking the source logo…"
                              : selectedLogoRecognition.status === "uncertain"
                                ? "Logo is uncertain. Keep the original or select its exact area."
                                : selectedLogoRecognition.status === "none"
                                  ? "No logo match found. Keep the original or select its exact area."
                                  : selectedLogoRecognition.reason || "Logo check unavailable."}
                          </span>
                        </p>
                      ) : null}
                      {selectedDraft.options.preserveLogo ? (
                        <LogoRegionSelector
                          image={image}
                          draftRegion={selectedDraft.region}
                          value={selectedLogoRegion}
                          onChange={(logoRegion) => updateOptions(selectedDraft.id, { logoRegion })}
                          onAvailabilityChange={handleLogoCropAvailability}
                          disabled={applying}
                        />
                      ) : null}
                      {selectedDraft.options.preserveLogo && !selectedLogoRegionIsValid ? (
                        <p role="status" aria-live="polite" className="mt-2 rounded-md border border-amber-400/25 bg-amber-950/20 px-2.5 py-2 text-[11px] leading-4 text-amber-200/90">
                          {selectedLogoRecognition?.status === "checking"
                            ? "Looking for a logo…"
                            : selectedLogoRecognition?.reason ||
                              "No reliable logo area found. Draw a rectangle around your logo."}
                        </p>
                      ) : null}
                      {selectedDraft.options.preserveLogo && selectedLogoRegionIsValid ? (
                        <div className="mt-3 space-y-2 rounded-lg border border-slate-800 bg-slate-950/35 p-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <label htmlFor="qr-logo-replacement" className="text-[11px] font-medium text-slate-300">
                              Logo replacement
                            </label>
                            {selectedLogoRecognition?.status === "checking" ? (
                              <span className="flex items-center gap-1 text-[10px] text-sky-300" aria-live="polite">
                                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                                Checking logo…
                              </span>
                            ) : null}
                          </div>
                          <Select
                            value={selectedReplacementLogo ?? KEEP_ORIGINAL_LOGO}
                            onValueChange={(value) => {
                              if (value === KEEP_ORIGINAL_LOGO) {
                                keepOriginalLogoChoices.current.add(selectedDraft.id);
                                updateOptions(selectedDraft.id, { replacementLogo: undefined });
                              } else {
                                keepOriginalLogoChoices.current.delete(selectedDraft.id);
                                updateOptions(selectedDraft.id, {
                                  replacementLogo: value as PopularQRLogoId,
                                });
                              }
                            }}
                            disabled={applying || selectedLogoRecognition?.status === "checking"}
                          >
                            <SelectTrigger
                              id="qr-logo-replacement"
                              className="h-9 border-slate-700 bg-slate-950/70 text-xs text-slate-100"
                              aria-label="Logo replacement"
                            >
                              <SelectValue placeholder="Keep original" />
                            </SelectTrigger>
                            <SelectContent className="qrs-select-popover border-slate-700 bg-[#0e1a30] text-slate-100">
                              <SelectItem value={KEEP_ORIGINAL_LOGO} className="text-xs focus:bg-slate-800 focus:text-white">
                                Keep original
                              </SelectItem>
                              {POPULAR_QR_LOGOS.map((logo) => (
                                <SelectItem key={logo.id} value={logo.id} className="text-xs focus:bg-slate-800 focus:text-white">
                                  <span className="inline-flex items-center gap-2">
                                    <span
                                      className="h-2.5 w-2.5 rounded-full"
                                      style={{ backgroundColor: logo.color }}
                                      aria-hidden="true"
                                    />
                                    {logo.label}
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {selectedLogoRecognition?.status === "matched" && selectedLogoRecognition.brand ? (
                            <p className="text-[11px] leading-4 text-emerald-200/90">
                              Recognized {popularLogoLabel(selectedLogoRecognition.brand)}.
                              {selectedReplacementLogo
                                ? ` Replacement: ${popularLogoLabel(selectedReplacementLogo)}.`
                                : " Original logo kept."}
                            </p>
                          ) : null}
                          {selectedLogoRecognition && selectedLogoRecognition.status !== "matched" && selectedLogoRecognition.status !== "checking" ? (
                            <p className="text-[11px] leading-4 text-slate-400">
                              {selectedLogoRecognition.status === "uncertain"
                                ? "Logo is uncertain. Keep the original or choose a replacement only if you know it."
                                : selectedLogoRecognition.status === "none"
                                  ? "No logo match found. Keep the original or choose a replacement manually."
                                  : selectedLogoRecognition.reason || "Logo check unavailable."}
                            </p>
                          ) : null}
                          <p className="text-[10px] leading-4 text-slate-500">
                            A replacement may differ from the source logo’s appearance and colors.
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              className="h-8 border-sky-800/70 bg-sky-950/25 px-2.5 text-[11px] text-sky-100 hover:bg-sky-900/50"
                              onClick={() => void handleCheckLogo()}
                              disabled={applying || selectedLogoRecognition?.status === "checking"}
                            >
                              <ScanLine className="h-3.5 w-3.5" aria-hidden="true" />
                              Check logo
                            </Button>
                            {selectedReplacementLogo ? (
                              <Button
                                type="button"
                                variant="ghost"
                                className="h-8 px-2 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-white"
                                onClick={() => {
                                  keepOriginalLogoChoices.current.add(selectedDraft.id);
                                  updateOptions(selectedDraft.id, { replacementLogo: undefined });
                                }}
                                disabled={applying}
                              >
                                Restore original
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <details className="rounded-lg border border-slate-800 bg-slate-950/25 p-3">
                      <summary className="cursor-pointer text-xs font-medium text-slate-300">Advanced options: colors and scan settings</summary>
                      <div className="mt-3 space-y-3">
                    {!isManualDraft(selectedDraft) && (
                      <div>
                        <label htmlFor="qr-payload" className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-300">
                          Detected content (read-only)
                          <LockKeyhole className="h-3 w-3 text-slate-500" aria-hidden="true" />
                        </label>
                        <Input
                          id="qr-payload"
                          value={selectedDraft.options.payload}
                          readOnly
                          className="border-slate-700 bg-slate-950/70 text-xs text-slate-100 read-only:cursor-not-allowed read-only:opacity-80"
                          aria-label="Detected QR payload read-only"
                        />
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label htmlFor="qr-dark-color" className="mb-1.5 block text-xs font-medium text-slate-300">Foreground color</label>
                        <div className="flex gap-1.5">
                          <input
                            id="qr-dark-color"
                            type="color"
                            value={colorInputValue(selectedDraft.options.dark)}
                            onChange={(event) => updateOptions(selectedDraft.id, { dark: event.target.value })}
                            className="h-10 w-10 cursor-pointer rounded-md border border-slate-700 bg-slate-950 p-1"
                            aria-label="Foreground color picker"
                            disabled={applying}
                          />
                          <Input
                            value={selectedDraft.options.dark}
                            onChange={(event) => updateOptions(selectedDraft.id, { dark: event.target.value })}
                            className="min-w-0 border-slate-700 bg-slate-950/70 px-2 text-xs"
                            aria-label="Foreground color value"
                            disabled={applying}
                          />
                        </div>
                      </div>
                      <div>
                        <label htmlFor="qr-light-color" className="mb-1.5 block text-xs font-medium text-slate-300">Background color</label>
                        <div className="flex gap-1.5">
                          <input
                            id="qr-light-color"
                            type="color"
                            value={colorInputValue(selectedDraft.options.light)}
                            onChange={(event) => updateOptions(selectedDraft.id, { light: event.target.value })}
                            className="h-10 w-10 cursor-pointer rounded-md border border-slate-700 bg-slate-950 p-1"
                            aria-label="Background color picker"
                            disabled={applying}
                          />
                          <Input
                            value={selectedDraft.options.light}
                            onChange={(event) => updateOptions(selectedDraft.id, { light: event.target.value })}
                            className="min-w-0 border-slate-700 bg-slate-950/70 px-2 text-xs"
                            aria-label="Background color value"
                            disabled={applying}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 border-slate-700 bg-slate-950/50 px-2 text-[11px] text-slate-200 hover:bg-slate-800 hover:text-white"
                        onClick={handleMatchOriginal}
                        disabled={applying}
                        aria-label="Match original QR colors"
                      >
                        <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
                        Match original
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 border-sky-800/70 bg-sky-950/30 px-2 text-[11px] text-sky-100 hover:bg-sky-900/50 hover:text-white"
                        onClick={handleSuggestion}
                        disabled={applying}
                        aria-label="Suggest safe similar QR colors"
                      >
                        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                        Boost contrast
                      </Button>
                    </div>
                    <p className="text-[11px] text-slate-400">Boost contrast changes colors. Match original restores sampled colors. After any color adjustment, click Preview fix to check again.</p>
                    {selectedOriginalColors ? (
                      <p className="text-[11px] text-slate-500">Original sample: {selectedOriginalColors.dark} on {selectedOriginalColors.light}</p>
                    ) : null}

                    <div>
                      <label htmlFor="qr-ecc" className="mb-1.5 block text-xs font-medium text-slate-300">Error correction</label>
                      <Select
                        value={selectedDraft.options.errorCorrectionLevel}
                        onValueChange={(value) => updateOptions(selectedDraft.id, { errorCorrectionLevel: value as QRRepairOptions["errorCorrectionLevel"] })}
                        disabled={applying}
                      >
                        <SelectTrigger id="qr-ecc" className="border-slate-700 bg-slate-950/70 text-xs text-slate-100" aria-label="Error correction level">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="qrs-select-popover border-slate-700 bg-[#0e1a30] text-slate-100">
                          {(["L", "M", "Q", "H"] as const).map((level) => (
                            <SelectItem key={level} value={level} className="text-xs focus:bg-slate-800 focus:text-white">
                              {level} — {level === "L" ? "7%" : level === "M" ? "15%" : level === "Q" ? "25%" : "30%"} recovery
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <label htmlFor="qr-quiet-zone" className="text-xs font-medium text-slate-300">Quiet zone</label>
                        <span className="text-xs font-semibold text-sky-200">{selectedDraft.options.quietZone} modules</span>
                      </div>
                      <input
                        id="qr-quiet-zone"
                        type="range"
                        min={4}
                        max={8}
                        step={1}
                        value={selectedDraft.options.quietZone}
                        onChange={(event) => updateOptions(selectedDraft.id, { quietZone: Number(event.target.value) })}
                        className="h-2 w-full cursor-pointer accent-sky-400"
                        disabled={applying}
                        aria-label="Quiet zone modules, from 4 to 8"
                      />
                      <div className="flex justify-between text-[10px] text-slate-600"><span>4</span><span>8</span></div>
                    </div>

                      </div>
                    </details>
                  </div>
                )}
              </div>

              <details id="manual-recovery" open={Object.values(drafts).length === 0} className="rounded-xl border border-fuchsia-400/20 bg-fuchsia-950/10 p-3" aria-labelledby="manual-heading">
                <summary onClick={() => document.getElementById("qr-source-artwork")?.setAttribute("open", "")} className="cursor-pointer text-sm font-semibold text-white">Select a QR manually</summary>
                <div className="mb-2 flex items-center gap-2">
                  <h2 id="manual-heading" className="sr-only">Manual recovery</h2>
                </div>
                <p className="mb-3 text-[11px] leading-4 text-slate-400">
                  Draw a box on the artwork, then enter the exact URL or content. We never infer it.
                </p>
                <p className="mb-3 flex items-start gap-1.5 rounded-lg border border-amber-400/25 bg-amber-950/20 px-2.5 py-2 text-[11px] leading-4 text-amber-200/90">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Repairs render upright squares and replace every pixel inside the selected region. Select only the QR patch.
                </p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-slate-400">Enter box coordinates instead</summary>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(["x", "y", "width", "height"] as const).map((field) => (
                    <div key={field}>
                      <label htmlFor={`manual-${field}`} className="mb-1 block text-[11px] capitalize text-slate-400">{field}</label>
                      <Input
                        id={`manual-${field}`}
                        type="number"
                        min={0}
                        max={field === "x" ? dimensions.width : field === "y" ? dimensions.height : undefined}
                        step={1}
                        value={manualRegion[field]}
                        onChange={(event) => updateManualRegionField(field, event.target.value)}
                        className="h-8 border-slate-700 bg-slate-950/70 text-xs"
                        disabled={applying}
                        aria-label={`Manual region ${field} in source pixels`}
                      />
                    </div>
                  ))}
                </div>
                </details>
                <div className="mt-2">
                  <label htmlFor="manual-payload" className="mb-1 block text-[11px] text-slate-400">Exact payload (user provided)</label>
                  <Input
                    id="manual-payload"
                    value={manualPayload}
                    onChange={(event) => setManualPayload(event.target.value)}
                    className="border-slate-700 bg-slate-950/70 text-xs"
                    placeholder="Paste the exact URL or content"
                    disabled={applying}
                    aria-label="Manual recovery exact payload"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3 w-full border-fuchsia-400/40 bg-fuchsia-950/20 text-fuchsia-100 hover:bg-fuchsia-900/40 hover:text-white"
                  onClick={addManualDraft}
                  disabled={applying || !manualRegionIsValid}
                  aria-label="Add manual QR recovery candidate to repair queue"
                >
                  <MousePointer2 aria-hidden="true" />
                  Use this selected QR
                </Button>
              </details>
            </section>
            </div>

            <details open={scanBusy} className="rounded-xl border border-slate-800 bg-[#0e1a30] p-3">
                <summary className="cursor-pointer text-xs font-medium text-slate-300">Scan and diagnostics</summary>
              <div className="mt-3 flex flex-wrap items-center gap-2" aria-live="polite">
                <Button type="button" variant="outline" className="border-slate-700 bg-slate-900/50 text-slate-200 hover:bg-slate-800 hover:text-white" onClick={() => onScan(false)} disabled={applying || scanBusy}>Scan again</Button>
                <Button type="button" variant="outline" className="border-sky-700/70 bg-sky-950/30 text-sky-100 hover:bg-sky-900/50 hover:text-white" onClick={() => onScan(true)} disabled={applying || scanBusy}>Deep scan</Button>
                {scanBusy && <Button type="button" variant="ghost" className="text-rose-300 hover:bg-rose-950/30 hover:text-rose-200" onClick={onCancelScan} disabled={applying}>Cancel scan</Button>}
                <span className="text-xs text-slate-500">{scanBusy ? "Looking for codes…" : `${scanStatusLabel(scanStatus.state)}${scanStatus.message ? ` — ${scanStatus.message}` : ""}`}</span>
              </div>
            </details>
          </div>
        </div>

        <DialogFooter className="qr-repair-actions shrink-0 flex-row flex-wrap items-center justify-between gap-2 border-t border-border bg-card px-3 py-2 sm:gap-3 sm:px-5 sm:py-3">
          <div className={`min-w-0 flex-1 text-xs ${error || sampleError ? "max-sm:basis-full" : "max-sm:sr-only"}`} aria-live="polite">
            {error ? (
              <p className="flex items-start gap-1.5 text-rose-300"><ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> <span>{error}</span></p>
            ) : sampleError ? (
              <p className="flex items-start gap-1.5 text-amber-200"><ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> <span>Original color sample unavailable: {sampleError}</span></p>
            ) : (
                <p className="truncate text-slate-500" title={applyReadiness.reason}>{applyReadiness.ready ? "Ready to apply the verified fix." : applyReadiness.reason.replaceAll("queued", "selected")}</p>
            )}
          </div>
          <div className="flex w-full min-w-0 flex-wrap justify-end gap-2 sm:w-auto sm:shrink-0">
            <Button
              type="button"
              className="min-w-0 max-sm:flex-1 max-sm:gap-1 max-sm:px-1 max-sm:text-[11px] bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={handleVerify}
              disabled={!selectedDraft || applying || verifyingId !== null}
              aria-label="Preview fix and verify QR repair"
            >
              {verifyingId ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {verifyingId ? "Checking…" : "Preview fix"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-w-0 max-sm:flex-1 max-sm:gap-1 max-sm:px-1 max-sm:text-[11px] border-slate-700 bg-slate-900/60 text-slate-200 hover:bg-slate-800 hover:text-white"
              onClick={() => handleDialogChange(false)}
              disabled={applying}
              aria-label="Cancel QR repair studio"
            >
              Close
            </Button>
            <Button
              type="button"
              className="min-w-0 max-sm:flex-1 max-sm:gap-1 max-sm:px-1 max-sm:text-[11px] bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={handleApply}
              disabled={applying || !applyReadiness.ready}
              aria-label="Apply verified QR repairs"
            >
              {applying ? <Loader2 className="animate-spin" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
              {applying ? "Applying…" : "Apply fix"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default QRRepairStudio;
