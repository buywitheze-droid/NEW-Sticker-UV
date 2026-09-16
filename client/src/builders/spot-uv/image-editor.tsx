import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import UploadSection from "./upload-section";
import PreviewSection from "./preview-section";
import ControlsSection, { SpotPreviewData } from "./controls-section";
import type { ExtractedColor } from "./lib/color-extractor";
import { calculateImageDimensions, downloadCanvas } from "./lib/image-utils";
import { cropCanvasToContent, cropImageToContent } from "./lib/image-crop";
import { createVectorStroke, downloadVectorStroke, createVectorPaths, type VectorFormat } from "./lib/vector-stroke";
import { checkCadCutBounds, type CadCutBounds } from "./lib/cadcut-bounds";
import { downloadContourPDF, downloadDesignOnlyPDF, type CachedContourData, type SpotColorInput } from "./lib/contour-outline";
import { getContourWorkerManager, processContourInWorker, type DetectedAlgorithm, type DetectedShapeInfo } from "./lib/contour-worker-manager";
import { downloadShapePDF, calculateShapeDimensions, generateShapePathPointsInches } from "./lib/shape-outline";
import GangSheetPanel from "./gang-sheet-panel";
import type { GangSheetItem, GangSheetSettings } from "./lib/gang-sheet";
import { DEFAULT_GANG_SHEET_SETTINGS, clampGangSheetQuantity, expandSettingsToFit, packGangSheet, maxQuantityForItem } from "./lib/gang-sheet";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { removeBackgroundFromCanvas } from "@/lib/background-removal";
import { detectQRsInImage } from "./lib/qr";
import QRRepairStudio from "./qr-repair-studio";
import { applyQRRepairs, verifyQRRepairPixels } from "./lib/qr-repair";
import { scaleQRRepairDrafts } from "./lib/qr-repair-geometry";
import type { QRRepairDraft } from "./lib/qr-repair-types";
import { parsePDF, type ParsedPDFData } from "./lib/pdf-parser";
import type { ParsedSVGData } from "./lib/svg-parser";
import { detectShape, mapDetectedShapeToType } from "./lib/shape-detection";
import { useToast } from "@/hooks/use-toast";
import { trimVectorImport } from "./lib/vector-trim";
import { getUpscaleManager, resolveUpscaleScale } from "@/lib/upscale-manager";
import { ownUploadedBytes, type PreparedRaster } from "@/lib/prepare-raster-upload";
import { useSearch, useLocation } from "wouter";
import { useAuth, getErrorMessage } from "@/hooks/use-auth";
import { useDesignMutations, type DesignSummary } from "@/hooks/use-designs";
import type { AdminDesignDetail } from "@/hooks/use-admin";
import { serializeDesign, matchSpotTagsToColors, uploadAsset, fetchAssetAsFile, fetchAssetAsFileForAdmin } from "@/lib/design-document";
import { apiRequest } from "@/lib/queryClient";
import type { SerializedDesign } from "@shared/design-document";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { measureContentBox } from "./lib/content-bounds";
import {
  SPOT_UV_PREVIEW_MAX_EDGE,
  canvasToPngImage,
  commitSpotUvEdit,
  drawCappedPreview,
  eraseConnectedColorOnCanvas,
  resolveSpotUvPrintImage,
} from "./lib/print-preview";

export type { ImageInfo, StrokeSettings, StrokeMode, ResizeSettings, ShapeSettings, StickerSize, LockedContour, SegmentLayer, SegmentationData } from "./lib/types";
import { STICKER_SIZES, type ImageInfo, type StrokeSettings, type StrokeMode, type ResizeSettings, type ShapeSettings, type StickerSize, type LockedContour, type SegmentLayer, type SegmentationData } from "./lib/types";

const MAX_UPLOAD_SIZE_INCHES = 24;

function fitUploadedDimensions(widthInches: number, heightInches: number) {
  const longestEdge = Math.max(widthInches, heightInches);
  if (!(longestEdge > MAX_UPLOAD_SIZE_INCHES)) {
    return { widthInches, heightInches };
  }
  const scale = MAX_UPLOAD_SIZE_INCHES / longestEdge;
  return {
    widthInches: Number((widthInches * scale).toFixed(2)),
    heightInches: Number((heightInches * scale).toFixed(2)),
  };
}

function fittingStickerSize(widthInches: number, heightInches: number): StickerSize {
  const longestEdge = Math.max(widthInches, heightInches);
  return STICKER_SIZES.find(({ value }) => value >= longestEdge)?.value ?? 24;
}

export default function ImageEditor({
  onDesignUploaded,
  mode = "individual",
  enableSpotColors,
}: {
  onDesignUploaded?: () => void;
  mode?: "individual" | "gangsheet";
  enableSpotColors?: boolean;
} = {}) {
  const spotsEnabled = enableSpotColors ?? mode === "individual";
  const { toast } = useToast();
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [cadCutBounds, setCadCutBounds] = useState<CadCutBounds | null>(null);
  const [strokeSettings, setStrokeSettings] = useState<StrokeSettings>({
    width: 0.14, // Default large offset
    color: "#ffffff",
    enabled: false,
    alphaThreshold: 128, // Auto-detected from alpha channel
    backgroundColor: "#ffffff", // Default white background for contour
    useCustomBackground: true, // Default to solid background color
    cornerMode: 'rounded',
    autoBridging: true, // Auto-bridge narrow gaps in contour
    autoBridgingThreshold: 0.02, // Gap threshold in inches
    contourMode: undefined,
    includeHoles: false,
  });
  const [resizeSettings, setResizeSettings] = useState<ResizeSettings>({
    widthInches: 5.0,
    heightInches: 3.8,
    maintainAspectRatio: true,
    outputDPI: 300,
  });
  const [shapeSettings, setShapeSettings] = useState<ShapeSettings>({
    enabled: false,
    type: 'square',
    offset: 0.25, // Default "Big" offset around design
    fillColor: '#FFFFFF',
    strokeEnabled: false,
    strokeWidth: 2,
    strokeColor: '#000000',
    cornerRadius: 0.25, // Default corner radius for rounded shapes (in inches)
    bleedEnabled: false, // Color bleed outside the shape
    bleedColor: '#FFFFFF', // Default bleed color
  });
  const [strokeMode, setStrokeMode] = useState<StrokeMode>('none');
  const [stickerSize, setStickerSize] = useState<StickerSize>(4); // Default 4 inch max dimension
  const [isProcessing, setIsProcessing] = useState(false);
  const [qrStudioOpen, setQrStudioOpen] = useState(false);
  const [qrScanStatus, setQrScanStatus] = useState<{
    state: "idle" | "scanning" | "complete" | "cancelled" | "error";
    message: string;
  }>({ state: "idle", message: "Ready to scan." });
  const qrSourceRef = useRef(imageInfo);
  qrSourceRef.current = imageInfo;
  const qrApplyingRef = useRef(false);
  const [isRemovingBackground, setIsRemovingBackground] = useState(false);
  const [magicWandMode, setMagicWandMode] = useState(false);
  const [magicWandTolerance, setMagicWandTolerance] = useState(0.08); // 0..1
  const [isMagicWandRunning, setIsMagicWandRunning] = useState(false);
  const [spotPreviewData, setSpotPreviewData] = useState<SpotPreviewData>({ enabled: false, colors: [] });
  const spotPreviewDataRef = useRef(spotPreviewData);
  spotPreviewDataRef.current = spotPreviewData;
  const [spotColorRestore, setSpotColorRestore] = useState<{ colors: ExtractedColor[]; id: number; spotWhiteName?: string; spotGlossName?: string } | null>(null);
  const [highlightedColor, setHighlightedColor] = useState<{ colorIndex: number; regionId: number | null } | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [detectedAlgorithm, setDetectedAlgorithm] = useState<DetectedAlgorithm | undefined>(undefined);
  const [detectedShapeType, setDetectedShapeType] = useState<'circle' | 'oval' | 'square' | 'rectangle' | null>(null);
  const [detectedShapeInfo, setDetectedShapeInfo] = useState<DetectedShapeInfo | null>(null);
  const [cutContourLabel, setCutContourLabel] = useState<'CutContour' | 'PerfCutContour' | 'KissCut'>('CutContour');
  const [lockedContour, setLockedContour] = useState<LockedContour | null>(null);
  const [segmentationData, setSegmentationData] = useState<SegmentationData>({
    enabled: false,
    layers: [],
    mode: 'colors',
  });
  const [isSegmenting, setIsSegmenting] = useState(false);
  const [isUpscaling, setIsUpscaling] = useState(false);
  const qualityPreviewRef = useRef<{
    image: HTMLImageElement;
    resolve: () => void;
    reject: (error: Error) => void;
    settleTimer?: ReturnType<typeof setTimeout>;
  } | null>(null);
  const handlePreviewStatus = useCallback((
    image: HTMLImageElement,
    status: 'processing' | 'ready' | 'error',
    error?: Error,
  ) => {
    const pending = qualityPreviewRef.current;
    if (!pending || pending.image !== image) return;
    if (status !== 'ready') {
      clearTimeout(pending.settleTimer);
      pending.settleTimer = undefined;
      if (status === 'error') pending.reject(error ?? new Error('Could not update the contour preview.'));
    } else if (!pending.settleTimer) {
      // Allow debounced margin/shape changes to settle before revealing the
      // enhanced image. A new contour request cancels this ready window.
      pending.settleTimer = setTimeout(pending.resolve, 350);
    }
  }, []);
  useEffect(() => () => {
    const pending = qualityPreviewRef.current;
    if (pending) {
      clearTimeout(pending.settleTimer);
      pending.reject(new Error('Editor closed while updating the preview.'));
      qualityPreviewRef.current = null;
    }
  }, []);
  const [enhanceStage, setEnhanceStage] = useState('');
  const [noCutlinesDialog, setNoCutlinesDialog] = useState<{
    pending: boolean;
    args: { downloadType: string; format: VectorFormat; spotColors?: SpotColorInput[]; singleArtboard: boolean } | null;
  }>({ pending: false, args: null });
  const [gangSheetItems, setGangSheetItems] = useState<GangSheetItem[]>([]);
  const [gangSheetOpen, setGangSheetOpen] = useState(false);
  const [gangSheetSettings, setGangSheetSettings] = useState<GangSheetSettings>(DEFAULT_GANG_SHEET_SETTINGS);
  const [spotPaintMode, setSpotPaintMode] = useState<'white' | 'gloss' | 'both' | 'clear' | null>(null);
  const [pendingSpotPaint, setPendingSpotPaint] = useState<{ colorIndex: number; regionId: number | null; mode: string; id: number } | null>(null);

  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const designMutations = useDesignMutations();
  const [currentDesignId, setCurrentDesignId] = useState<number | null>(null);
  const [currentDesignName, setCurrentDesignName] = useState<string>("Untitled design");
  const [sourceAssetId, setSourceAssetId] = useState<number | null>(null);
  const [isSavingDesign, setIsSavingDesign] = useState(false);
  const [saveNameDialog, setSaveNameDialog] = useState<{ open: boolean; mode: "save" | "save-as-new" | null }>({ open: false, mode: null });
  const [saveNameValue, setSaveNameValue] = useState("");
  const pendingSpotTagsRef = useRef<SerializedDesign["spotColors"]["tags"] | null>(null);
  const pendingSegmentTagsRef = useRef<SerializedDesign["segmentation"]["layers"] | null>(null);
  const openedDesignParamRef = useRef<string | null>(null);
  const searchParams = useSearch();
  const [isLoadingDesign, setIsLoadingDesign] = useState(() => {
    const p = new URLSearchParams(searchParams);
    return p.get("design") !== null || p.get("adminView") !== null;
  });
  const [isReadOnlyView, setIsReadOnlyView] = useState(false);
  const [readOnlyOwnerEmail, setReadOnlyOwnerEmail] = useState<string | null>(null);
  const [readOnlyOriginalId, setReadOnlyOriginalId] = useState<number | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Undo/Redo history
  interface EditorSnapshot {
    strokeSettings: StrokeSettings;
    resizeSettings: ResizeSettings;
    shapeSettings: ShapeSettings;
    spotColors: SpotPreviewData;
    imageInfo: ImageInfo | null;
  }
  const historyRef = useRef<EditorSnapshot[]>([]);
  const historyIndexRef = useRef(-1);
  const isRestoringRef = useRef(false);
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const pushSnapshot = useCallback((imageOverride?: ImageInfo) => {
    if (isRestoringRef.current) return;
    const snap: EditorSnapshot = {
      strokeSettings: { ...strokeSettings },
      resizeSettings: { ...resizeSettings },
      shapeSettings: { ...shapeSettings },
      spotColors: { ...spotPreviewData, colors: spotPreviewData.colors.map(c => ({ ...c, regions: c.regions?.map(r => ({ ...r })) })) },
      imageInfo: imageOverride ? { ...imageOverride } : imageInfo ? { ...imageInfo } : null,
    };
    const idx = historyIndexRef.current;
    const prev = idx >= 0 ? historyRef.current[idx] : null;
    if (prev) {
      // Pixel edits trigger color/region extraction. Unselected regions are
      // derived metadata, not separate user actions that should consume Undo.
      const spotIntent = (data: SpotPreviewData) => JSON.stringify({
        whiteName: data.spotWhiteName,
        glossName: data.spotGlossName,
        colors: data.colors.flatMap(c => {
          const flags = [c.spotWhite, c.spotGloss, c.spotFluorY, c.spotFluorM, c.spotFluorG, c.spotFluorOrange].map(Boolean);
          const regions = c.regions?.filter(r => r.spotWhite || r.spotGloss)
            .map(r => [r.id, !!r.spotWhite, !!r.spotGloss]) ?? [];
          return flags.some(Boolean) || regions.length ? [{ hex: c.hex, flags, regions }] : [];
        }),
      });
      const sameSpot = spotIntent(prev.spotColors) === spotIntent(snap.spotColors);
      const sameStroke = JSON.stringify(prev.strokeSettings) === JSON.stringify(snap.strokeSettings);
      const sameGeometry = JSON.stringify(prev.resizeSettings) === JSON.stringify(snap.resizeSettings) &&
        JSON.stringify(prev.shapeSettings) === JSON.stringify(snap.shapeSettings);
      const samePixels = prev.imageInfo?.image === snap.imageInfo?.image;
      if (sameSpot && sameStroke && samePixels && sameGeometry) {
        return;
      }
    }
    historyRef.current = historyRef.current.slice(0, idx + 1);
    historyRef.current.push(snap);
    if (historyRef.current.length > 50) historyRef.current.shift();
    historyIndexRef.current = historyRef.current.length - 1;
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(false);
  }, [strokeSettings, resizeSettings, shapeSettings, spotPreviewData, imageInfo]);

  // Debounced snapshot: batch rapid changes into one history entry
  useEffect(() => {
    if (isRestoringRef.current) return;
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = setTimeout(() => {
      pushSnapshot();
    }, 600);
    return () => { if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current); };
  }, [strokeSettings, resizeSettings, shapeSettings, spotPreviewData, imageInfo, pushSnapshot]);

  const restoreSnapshot = useCallback((snap: EditorSnapshot) => {
    setStrokeSettings(snap.strokeSettings);
    setResizeSettings(snap.resizeSettings);
    setShapeSettings(snap.shapeSettings);
    setSpotPreviewData(snap.spotColors);
    setSpotColorRestore({ colors: snap.spotColors.colors, id: Date.now(), spotWhiteName: snap.spotColors.spotWhiteName, spotGlossName: snap.spotColors.spotGlossName });
    const imageChanged = snap.imageInfo?.image?.src !== imageInfo?.image?.src;
    if (imageChanged && snap.imageInfo !== undefined) {
      setImageInfo(snap.imageInfo);
      const workerManager = getContourWorkerManager();
      workerManager.clearCache();
      setCadCutBounds(null);
    }
  }, [imageInfo]);

  const handleUndo = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    isRestoringRef.current = true;
    historyIndexRef.current--;
    const snap = historyRef.current[historyIndexRef.current];
    restoreSnapshot(snap);
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(true);
    requestAnimationFrame(() => { isRestoringRef.current = false; });
  }, [restoreSnapshot]);

  const handleRedo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    isRestoringRef.current = true;
    historyIndexRef.current++;
    const snap = historyRef.current[historyIndexRef.current];
    restoreSnapshot(snap);
    setCanUndo(true);
    setCanRedo(historyIndexRef.current < historyRef.current.length - 1);
    requestAnimationFrame(() => { isRestoringRef.current = false; });
  }, [restoreSnapshot]);

  const setHighlightWithTimer = useCallback((color: { colorIndex: number; regionId: number | null } | null) => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedColor(color);
    if (color) {
      highlightTimerRef.current = setTimeout(() => {
        setHighlightedColor(null);
        highlightTimerRef.current = null;
      }, 3000);
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && spotPaintMode) {
        setSpotPaintMode(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [spotPaintMode]);

  // Debounced settings for heavy processing
  const debouncedStrokeSettings = useDebouncedValue(strokeSettings, 100);
  const debouncedResizeSettings = useDebouncedValue(resizeSettings, 250); // Higher debounce for size changes
  const debouncedShapeSettings = useDebouncedValue(shapeSettings, 100);

  // Function to update CadCut bounds checking - accepts shape settings to avoid stale closure
  const updateCadCutBounds = useCallback((
    shapeWidthInches: number, 
    shapeHeightInches: number,
    currentShapeSettings: ShapeSettings
  ) => {
    if (!imageInfo) {
      setCadCutBounds(null);
      return;
    }

    // Convert inches to pixels for bounds checking
    const shapeWidthPixels = shapeWidthInches * imageInfo.dpi;
    const shapeHeightPixels = shapeHeightInches * imageInfo.dpi;

    const bounds = checkCadCutBounds(
      imageInfo.image,
      currentShapeSettings,
      shapeWidthPixels,
      shapeHeightPixels
    );

    setCadCutBounds(bounds);
  }, [imageInfo]);

  useEffect(() => {
    if (imageInfo && onDesignUploaded) {
      onDesignUploaded();
    }
  }, [imageInfo, onDesignUploaded]);

  // Keep `strokeSettings.width` aligned with the option list that the Contour
  // Margin dropdown will actually render. The list narrows when
  // `detectedAlgorithm` flips to 'scattered' (smaller margins look cluttered
  // on multi-blob designs, and Zero Hero in particular produces dozens of
  // tiny per-component outlines). If the saved width isn't in the new list,
  // shadcn's <Select> renders an empty box — that's the bug we're fixing.
  // We snap to the closest valid option whenever the algorithm transitions.
  useEffect(() => {
    const validForScattered = [0.07, 0.14, 0.25];
    const validForComplex = [0, 0.02, 0.04, 0.07, 0.14, 0.25];
    const valid = detectedAlgorithm === 'scattered' ? validForScattered : validForComplex;
    if (valid.includes(strokeSettings.width)) return;
    let nearest = valid[0];
    let minDiff = Math.abs(strokeSettings.width - nearest);
    for (const v of valid) {
      const d = Math.abs(strokeSettings.width - v);
      if (d < minDiff) { nearest = v; minDiff = d; }
    }
    console.log(
      `[ContourMargin] width=${strokeSettings.width} not in ${detectedAlgorithm ?? 'complex'} ` +
      `option list — snapping to nearest valid value ${nearest}`
    );
    setStrokeSettings((prev) => ({ ...prev, width: nearest }));
  }, [detectedAlgorithm, strokeSettings.width]);

  const canvasToImage = useCallback((canvas: HTMLCanvasElement): Promise<HTMLImageElement> => {
    return canvasToPngImage(canvas);
  }, []);

  const handleClearDesign = useCallback(() => {
    setImageInfo(null);
    setSpotPreviewData({ enabled: false, colors: [] });
    setDetectedAlgorithm(undefined);
    setSpotPaintMode(null);
    setLockedContour(null);
    setCadCutBounds(null);
    setDetectedShapeType(null);
    setDetectedShapeInfo(null);
    const workerManager = getContourWorkerManager();
    // Important: cancel + clear, in that order. Otherwise any in-flight
    // contour trace would resolve into a now-empty cache slot and
    // potentially flash the old design's outline against the new (or no)
    // image after upload.
    workerManager.cancelInFlight('Design cleared');
    workerManager.clearCache();
  }, []);

  const handleAddToGangSheet = useCallback(async () => {
    if (!imageInfo) {
      toast({ title: "No design loaded", description: "Upload a design first.", variant: "destructive" });
      return;
    }

    if (!shapeSettings.enabled) {
      try {
        await processContourInWorker(
          imageInfo.image,
          strokeSettings,
          resizeSettings,
          undefined,
          detectedShapeType ?? undefined,
          detectedShapeInfo
        );
      } catch (err) {
        console.error("[GangSheet] contour refresh failed:", err);
        toast({
          title: "Contour not ready",
          description: "Could not refresh the outline for the current size. Wait for the preview to finish, then try again.",
          variant: "destructive",
        });
        return;
      }
    }

    const hasUserCutPath =
      strokeSettings.enabled ||
      shapeSettings.enabled ||
      !!(imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour);

    let contourSnapshot: CachedContourData | null = null;

    const workerManager = getContourWorkerManager();
    const cachedData = workerManager.getCachedContourData();

    if (hasUserCutPath && cachedData && cachedData.pathPoints && cachedData.pathPoints.length >= 3) {
      contourSnapshot = {
        pathPoints: [...cachedData.pathPoints],
        previewPathPoints: [...cachedData.previewPathPoints],
        allPathPoints: cachedData.allPathPoints?.map(p => [...p]),
        allPreviewPathPoints: cachedData.allPreviewPathPoints?.map(p => [...p]),
        allBezierPaths: cachedData.allBezierPaths,
        allBezierPathsPreview: cachedData.allBezierPathsPreview,
        widthInches: cachedData.widthInches,
        heightInches: cachedData.heightInches,
        imageOffsetX: cachedData.imageOffsetX,
        imageOffsetY: cachedData.imageOffsetY,
        backgroundColor: cachedData.backgroundColor,
        effectiveDPI: cachedData.effectiveDPI,
        minPathX: cachedData.minPathX,
        minPathY: cachedData.minPathY,
        bleedInches: cachedData.bleedInches,
        holePathStartIndex: cachedData.holePathStartIndex,
      };
    } else if (shapeSettings.enabled) {
      const shapeData = generateShapePathPointsInches(shapeSettings, resizeSettings);
      contourSnapshot = {
        pathPoints: shapeData.pathPoints,
        previewPathPoints: shapeData.pathPoints,
        widthInches: shapeData.widthInches,
        heightInches: shapeData.heightInches,
        imageOffsetX: shapeData.imageOffsetX,
        imageOffsetY: shapeData.imageOffsetY,
        backgroundColor: shapeSettings.fillColor || '#ffffff',
        effectiveDPI: 300,
        minPathX: 0,
        minPathY: 0,
        bleedInches: shapeData.bleedInches,
      };
    }

    let isNoCutPath = false;
    if (!contourSnapshot) {
      const w = resizeSettings.widthInches;
      const h = resizeSettings.heightInches;
      contourSnapshot = {
        pathPoints: [
          { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }, { x: 0, y: 0 },
        ],
        previewPathPoints: [
          { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }, { x: 0, y: 0 },
        ],
        widthInches: w,
        heightInches: h,
        imageOffsetX: 0,
        imageOffsetY: 0,
        backgroundColor: 'transparent',
        effectiveDPI: 300,
        minPathX: 0,
        minPathY: 0,
        bleedInches: 0,
      };
      isNoCutPath = true;
    }

    const canvas = document.createElement('canvas');
    const thumbSize = 120;
    const aspect = imageInfo.image.width / imageInfo.image.height;
    canvas.width = aspect >= 1 ? thumbSize : Math.round(thumbSize * aspect);
    canvas.height = aspect >= 1 ? Math.round(thumbSize / aspect) : thumbSize;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(imageInfo.image, 0, 0, canvas.width, canvas.height);
    const thumbnail = canvas.toDataURL('image/png');

    const hasAnySpotFlag = spotPreviewData.colors.some(c =>
      c.spotWhite || c.spotGloss ||
      c.spotFluorY || c.spotFluorM || c.spotFluorG || c.spotFluorOrange
    );
    const wName = spotPreviewData.spotWhiteName || 'RDG_WHITE';
    const gName = spotPreviewData.spotGlossName || 'RDG_GLOSS';
    const spotColorsSnapshot = hasAnySpotFlag
      ? spotPreviewData.colors.map(c => ({
          hex: c.hex,
          rgb: { ...c.rgb },
          spotWhite: c.spotWhite,
          spotGloss: c.spotGloss,
          spotWhiteName: wName,
          spotGlossName: gName,
          spotFluorY: c.spotFluorY,
          spotFluorM: c.spotFluorM,
          spotFluorG: c.spotFluorG,
          spotFluorOrange: c.spotFluorOrange,
          regions: c.regions?.map(r => ({ id: r.id, spotWhite: r.spotWhite, spotGloss: r.spotGloss, selected: r.selected })),
          regionMap: c.regionMap ? new Int32Array(c.regionMap) : undefined,
        }))
      : undefined;
    const spotPixelMapSnapshot = (hasAnySpotFlag && spotPreviewData.pixelMap && spotPreviewData.mapWidth && spotPreviewData.mapHeight)
      ? { pixelMap: new Int16Array(spotPreviewData.pixelMap), mapWidth: spotPreviewData.mapWidth, mapHeight: spotPreviewData.mapHeight }
      : undefined;

    const newItem: GangSheetItem = {
      id: crypto.randomUUID(),
      thumbnail,
      imageElement: imageInfo.image,
      contourData: contourSnapshot,
      resizeSettings: { ...resizeSettings },
      strokeSettings: { ...strokeSettings },
      shapeSettings: shapeSettings.enabled ? { ...shapeSettings } : undefined,
      cutContourLabel,
      noCutPath: isNoCutPath,
      quantity: 1,
      qrCodes: imageInfo.qrCodes,
      qrRerenderEnabled: imageInfo.qrRerenderEnabled,
      spotColors: spotColorsSnapshot,
      spotPixelMap: spotPixelMapSnapshot,
    };

    const nextItems = [...gangSheetItems, newItem];
    const grown = expandSettingsToFit(nextItems, gangSheetSettings);
    setGangSheetItems(nextItems);
    if (grown.expanded) {
      setGangSheetSettings(grown.settings);
      toast({
        title: "Gangsheet expanded",
        description: `Sheet size auto-expanded to ${grown.settings.sheetWidth}" × ${grown.settings.sheetHeight}" to fit your design.`,
      });
    } else {
      toast({ title: "Added to gang sheet", description: "Sticker added. Upload another design, or click View Gangsheet to fill the sheet and make copies." });
    }
  }, [imageInfo, resizeSettings, strokeSettings, shapeSettings, cutContourLabel, toast, detectedShapeType, detectedShapeInfo, gangSheetItems, gangSheetSettings, spotPreviewData]);

  const gangPack = useMemo(
    () => packGangSheet(gangSheetItems, gangSheetSettings),
    [gangSheetItems, gangSheetSettings]
  );

  const gangSheetView = useMemo(
    () => gangSheetOpen ? {
      items: gangSheetItems,
      settings: gangSheetSettings,
      packResult: gangPack,
    } : null,
    [gangSheetOpen, gangSheetItems, gangSheetSettings, gangPack]
  );

  const handleFillGangSheet = useCallback(() => {
    if (gangSheetItems.length === 0) return;
    const target = gangSheetItems[gangSheetItems.length - 1];
    const maxFit = maxQuantityForItem(gangSheetItems, gangSheetSettings, target.id);
    if (maxFit <= clampGangSheetQuantity(target.quantity)) {
      toast({
        title: "Sheet is full",
        description: "No more copies of this design fit at the current sheet size.",
      });
      return;
    }
    setGangSheetItems(gangSheetItems.map((i) => (i.id === target.id ? { ...i, quantity: maxFit } : i)));
  }, [gangSheetItems, gangSheetSettings, toast]);

  /**
   * Re-run shape detection and invalidate every cached cutpath artefact
   * after the underlying pixels have changed (white-bg removal, magic-wand
   * erase, AI enhance, …). Detected shape type + bounding box drive the
   * contour pipeline's primitive-snap pass and the auto-shape (square /
   * circle / rounded-rect) wrap, so they MUST be recomputed against the
   * new pixel data — otherwise the cutline keeps tracing the silhouette of
   * the original image (e.g. wrapping a rectangle around a logo whose
   * white box was just deleted).
   *
   * Caller is responsible for `setImageInfo(newImageInfo)` separately;
   * this helper only refreshes the derived state.
   */
  const refreshDerivedShapeState = useCallback((newImage: HTMLImageElement) => {
    const detectionResult = detectShape(newImage);
    const detectedType = mapDetectedShapeToType(detectionResult.shape);
    setDetectedShapeType(detectedType);
    setDetectedShapeInfo(detectedType ? {
      type: detectedType,
      boundingBox: detectionResult.boundingBox,
    } : null);

    // Drop any pinned outline — it was traced from the previous pixels and
    // would otherwise keep drawing the old cutline in the preview / PDF.
    setLockedContour(null);
    // CadCut bounds were computed from the previous bounding box.
    setCadCutBounds(null);
    // Manager-level + worker-level cache reset so the next preview render
    // re-traces from scratch instead of returning the previous result.
    const workerManager = getContourWorkerManager();
    workerManager.cancelInFlight('Pixels mutated; previous trace stale');
    workerManager.clearCache();

    console.log(
      `[ShapePipeline] Re-detected after pixel mutation: shape=${detectedType ?? 'none'}, bbox=`,
      detectedType ? detectionResult.boundingBox : null,
    );
  }, []);

  // Tracks the last image we ran QR detection on. Used by the
  // image-change effect to decide whether to re-detect.
  const lastQRDetectedImageRef = useRef<HTMLImageElement | null>(null);
  const qrScanControllerRef = useRef<AbortController | null>(null);

  const cancelQRScan = useCallback(() => {
    qrScanControllerRef.current?.abort();
    qrScanControllerRef.current = null;
    setQrScanStatus({ state: "cancelled", message: "Scan cancelled. You can scan again or select a region manually." });
  }, []);

  // Off-thread QR detection. Fires after imageInfo is set; merges results
  // back into state via a functional update that bails if the image has
  // since been replaced (avoids clobbering a newer upload's metadata).
  const runQRDetection = useCallback((image: HTMLImageElement, options: { force?: boolean; deep?: boolean } = {}) => {
    // Idempotency guard: skip if we've already detected on this exact image
    // reference. `force: true` bypasses (used by the toolbar "Re-scan" button
    // when the user wants to retry after the upload-time detection missed).
    if (!options.force && lastQRDetectedImageRef.current === image) return;
    lastQRDetectedImageRef.current = image;
    qrScanControllerRef.current?.abort();
    const controller = new AbortController();
    qrScanControllerRef.current = controller;
    const isCurrent = () => !controller.signal.aborted &&
      qrScanControllerRef.current === controller && qrSourceRef.current?.image === image;
    setQrScanStatus({ state: "scanning", message: options.deep ? "Deep scan in progress…" : "Scanning for QR codes…" });
    detectQRsInImage(image, {
      signal: controller.signal,
      deep: options.deep,
      maxCodes: 12,
      onProgress: message => {
        if (isCurrent()) setQrScanStatus({ state: "scanning", message });
      },
    }).then((qrCodes) => {
      if (!isCurrent()) return;
      setImageInfo((current) => {
        if (!current || current.image !== image) return current;
        return { ...current, qrCodes, qrDetectionRan: true };
      });
      setQrScanStatus({
        state: "complete",
        message: qrCodes.length
          ? `Found ${qrCodes.length} QR region${qrCodes.length === 1 ? "" : "s"}. Review before repairing.`
          : "No readable QR found. Try a deep scan or select its region manually.",
      });
    }).catch((err) => {
      if (!isCurrent()) return;
      setQrScanStatus({ state: "error", message: err instanceof Error ? err.message : "QR scan failed. Try again or select a region manually." });
    });
  }, []);

  // Re-run QR detection whenever the underlying image reference changes
  // (uploads, background removal, magic wand, AI enhance — anything that
  // swaps `imageInfo.image`). `runQRDetection` itself bails if it's already
  // run on this image, so this effect is idempotent.
  useEffect(() => {
    if (!imageInfo?.image) return;
    runQRDetection(imageInfo.image);
    return () => { qrScanControllerRef.current?.abort(); };
  }, [imageInfo?.image, runQRDetection]);

  const handleApplyQRRepairs = useCallback(async (drafts: QRRepairDraft[]) => {
    if (!imageInfo || qrApplyingRef.current) throw new Error("A QR repair is already running or the artwork is unavailable.");
    if (!drafts.length) throw new Error("Select at least one verified QR repair.");
    const source = imageInfo;
    qrApplyingRef.current = true;
    cancelQRScan();
    pushSnapshot();
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    try {
      const sourceW = source.image.naturalWidth || source.image.width;
      const sourceH = source.image.naturalHeight || source.image.height;
      const next = await commitSpotUvEdit(
        source,
        resizeSettings.widthInches,
        resizeSettings.heightInches,
        async canvas => {
          const scaled = scaleQRRepairDrafts(drafts, sourceW, sourceH, canvas.width, canvas.height);
          // Check the actual print-size patch too, not just the enlarged modal preview.
          const printScale = {
            x: resizeSettings.widthInches * 300 / canvas.width,
            y: resizeSettings.heightInches * 300 / canvas.height,
          };
          await applyQRRepairs(canvas, scaled, printScale);
          return canvas;
        },
      );
      if (!next) throw new Error("Could not update the print artwork.");
      if (qrSourceRef.current?.image !== source.image) throw new Error("The artwork changed during repair. Reopen the studio and try again.");
      const previewW = next.image.naturalWidth || next.image.width;
      const previewH = next.image.naturalHeight || next.image.height;
      const previewDrafts = scaleQRRepairDrafts(drafts, sourceW, sourceH, previewW, previewH);
      // Preview-backed downloads/gang sheets can resample a second time.
      // Verify those real committed pixels, not a freshly generated stand-in.
      verifyQRRepairPixels(next.image, previewDrafts);
      verifyQRRepairPixels(next.image, previewDrafts, {
        x: resizeSettings.widthInches * 300 / previewW,
        y: resizeSettings.heightInches * 300 / previewH,
      });
      // Repairs are now real print pixels. Never overwrite their chosen colors
      // with the older black-and-white export-time QR overlay.
      const repaired: ImageInfo = { ...next, qrCodes: undefined, qrDetectionRan: false, qrRerenderEnabled: false };
      getContourWorkerManager().clearCache();
      setCadCutBounds(null);
      pushSnapshot(repaired);
      setImageInfo(repaired);
      setQrStudioOpen(false);
      toast({ title: "QR repairs applied", description: `${drafts.length} verified repair${drafts.length === 1 ? "" : "s"} applied to the print artwork. Undo is available.` });
    } finally {
      qrApplyingRef.current = false;
    }
  }, [imageInfo, resizeSettings.widthInches, resizeSettings.heightInches, cancelQRScan, pushSnapshot, toast]);

  const applyNewImage = useCallback((newImageInfo: ImageInfo, widthInches: number, heightInches: number) => {
    // Drop any in-flight trace from the previous design before we swap.
    // Without this, the old image's contour can resolve into the cache
    // slot for the new image (or worse, leave the "Processing… 0%"
    // overlay frozen because the bumped processingId discards the result).
    const workerManager = getContourWorkerManager();
    workerManager.cancelInFlight('Design swapped');
    workerManager.clearCache();

    setImageInfo(newImageInfo);

    const detectionResult = detectShape(newImageInfo.image);
    const detectedType = mapDetectedShapeToType(detectionResult.shape);

    setStrokeSettings({
      width: 0.14,
      color: "#ffffff",
      enabled: false,
      alphaThreshold: 128,
      backgroundColor: "#ffffff",
      useCustomBackground: true,
      cornerMode: 'rounded',
      autoBridging: true,
      autoBridgingThreshold: 0.02,
      contourMode: undefined,
    });
    setDetectedAlgorithm(undefined);

    const autoType = detectedType || 'square';
    const newShapeSettings: ShapeSettings = {
      enabled: false,
      type: autoType,
      offset: 0.25,
      fillColor: '#FFFFFF',
      strokeEnabled: false,
      strokeWidth: 2,
      strokeColor: '#000000',
      cornerRadius: 0.25,
      bleedEnabled: false,
      bleedColor: '#FFFFFF',
    };
    setShapeSettings(newShapeSettings);

    setDetectedShapeType(detectedType);
    setDetectedShapeInfo(detectedType ? {
      type: detectedType,
      boundingBox: detectionResult.boundingBox
    } : null);

    setStrokeMode('contour');
    setCadCutBounds(null);
    setLockedContour(null);

    const fittedDimensions = fitUploadedDimensions(widthInches, heightInches);
    setResizeSettings(prev => ({
      ...prev,
      ...fittedDimensions,
    }));

    setStickerSize(fittingStickerSize(fittedDimensions.widthInches, fittedDimensions.heightInches));

    const shapeDims = calculateShapeDimensions(
      fittedDimensions.widthInches,
      fittedDimensions.heightInches,
      newShapeSettings.type,
      newShapeSettings.offset
    );
    updateCadCutBounds(shapeDims.widthInches, shapeDims.heightInches, newShapeSettings);
  }, [updateCadCutBounds]);

  const handleImageUpload = useCallback(async (file: File, image: HTMLImageElement, prepared?: PreparedRaster) => {
    try {
      if (image.width <= 0 || image.height <= 0) {
        alert('Invalid image dimensions.');
        return;
      }

      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      const dpi = prepared?.dpi || 300;
      let exportBlob: Blob;
      let exportCrop: ImageInfo["exportCrop"];
      let inchWidthPx: number;
      let inchHeightPx: number;
      let previewImage: HTMLImageElement;

      if (prepared) {
        exportBlob = prepared.sourceBlob;
        exportCrop = prepared.sourceCrop;
        inchWidthPx = prepared.sourceCrop.width;
        inchHeightPx = prepared.sourceCrop.height;
        const previewW = image.naturalWidth || image.width;
        const previewH = image.naturalHeight || image.height;
        if (Math.max(previewW, previewH) > SPOT_UV_PREVIEW_MAX_EDGE) {
          previewImage = await canvasToImage(drawCappedPreview(image, null, SPOT_UV_PREVIEW_MAX_EDGE));
        } else {
          previewImage = image;
        }
      } else {
        const box = await measureContentBox(image);
        exportBlob = await ownUploadedBytes(file);
        exportCrop = box ?? undefined;
        inchWidthPx = box?.width ?? (image.naturalWidth || image.width);
        inchHeightPx = box?.height ?? (image.naturalHeight || image.height);
        previewImage = await canvasToImage(drawCappedPreview(image, box, SPOT_UV_PREVIEW_MAX_EDGE));
      }

      const previewW = previewImage.naturalWidth || previewImage.width;
      const previewH = previewImage.naturalHeight || previewImage.height;

      const newImageInfo: ImageInfo = {
        file,
        image: previewImage,
        originalWidth: previewW,
        originalHeight: previewH,
        dpi,
        exportBlob,
        exportCrop,
        exportPixelWidth: inchWidthPx,
        exportPixelHeight: inchHeightPx,
      };

      const { widthInches, heightInches } = calculateImageDimensions(inchWidthPx, inchHeightPx, dpi);

      applyNewImage(newImageInfo, widthInches, heightInches);
    } catch (error) {
      console.error('Error processing uploaded image:', error);
      handleFallbackImage(file, image);
    }
  }, [canvasToImage, applyNewImage]);

  const handleFallbackImage = useCallback((file: File, image: HTMLImageElement) => {
    const dpi = 300;
    const processImage = async (finalImage: HTMLImageElement) => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      const { widthInches, heightInches } = calculateImageDimensions(finalImage.width, finalImage.height, dpi);
      let exportBlob: Blob | undefined;
      try {
        exportBlob = await ownUploadedBytes(file);
      } catch { /* keep preview-only */ }
      const newImageInfo: ImageInfo = {
        file,
        image: finalImage,
        originalWidth: finalImage.width,
        originalHeight: finalImage.height,
        dpi,
        exportBlob,
        exportPixelWidth: finalImage.width,
        exportPixelHeight: finalImage.height,
      };
      applyNewImage(newImageInfo, widthInches, heightInches);
    };

    const croppedCanvas = cropImageToContent(image);
    if (croppedCanvas) {
      void canvasToImage(croppedCanvas).then(processImage);
    } else {
      void processImage(image);
    }
  }, [applyNewImage, canvasToImage]);

  const handlePDFUpload = useCallback(async (file: File, pdfData: ParsedPDFData) => {
    // Close any open dropdowns
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    const { image, cutContourInfo, originalPdfData, dpi } = pdfData;

    // Auto-trim to the page's artwork; skipped when a cut-contour path was detected since its points are in the untrimmed page's coordinate space and the legacy cutcontour-download branch draws them against the page as a whole.
    const trimmed = cutContourInfo.hasCutContour ? null : await trimVectorImport({
      image,
      widthInches: pdfData.widthInches,
      heightInches: pdfData.heightInches,
    });

    // Create image info with PDF-specific data
    const newImageInfo: ImageInfo = {
      file,
      image: trimmed?.image ?? image,
      originalWidth: trimmed?.widthPx ?? image.width,
      originalHeight: trimmed?.heightPx ?? image.height,
      dpi,
      isPDF: true,
      pdfCutContourInfo: cutContourInfo,
      originalPdfData,
      vectorInkBox: trimmed?.inkBox,
    };

    setImageInfo(newImageInfo);

    // Match the export label to whatever spot color the PDF actually already carries.
    if (cutContourInfo.detectedLabel) {
      setCutContourLabel(cutContourInfo.detectedLabel as 'CutContour' | 'PerfCutContour' | 'KissCut');
    }

    setStrokeSettings({
      width: 0.14,
      color: "#ffffff",
      enabled: false,
      alphaThreshold: 128,
      backgroundColor: "#ffffff",
      useCustomBackground: true,
      cornerMode: 'rounded',
      autoBridging: true,
      autoBridgingThreshold: 0.02,
      contourMode: undefined,
    });
    setDetectedAlgorithm(undefined);
    setShapeSettings({
      enabled: false,
      type: 'square',
      offset: 0.25,
      fillColor: '#FFFFFF',
      strokeEnabled: false,
      strokeWidth: 2,
      strokeColor: '#000000',
      cornerRadius: 0.25,
      bleedEnabled: false,
      bleedColor: '#FFFFFF',
    });
    
    // If PDF has CutContour, set mode to 'contour' but disable generation
    if (cutContourInfo.hasCutContour) {
      setStrokeMode('none'); // Keep as none since contour is in file
    } else {
      setStrokeMode('none');
    }
    
    setCadCutBounds(null);
    const sourceDimensions = trimmed
      ? { widthInches: trimmed.widthInches, heightInches: trimmed.heightInches }
      : { widthInches: pdfData.widthInches, heightInches: pdfData.heightInches };
    const { widthInches, heightInches } = fitUploadedDimensions(
      sourceDimensions.widthInches,
      sourceDimensions.heightInches,
    );
    setStickerSize(fittingStickerSize(widthInches, heightInches));
    
    setResizeSettings(prev => ({
      ...prev,
      widthInches,
      heightInches,
    }));
  }, []);

  const handleSVGUpload = useCallback(async (file: File, svgData: ParsedSVGData) => {
    // Close any open dropdowns
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    const { image, svgSource, dpi } = svgData;

    // Auto-trim the page down to its artwork — see handlePDFUpload's note. SVG has no pre-existing cut-contour path to keep aligned with an untrimmed page, so always attempt the trim.
    const trimmed = await trimVectorImport({
      image,
      widthInches: svgData.widthInches,
      heightInches: svgData.heightInches,
    });

    // Save/reopen persist `imageInfo.file` verbatim as `source_image` (PNG/JPEG only, decoded back through a plain <img>), so it has to be the rasterised bytes, not the raw SVG.
    const pngBlob = trimmed?.pngBlob ?? svgData.pngBlob;
    const pngFile = new File([pngBlob], `${file.name.replace(/\.svg$/i, '') || 'design'}.png`, { type: 'image/png' });

    const newImageInfo: ImageInfo = {
      file: pngFile,
      image: trimmed?.image ?? image,
      originalWidth: trimmed?.widthPx ?? svgData.widthPx,
      originalHeight: trimmed?.heightPx ?? svgData.heightPx,
      dpi,
      svgSource,
      vectorInkBox: trimmed?.inkBox,
    };

    setImageInfo(newImageInfo);

    setStrokeSettings({
      width: 0.14,
      color: "#ffffff",
      enabled: false,
      alphaThreshold: 128,
      backgroundColor: "#ffffff",
      useCustomBackground: true,
      cornerMode: 'rounded',
      autoBridging: true,
      autoBridgingThreshold: 0.02,
      contourMode: undefined,
    });
    setDetectedAlgorithm(undefined);
    setShapeSettings({
      enabled: false,
      type: 'square',
      offset: 0.25,
      fillColor: '#FFFFFF',
      strokeEnabled: false,
      strokeWidth: 2,
      strokeColor: '#000000',
      cornerRadius: 0.25,
      bleedEnabled: false,
      bleedColor: '#FFFFFF',
    });
    setStrokeMode('none');

    setCadCutBounds(null);
    const sourceDimensions = trimmed
      ? { widthInches: trimmed.widthInches, heightInches: trimmed.heightInches }
      : { widthInches: svgData.widthInches, heightInches: svgData.heightInches };
    const { widthInches, heightInches } = fitUploadedDimensions(
      sourceDimensions.widthInches,
      sourceDimensions.heightInches,
    );
    setStickerSize(fittingStickerSize(widthInches, heightInches));

    setResizeSettings(prev => ({
      ...prev,
      widthInches,
      heightInches,
    }));
  }, []);

  const handleResizeChange = useCallback((newSettings: Partial<ResizeSettings>) => {
    setResizeSettings(prev => {
      const updated = { ...prev, ...newSettings };
      
      // Handle aspect ratio maintenance
      if (updated.maintainAspectRatio && imageInfo && newSettings.widthInches !== undefined) {
        const aspectRatio = imageInfo.originalHeight / imageInfo.originalWidth;
        updated.heightInches = parseFloat((newSettings.widthInches * aspectRatio).toFixed(1));
      } else if (updated.maintainAspectRatio && imageInfo && newSettings.heightInches !== undefined) {
        const aspectRatio = imageInfo.originalWidth / imageInfo.originalHeight;
        updated.widthInches = parseFloat((newSettings.heightInches * aspectRatio).toFixed(1));
      }

      const fittedDimensions = fitUploadedDimensions(updated.widthInches, updated.heightInches);
      updated.widthInches = fittedDimensions.widthInches;
      updated.heightInches = fittedDimensions.heightInches;
      
      // Recalculate bounds with auto-sized shape dimensions
      if (shapeSettings.enabled) {
        const shapeDims = calculateShapeDimensions(
          updated.widthInches,
          updated.heightInches,
          shapeSettings.type,
          shapeSettings.offset
        );
        updateCadCutBounds(shapeDims.widthInches, shapeDims.heightInches, shapeSettings);
      }
      
      return updated;
    });
  }, [imageInfo, shapeSettings, updateCadCutBounds]);

  const handleStickerSizeChange = useCallback((newSize: StickerSize) => {
    setStickerSize(newSize);
    
    // Resize the design to fit within the new sticker size
    if (imageInfo) {
      const aspectRatio = imageInfo.originalWidth / imageInfo.originalHeight;
      let newWidth: number;
      let newHeight: number;
      
      if (aspectRatio >= 1) {
        // Wider than tall - width is the constraining dimension
        newWidth = newSize;
        newHeight = parseFloat((newSize / aspectRatio).toFixed(2));
      } else {
        // Taller than wide - height is the constraining dimension
        newHeight = newSize;
        newWidth = parseFloat((newSize * aspectRatio).toFixed(2));
      }
      
      setResizeSettings(prev => ({
        ...prev,
        widthInches: newWidth,
        heightInches: newHeight,
      }));
      
      // Recalculate bounds with auto-sized shape dimensions
      if (shapeSettings.enabled) {
        const shapeDims = calculateShapeDimensions(
          newWidth,
          newHeight,
          shapeSettings.type,
          shapeSettings.offset
        );
        updateCadCutBounds(shapeDims.widthInches, shapeDims.heightInches, shapeSettings);
      }
    }
  }, [imageInfo, shapeSettings, updateCadCutBounds]);

  const handleRemoveBackground = useCallback(async (threshold: number) => {
    console.log('[BgRemoval-handler] handleRemoveBackground invoked, threshold=', threshold, 'hasImage=', !!imageInfo);
    if (!imageInfo) return;

    setIsRemovingBackground(true);
    try {
      const next = await commitSpotUvEdit(
        imageInfo,
        resizeSettings.widthInches,
        resizeSettings.heightInches,
        async (canvas) => {
          await removeBackgroundFromCanvas(canvas, threshold);
          return cropCanvasToContent(canvas);
        },
      );
      if (!next) {
        setIsRemovingBackground(false);
        return;
      }

      console.log(`[BackgroundRemoval] Complete! Original: ${imageInfo.originalWidth}x${imageInfo.originalHeight}, New: ${next.originalWidth}x${next.originalHeight}`);

      setImageInfo(next);
      refreshDerivedShapeState(next.image);
      toast({
        title: "Background Removed",
        description: "White background removed from edges. Select Contour to see the new outline.",
      });
    } catch (error) {
      console.error('Error removing background:', error);
      toast({
        title: "Error",
        description: "Failed to remove background. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsRemovingBackground(false);
    }
  }, [imageInfo, resizeSettings.widthInches, resizeSettings.heightInches, toast, refreshDerivedShapeState]);

  const handleMagicWandClick = useCallback(async (imageX: number, imageY: number) => {
    if (!imageInfo || isMagicWandRunning) return;

    const src = imageInfo.image;
    const w = src.naturalWidth || src.width;
    const h = src.naturalHeight || src.height;
    if (!w || !h) return;
    const nx = imageX / w;
    const ny = imageY / h;

    setIsMagicWandRunning(true);
    try {
      const next = await commitSpotUvEdit(
        imageInfo,
        resizeSettings.widthInches,
        resizeSettings.heightInches,
        (canvas) => {
          if (!eraseConnectedColorOnCanvas(canvas, nx, ny, magicWandTolerance)) return canvas;
          return cropCanvasToContent(canvas);
        },
      );
      if (!next) return;

      console.log(`[MagicWand] Erased region around (${imageX.toFixed(0)}, ${imageY.toFixed(0)}) tol=${magicWandTolerance.toFixed(3)}; size: ${imageInfo.originalWidth}x${imageInfo.originalHeight} → ${next.originalWidth}x${next.originalHeight}`);

      setImageInfo(next);
      refreshDerivedShapeState(next.image);

      toast({
        title: "Color Erased",
        description: "Click another area to erase more, or click Done.",
      });
    } catch (error) {
      if ((error as Error).message?.includes('Cancelled')) return;
      console.error('Magic wand error:', error);
      toast({
        title: "Error",
        description: "Magic wand failed. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsMagicWandRunning(false);
    }
  }, [imageInfo, resizeSettings.widthInches, resizeSettings.heightInches, magicWandTolerance, isMagicWandRunning, toast, refreshDerivedShapeState]);

  const handleStrokeChange = useCallback((newSettings: Partial<StrokeSettings>) => {
    const updated = { ...strokeSettings, ...newSettings };
    
    // If enabling stroke, disable shape for mutual exclusion
    if (newSettings.enabled === true) {
      setShapeSettings(prev => ({ ...prev, enabled: false }));
    }
    
    setStrokeSettings(updated);
  }, [strokeSettings]);

  const handleSegmentImage = useCallback(async () => {
    if (!imageInfo || isSegmenting) return;

    setIsSegmenting(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = imageInfo.image.width;
      canvas.height = imageInfo.image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(imageInfo.image, 0, 0);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Failed to create blob')), 'image/png');
      });

      const formData = new FormData();
      formData.append('image', blob, 'image.png');

      const response = await fetch('/api/segment-image', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Server error ${response.status}`);
      }

      const data = await response.json();
      const layers: SegmentLayer[] = (data.layers || []).map((l: any) => ({
        ...l,
        spotWhite: l.spotWhite ?? false,
        spotGloss: l.spotGloss ?? false,
      }));

      setSegmentationData({
        enabled: true,
        layers,
        mode: 'items',
      });

      toast({
        title: "Segmentation Complete",
        description: `Detected ${layers.length} item${layers.length !== 1 ? 's' : ''} in the image.`,
      });
    } catch (error) {
      console.error('Segmentation failed:', error);
      toast({
        title: "Segmentation Failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsSegmenting(false);
    }
  }, [imageInfo, isSegmenting, toast]);

  const handleIncreaseQuality = useCallback(async () => {
    if (!imageInfo || isUpscaling) return;

    const srcW = imageInfo.exportPixelWidth || imageInfo.image.naturalWidth || imageInfo.image.width;
    const srcH = imageInfo.exportPixelHeight || imageInfo.image.naturalHeight || imageInfo.image.height;
    const scale = resolveUpscaleScale(srcW, srcH, 4) || resolveUpscaleScale(srcW, srcH, 2);
    if (!scale) {
      toast({
        title: "Already at max quality",
        description: "This design is already as large as the editor can upscale.",
      });
      return;
    }

    setIsUpscaling(true);
    setEnhanceStage(`Increasing quality (${scale}x)…`);
    let previewTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const next = await commitSpotUvEdit(
        imageInfo,
        resizeSettings.widthInches,
        resizeSettings.heightInches,
        async (canvas) => {
          const w = canvas.width;
          const h = canvas.height;
          const editScale = resolveUpscaleScale(w, h, 4) || resolveUpscaleScale(w, h, 2);
          if (!editScale) return canvas;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) throw new Error("Could not read the design's pixels.");
          const pixels = ctx.getImageData(0, 0, w, h);
          const result = await getUpscaleManager().upscale(
            pixels.data,
            w,
            h,
            editScale,
            ({ completed, total }) => {
              setEnhanceStage(total > 0 ? `Increasing quality… ${Math.round((completed / total) * 100)}%` : "Increasing quality…");
            },
          );
          const out = document.createElement("canvas");
          out.width = result.width;
          out.height = result.height;
          const outCtx = out.getContext("2d", { willReadFrequently: true });
          if (!outCtx) throw new Error("Could not write upscaled pixels.");
          outCtx.putImageData(new ImageData(result.rgba, result.width, result.height), 0, 0);
          return out;
        },
      );
      if (!next) throw new Error("Could not apply the upscale.");

      const previewReady = new Promise<void>((resolve, reject) => {
        qualityPreviewRef.current = { image: next.image, resolve, reject };
        previewTimeout = setTimeout(() => reject(new Error(
          'The image was enhanced, but its preview timed out. Please try updating the contour again.',
        )), 60_000);
      });
      setEnhanceStage('Finishing the image and contour preview…');
      setImageInfo(next);
      refreshDerivedShapeState(next.image);
      await previewReady;
      toast({
        title: "Quality increased",
        description: `${srcW}×${srcH} → ${next.exportPixelWidth ?? next.originalWidth}×${next.exportPixelHeight ?? next.originalHeight} (${scale}x)`,
      });
    } catch (error) {
      console.error("[Upscale] Error:", error);
      toast({
        title: "Increase Quality failed",
        description: error instanceof Error ? error.message : "Unknown error. Please try again.",
        variant: "destructive",
      });
    } finally {
      clearTimeout(previewTimeout);
      clearTimeout(qualityPreviewRef.current?.settleTimer);
      qualityPreviewRef.current = null;
      setIsUpscaling(false);
      setEnhanceStage("");
    }
  }, [imageInfo, isUpscaling, resizeSettings.widthInches, resizeSettings.heightInches, toast, refreshDerivedShapeState]);

  const reopenDesign = useCallback(async (design: DesignSummary) => {
    try {
      setIsReadOnlyView(false);
      setReadOnlyOwnerEmail(null);
      setReadOnlyOriginalId(null);
      const src = design.state.source;
      if (src.kind === "pdf") {
        const file = await fetchAssetAsFile(src.assetId, "design.pdf", "application/pdf");
        const pdfData = await parsePDF(file);
        await handlePDFUpload(file, pdfData);
      } else {
        const file = await fetchAssetAsFile(src.assetId, "design.png", "image/png");
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("Failed to decode saved image"));
          img.src = URL.createObjectURL(file);
        });
        await handleImageUpload(file, image);
      }
      const s = design.state;
      setStrokeSettings(s.strokeSettings);
      setResizeSettings(s.resizeSettings);
      setShapeSettings(s.shapeSettings);
      setStrokeMode(s.strokeMode);
      setStickerSize(s.stickerSize as StickerSize);
      setCutContourLabel(s.cutContourLabel);
      setLockedContour(s.lockedContour ?? null);
      setSegmentationData({ enabled: s.segmentation.enabled, mode: s.segmentation.mode, layers: [] });
      pendingSegmentTagsRef.current = s.segmentation.layers.length > 0 ? s.segmentation.layers : null;
      setSpotPreviewData((prev) => ({
        ...prev,
        enabled: s.spotColors.enabled,
        spotWhiteName: s.spotColors.spotWhiteName,
        spotGlossName: s.spotColors.spotGlossName,
      }));
      pendingSpotTagsRef.current = s.spotColors.tags;
      setCurrentDesignId(design.id);
      setCurrentDesignName(design.name);
      setSourceAssetId(src.assetId);
      toast({ title: "Design loaded", description: `"${design.name}" opened.` });
    } catch (error) {
      console.error("[reopen] failed:", error);
      toast({ title: "Failed to open design", description: getErrorMessage(error), variant: "destructive" });
    }
  }, [handlePDFUpload, handleImageUpload, toast]);

  const reopenDesignReadOnly = useCallback(async (design: AdminDesignDetail) => {
    try {
      const src = design.state.source;
      if (src.kind === "pdf") {
        const file = await fetchAssetAsFileForAdmin(src.assetId, "design.pdf", "application/pdf");
        const pdfData = await parsePDF(file);
        await handlePDFUpload(file, pdfData);
      } else {
        const file = await fetchAssetAsFileForAdmin(src.assetId, "design.png", "image/png");
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("Failed to decode design image"));
          img.src = URL.createObjectURL(file);
        });
        await handleImageUpload(file, image);
      }
      const s = design.state;
      setStrokeSettings(s.strokeSettings);
      setResizeSettings(s.resizeSettings);
      setShapeSettings(s.shapeSettings);
      setStrokeMode(s.strokeMode);
      setStickerSize(s.stickerSize as StickerSize);
      setCutContourLabel(s.cutContourLabel);
      setLockedContour(s.lockedContour ?? null);
      setSegmentationData({ enabled: s.segmentation.enabled, mode: s.segmentation.mode, layers: [] });
      pendingSegmentTagsRef.current = s.segmentation.layers.length > 0 ? s.segmentation.layers : null;
      setSpotPreviewData((prev) => ({
        ...prev,
        enabled: s.spotColors.enabled,
        spotWhiteName: s.spotColors.spotWhiteName,
        spotGlossName: s.spotColors.spotGlossName,
      }));
      pendingSpotTagsRef.current = s.spotColors.tags;
      setCurrentDesignName(design.name);
      setIsReadOnlyView(true);
      setReadOnlyOwnerEmail(design.ownerEmail);
      setReadOnlyOriginalId(design.id);
      toast({ title: "Viewing design", description: `"${design.name}" — read-only.` });
    } catch (error) {
      console.error("[admin view] failed:", error);
      toast({ title: "Failed to load design", description: getErrorMessage(error), variant: "destructive" });
    }
  }, [handlePDFUpload, handleImageUpload, toast]);

  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    const designId = params.get("design");
    const adminViewId = params.get("adminView");
    if (adminViewId && adminViewId !== openedDesignParamRef.current) {
      openedDesignParamRef.current = adminViewId;
      setIsLoadingDesign(true);
      apiRequest("GET", `/api/admin/designs/${adminViewId}`)
        .then((res) => res.json())
        .then((data) => reopenDesignReadOnly(data.design))
        .catch((error) => toast({ title: "Failed to load design", description: getErrorMessage(error), variant: "destructive" }))
        .finally(() => setIsLoadingDesign(false));
      return;
    }
    if (!designId || designId === openedDesignParamRef.current) return;
    openedDesignParamRef.current = designId;
    setIsLoadingDesign(true);
    apiRequest("GET", `/api/designs/${designId}`)
      .then((res) => res.json())
      .then((data) => reopenDesign(data.design))
      .catch((error) => toast({ title: "Failed to load design", description: getErrorMessage(error), variant: "destructive" }))
      .finally(() => setIsLoadingDesign(false));
  }, [searchParams, reopenDesign, reopenDesignReadOnly, toast]);

  useEffect(() => {
    if (!pendingSpotTagsRef.current || spotPreviewData.colors.length === 0) return;
    const matched = matchSpotTagsToColors(pendingSpotTagsRef.current, spotPreviewData.colors);
    setSpotColorRestore({ colors: matched, id: Date.now(), spotWhiteName: spotPreviewData.spotWhiteName, spotGlossName: spotPreviewData.spotGlossName });
    if (spotPreviewData.colors.some((c) => c.regions)) {
      pendingSpotTagsRef.current = null;
    }
  }, [spotPreviewData.colors, spotPreviewData.spotWhiteName, spotPreviewData.spotGlossName]);

  useEffect(() => {
    if (!pendingSegmentTagsRef.current || segmentationData.layers.length === 0) return;
    const tagsByLabel = new Map(pendingSegmentTagsRef.current.map((t) => [t.label, t]));
    let matchedAny = false;
    setSegmentationData((prev) => ({
      ...prev,
      layers: prev.layers.map((layer) => {
        const tag = tagsByLabel.get(layer.label);
        if (!tag) return layer;
        matchedAny = true;
        return { ...layer, spotWhite: tag.spotWhite, spotGloss: tag.spotGloss };
      }),
    }));
    pendingSegmentTagsRef.current = null;
    if (matchedAny) {
      toast({ title: "Layer tags restored", description: "Saved White/Gloss tags were reapplied to the matching layers." });
    }
  }, [segmentationData.layers, toast]);

  const performSave = useCallback(async (mode: "save" | "save-as-new", name: string) => {
    if (!imageInfo) return;
    setIsSavingDesign(true);
    try {
      let assetId = sourceAssetId;
      if (!assetId || mode === "save-as-new") {
        if (imageInfo.isPDF && imageInfo.originalPdfData) {
          const pdfBlob = new Blob([imageInfo.originalPdfData], { type: "application/pdf" });
          const uploaded = await uploadAsset(pdfBlob, imageInfo.file.name || "design.pdf", "source_pdf");
          assetId = uploaded.id;
        } else {
          const uploaded = await uploadAsset(imageInfo.file, imageInfo.file.name || "design.png", "source_image", {
            width: imageInfo.originalWidth,
            height: imageInfo.originalHeight,
          });
          assetId = uploaded.id;
        }
        setSourceAssetId(assetId);
      }
      let thumbnailAssetId: number | undefined;
      try {
        if (canvasRef.current) {
          const blob = await new Promise<Blob | null>((resolve) => canvasRef.current!.toBlob(resolve, "image/png"));
          if (blob) {
            const uploaded = await uploadAsset(blob, "thumbnail.png", "thumbnail");
            thumbnailAssetId = uploaded.id;
          }
        }
      } catch (thumbError) {
        console.warn("[save] thumbnail upload failed (non-fatal):", thumbError);
      }
      const state = serializeDesign({
        sourceAssetId: assetId!,
        imageInfo: imageInfo as unknown as Parameters<typeof serializeDesign>[0]["imageInfo"],
        strokeSettings,
        resizeSettings,
        shapeSettings,
        strokeMode,
        stickerSize,
        cutContourLabel,
        lockedContour,
        spotPreviewData: spotPreviewData as unknown as Parameters<typeof serializeDesign>[0]["spotPreviewData"],
        segmentationData,
      });
      if (mode === "save" && currentDesignId) {
        await designMutations.update.mutateAsync({
          id: currentDesignId,
          name,
          state,
          sourceAssetId: assetId!,
          thumbnailAssetId,
        });
        setCurrentDesignName(name);
        toast({ title: "Saved" });
      } else {
        const result = await designMutations.create.mutateAsync({ name, state, sourceAssetId: assetId!, thumbnailAssetId });
        setCurrentDesignId(result.design.id);
        setCurrentDesignName(name);
        toast({ title: "Saved as new design" });
      }
    } catch (error) {
      toast({ title: "Save failed", description: getErrorMessage(error), variant: "destructive" });
    } finally {
      setIsSavingDesign(false);
    }
  }, [
    imageInfo, sourceAssetId, currentDesignId,
    strokeSettings, resizeSettings, shapeSettings, strokeMode, stickerSize,
    cutContourLabel, lockedContour, spotPreviewData, segmentationData,
    designMutations, toast,
  ]);

  const handleSaveDesign = useCallback((mode: "save" | "save-as-new") => {
    if (isReadOnlyView) {
      toast({ title: "Read-only", description: 'Use "Edit as my own" to make an editable copy.', variant: "destructive" });
      return;
    }
    if (!imageInfo) {
      toast({ title: "Nothing to save", description: "Upload a design first.", variant: "destructive" });
      return;
    }
    if (!isAuthenticated) {
      toast({ title: "Sign in required", description: "Log in to save your designs.", variant: "destructive" });
      return;
    }
    if (mode === "save" && currentDesignId) {
      performSave("save", currentDesignName);
    } else {
      setSaveNameDialog({ open: true, mode });
      setSaveNameValue(mode === "save-as-new" ? `${currentDesignName} (copy)` : currentDesignName);
    }
  }, [imageInfo, isAuthenticated, isReadOnlyView, currentDesignId, currentDesignName, performSave, toast]);

  const handleConfirmSaveName = useCallback(() => {
    if (!saveNameDialog.mode) return;
    const name = saveNameValue.trim() || currentDesignName;
    setSaveNameDialog({ open: false, mode: null });
    performSave(saveNameDialog.mode, name);
  }, [saveNameDialog, saveNameValue, currentDesignName, performSave]);

  const handleEditAsOwnFromView = useCallback(async () => {
    if (readOnlyOriginalId === null) return;
    try {
      const res = await apiRequest("POST", `/api/admin/designs/${readOnlyOriginalId}/fork`);
      const data = await res.json();
      setLocation(`/?design=${data.design.id}`);
    } catch (error) {
      toast({ title: "Couldn't copy design", description: getErrorMessage(error), variant: "destructive" });
    }
  }, [readOnlyOriginalId, setLocation, toast]);

  const handleSegmentationChange = useCallback((data: Partial<SegmentationData>) => {
    setSegmentationData(prev => ({ ...prev, ...data }));
  }, []);

  const handleSegmentLayerToggle = useCallback((layerId: string) => {
    setSegmentationData(prev => ({
      ...prev,
      layers: prev.layers.map(l =>
        l.id === layerId ? { ...l, visible: !l.visible } : l
      ),
    }));
  }, []);

  const handleSegmentLayerSpotChange = useCallback((layerId: string, field: 'spotWhite' | 'spotGloss', value: boolean) => {
    setSegmentationData(prev => ({
      ...prev,
      layers: prev.layers.map(l =>
        l.id === layerId ? { ...l, [field]: value } : l
      ),
    }));
  }, []);

  const handleSegmentLayerLabelChange = useCallback((layerId: string, label: string) => {
    setSegmentationData(prev => ({
      ...prev,
      layers: prev.layers.map(l =>
        l.id === layerId ? { ...l, label } : l
      ),
    }));
  }, []);

  const handleShapeChange = useCallback((newSettings: Partial<ShapeSettings>) => {
    let updated = { ...shapeSettings, ...newSettings };
    
    // If enabling shape, disable stroke for mutual exclusion
    if (newSettings.enabled === true) {
      setStrokeSettings(prev => ({ ...prev, enabled: false }));
    }
    
    // Reset dimension overrides when switching shape type so auto-sizing recalculates
    if (newSettings.type !== undefined && newSettings.type !== shapeSettings.type) {
      updated.shapeWidthOverride = 0;
      updated.shapeHeightOverride = 0;
    }
    
    setShapeSettings(updated);
    
    // Recalculate bounds with auto-sized shape dimensions - pass updated settings to avoid stale closure
    if (updated.enabled && imageInfo) {
      const shapeDims = calculateShapeDimensions(
        resizeSettings.widthInches,
        resizeSettings.heightInches,
        updated.type,
        updated.offset
      );
      updateCadCutBounds(shapeDims.widthInches, shapeDims.heightInches, updated);
    }
  }, [shapeSettings, imageInfo, resizeSettings, updateCadCutBounds]);



  const handleDownload = useCallback(async (downloadType: 'standard' | 'highres' | 'vector' | 'cutcontour' | 'design-only' | 'download-package' = 'standard', format: VectorFormat = 'png', spotColors?: SpotColorInput[], singleArtboard: boolean = false) => {
    if (!imageInfo || !canvasRef.current) return;
    
    setIsProcessing(true);
    
    try {
      // PDF with an existing spot-color contour — every download button in the UI sends 'standard', never 'cutcontour', so this must not be gated on downloadType or it's unreachable dead code.
      if (imageInfo.isPDF && imageInfo.pdfCutContourInfo?.hasCutContour) {
        const { generatePDFWithVectorCutContour } = await import('./lib/pdf-parser');
        const nameWithoutExt = imageInfo.file.name.replace(/\.[^/.]+$/, '');
        const liveSpots = spotPreviewDataRef.current;
        const importedSpotMap = (liveSpots.pixelMap && liveSpots.mapWidth && liveSpots.mapHeight)
          ? { pixelMap: liveSpots.pixelMap, mapWidth: liveSpots.mapWidth, mapHeight: liveSpots.mapHeight }
          : undefined;
        await generatePDFWithVectorCutContour(
          imageInfo.image,
          imageInfo.pdfCutContourInfo.cutContourPoints,
          imageInfo.pdfCutContourInfo.pageWidth,
          imageInfo.pdfCutContourInfo.pageHeight,
          imageInfo.dpi || 300,
          `${nameWithoutExt}_with_cutcontour.pdf`,
          cutContourLabel,
          spotColors,
          singleArtboard,
          importedSpotMap,
        );
        setIsProcessing(false);
        return;
      }
      if (downloadType === 'download-package') {
        // Create zip package with original and cutlines
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Calculate output dimensions using auto-sizing
        const shapeDims = calculateShapeDimensions(
          resizeSettings.widthInches,
          resizeSettings.heightInches,
          shapeSettings.type,
          shapeSettings.offset
        );
        const outputWidth = shapeDims.widthInches * 300;
        const outputHeight = shapeDims.heightInches * 300;
        
        canvas.width = outputWidth;
        canvas.height = outputHeight;

        // Draw shape background
        // Holographic fill downloads as transparent (preview only) - skip fill entirely
        const isHolographicFill = shapeSettings.fillColor === 'holographic';
        ctx.beginPath();
        
        if (shapeSettings.type === 'circle') {
          const radius = Math.min(outputWidth, outputHeight) / 2;
          const centerX = outputWidth / 2;
          const centerY = outputHeight / 2;
          ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        } else if (shapeSettings.type === 'oval') {
          const centerX = outputWidth / 2;
          const centerY = outputHeight / 2;
          ctx.ellipse(centerX, centerY, outputWidth / 2, outputHeight / 2, 0, 0, Math.PI * 2);
        } else if (shapeSettings.type === 'square') {
          const size = Math.min(outputWidth, outputHeight);
          const startX = (outputWidth - size) / 2;
          const startY = (outputHeight - size) / 2;
          ctx.rect(startX, startY, size, size);
        } else {
          ctx.rect(0, 0, outputWidth, outputHeight);
        }
        
        // Only fill if not holographic - holographic downloads as transparent
        if (!isHolographicFill) {
          ctx.fillStyle = shapeSettings.fillColor;
          ctx.fill();
        }

        // Draw cutlines in magenta
        ctx.strokeStyle = '#FF00FF';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Crop image to remove empty space before processing
        const croppedCanvas = cropImageToContent(imageInfo.image);
        const finalImage = croppedCanvas ? (() => {
          const img = new Image();
          img.src = croppedCanvas.toDataURL();
          return img;
        })() : imageInfo.image;

        // Wait for cropped image to load if created
        if (croppedCanvas) {
          await new Promise((resolve) => {
            finalImage.onload = resolve;
          });
        }

        const imageWidth = resizeSettings.widthInches * 300;
        const imageHeight = resizeSettings.heightInches * 300;
        
        const imageX = (outputWidth - imageWidth) / 2;
        const imageY = (outputHeight - imageHeight) / 2;
        
        ctx.save();
        ctx.beginPath();
        if (shapeSettings.type === 'circle') {
          const clipRadius = Math.min(outputWidth, outputHeight) / 2;
          ctx.arc(outputWidth / 2, outputHeight / 2, clipRadius, 0, Math.PI * 2);
        } else if (shapeSettings.type === 'oval') {
          ctx.ellipse(outputWidth / 2, outputHeight / 2, outputWidth / 2, outputHeight / 2, 0, 0, Math.PI * 2);
        } else {
          ctx.rect(0, 0, outputWidth, outputHeight);
        }
        ctx.clip();
        ctx.drawImage(finalImage, imageX, imageY, imageWidth, imageHeight);
        ctx.restore();

        // Awaited so recordDownload below can't fire before the file exists.
        const nameWithoutExt = imageInfo.file.name.replace(/\.[^/.]+$/, '');
        const finalDesignBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!finalDesignBlob) throw new Error('Failed to generate final design image');
        const finalDesignUrl = URL.createObjectURL(finalDesignBlob);
        const finalDesignLink = document.createElement('a');
        finalDesignLink.href = finalDesignUrl;
        finalDesignLink.download = `${nameWithoutExt}_final_design.png`;
        finalDesignLink.style.display = 'none';
        document.body.appendChild(finalDesignLink);
        finalDesignLink.click();
        document.body.removeChild(finalDesignLink);
        URL.revokeObjectURL(finalDesignUrl);

      } else if (downloadType === 'cutcontour') {
        // Generate magenta vector path along transparent pixel boundaries
        await new Promise(resolve => setTimeout(resolve, 100)); // UI feedback delay
        
        const magentaCutCanvas = createVectorStroke(imageInfo.image, {
          strokeSettings: { ...strokeSettings, color: '#FF00FF', enabled: true }, // Force magenta
          exportCutContour: true, // Enable cut contour mode
          vectorQuality: 'high' // High quality for precise cutting paths
        });
        
        // Awaited for the same reason as the download-package branch above.
        const cutContourBlob = await new Promise<Blob | null>((resolve) => magentaCutCanvas.toBlob(resolve, 'image/png'));
        if (!cutContourBlob) throw new Error('Failed to generate cut contour image');
        const cutContourUrl = URL.createObjectURL(cutContourBlob);
        const cutContourLink = document.createElement('a');
        cutContourLink.href = cutContourUrl;
        cutContourLink.download = 'magenta_cut_contour.png';
        document.body.appendChild(cutContourLink);
        cutContourLink.click();
        document.body.removeChild(cutContourLink);
        URL.revokeObjectURL(cutContourUrl);

        // Also generate vector formats for cutting machines
        const vectorPaths = createVectorPaths(imageInfo.image, {
          ...strokeSettings, 
          color: '#FF00FF', 
          enabled: true
        });
        
        // Download additional vector formats based on requested format
        if (format === 'svg') {
          downloadVectorStroke(magentaCutCanvas, 'cut_contour.svg', 'svg', vectorPaths);
        } else if (format === 'eps') {
          downloadVectorStroke(magentaCutCanvas, 'cut_contour.eps', 'eps', vectorPaths);
        }
      } else {
        // Standard download - shape background or contour outline
        const nameWithoutExt = imageInfo.file.name.replace(/\.[^/.]+$/, '');
        
        // Always read the latest overlay map — handleDownload can otherwise
        // close over an empty spotPreviewData and export a different silhouette.
        const liveSpots = spotPreviewDataRef.current;
        const spotPixelMap = (liveSpots.pixelMap && liveSpots.mapWidth && liveSpots.mapHeight)
          ? { pixelMap: liveSpots.pixelMap, mapWidth: liveSpots.mapWidth, mapHeight: liveSpots.mapHeight }
          : undefined;

        if (strokeSettings.enabled) {
          // Contour mode: Download PDF with raster image + vector contour
          const filename = `${nameWithoutExt}_with_contour.pdf`;

          // Cache can lag behind the debounced preview — regenerate for the current settings before reading it, same fix as handleAddToGangSheet.
          try {
            await processContourInWorker(
              imageInfo.image,
              strokeSettings,
              resizeSettings,
              undefined,
              detectedShapeType ?? undefined,
              detectedShapeInfo
            );
          } catch (err) {
            console.error("[Download] contour refresh failed:", err);
            toast({
              title: "Contour not ready",
              description: "Could not refresh the outline for the current size. Wait for the preview to finish, then try again.",
              variant: "destructive",
            });
            return;
          }

          const workerManager = getContourWorkerManager();
          const cachedData = workerManager.getCachedContourData() as CachedContourData | undefined;

          await downloadContourPDF(
            imageInfo.image,
            strokeSettings,
            resizeSettings,
            filename,
            cachedData,
            spotColors,
            singleArtboard,
            cutContourLabel,
            lockedContour ? { label: lockedContour.label, pathPoints: lockedContour.pathPoints, allPathPoints: lockedContour.allPathPoints, widthInches: lockedContour.widthInches, heightInches: lockedContour.heightInches } : null,
            { qrCodes: imageInfo.qrCodes, enabled: imageInfo.qrRerenderEnabled === true },
            spotPixelMap,
            imageInfo
          );
        } else if (shapeSettings.enabled) {
          // Shape background mode: Download PDF with shape + CutContour spot color
          const filename = `${nameWithoutExt}_with_shape.pdf`;
          const printImage = await resolveSpotUvPrintImage(
            imageInfo,
            resizeSettings.widthInches,
            resizeSettings.heightInches,
          );
          await downloadShapePDF(
            printImage,
            shapeSettings,
            resizeSettings,
            filename,
            spotColors,
            singleArtboard,
            cutContourLabel,
            lockedContour ? { label: lockedContour.label, pathPoints: lockedContour.pathPoints, allPathPoints: lockedContour.allPathPoints, widthInches: lockedContour.widthInches, heightInches: lockedContour.heightInches, imageOffsetX: lockedContour.imageOffsetX, imageOffsetY: lockedContour.imageOffsetY } : null,
            spotPixelMap
          );
        } else {
          setIsProcessing(false);
          setNoCutlinesDialog({
            pending: true,
            args: { downloadType: downloadType || 'standard', format, spotColors, singleArtboard }
          });
          return;
        }
      }
      // Only reached once a file was actually produced (no-cutlines returns earlier).
    } catch (error) {
      console.error("Download failed:", error);
      console.error("Error details:", {
        hasImage: !!imageInfo,
        hasCanvas: !!canvasRef.current,
        shapeSettings,
        resizeSettings,
        strokeSettings
      });
      alert(`Download failed: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`);
    } finally {
      setIsProcessing(false);
    }
  }, [imageInfo, strokeSettings, resizeSettings, shapeSettings, cutContourLabel, lockedContour, detectedShapeType, detectedShapeInfo]);

  if (isLoadingDesign) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center text-white/80 text-sm">
        Loading design…
      </div>
    );
  }

  // Empty state - no image uploaded (unless we are viewing the gangsheet on the same canvas)
  if (!imageInfo && !(mode === "gangsheet" && gangSheetOpen)) {
    return (
      <>
        <div className="min-h-[70vh] flex items-center justify-center">
          <div className="w-full max-w-xl mx-auto transition-all duration-300 space-y-3">
            <UploadSection
              onImageUpload={handleImageUpload}
              onPDFUpload={handlePDFUpload}
              onSVGUpload={handleSVGUpload}
              showCutLineInfo={false}
              imageInfo={null}
              resizeSettings={resizeSettings}
              stickerSize={stickerSize}
            />
            {mode === "gangsheet" && gangSheetItems.length > 0 && (
              <button
                type="button"
                onClick={() => setGangSheetOpen(true)}
                className="w-full flex items-center justify-center gap-2 py-2.5 text-sm font-medium bg-[#3a6aa0] border border-[#4dff80]/35 text-[#e8eef6] hover:bg-[#4a7ab5] rounded-xl"
              >
                View Gangsheet
                <span className="min-w-[18px] h-[18px] inline-flex items-center justify-center bg-[#4dff80] text-[#05321a] text-[10px] font-bold rounded-full px-1">
                  {gangSheetItems.length}
                </span>
              </button>
            )}
          </div>
        </div>
      </>
    );
  }

  // Loaded state - image uploaded
  return (
    <>
    {isReadOnlyView ? (
      <div className="mb-3 flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
        <span className="text-xs text-amber-900">
          Viewing <strong>{readOnlyOwnerEmail}</strong>&rsquo;s design — read-only
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              const colors = spotPreviewData.colors.map((c) => ({
                hex: c.hex,
                rgb: { ...c.rgb },
                spotWhite: c.spotWhite,
                spotGloss: c.spotGloss,
                spotWhiteName: spotPreviewData.spotWhiteName || "RDG_WHITE",
                spotGlossName: spotPreviewData.spotGlossName || "RDG_GLOSS",
                spotFluorY: c.spotFluorY,
                spotFluorM: c.spotFluorM,
                spotFluorG: c.spotFluorG,
                spotFluorOrange: c.spotFluorOrange,
              }));
              void handleDownload("standard", "pdf", colors);
            }}
            disabled={!imageInfo || isProcessing}
            className="text-xs px-3 py-1.5 rounded-md border border-amber-300 bg-white text-amber-900 hover:bg-amber-100 transition-colors disabled:opacity-50"
          >
            {isProcessing ? "Downloading…" : "Download"}
          </button>
          <button
            type="button"
            onClick={handleEditAsOwnFromView}
            className="text-xs px-3 py-1.5 rounded-md bg-slate-900 text-white hover:bg-slate-800 transition-colors"
          >
            Edit as my own
          </button>
        </div>
      </div>
    ) : isAuthenticated && imageInfo && !gangSheetOpen ? (
      <div className="mb-3 flex items-center justify-end gap-2">
        {currentDesignId && (
          <span className="text-xs text-white/70 truncate max-w-[200px] mr-auto">{currentDesignName}</span>
        )}
        <button
          type="button"
          onClick={() => handleSaveDesign("save-as-new")}
          disabled={isSavingDesign}
          className="text-xs px-3 py-1.5 rounded-md border border-white/20 bg-white/95 text-slate-700 hover:bg-white disabled:opacity-50 transition-colors"
        >
          Save as New
        </button>
        <button
          type="button"
          onClick={() => handleSaveDesign("save")}
          disabled={isSavingDesign}
          className="text-xs px-3 py-1.5 rounded-md bg-[#4dff80] text-[#05321a] hover:bg-[#2ee66a] disabled:opacity-50 transition-colors font-semibold"
        >
          {isSavingDesign ? "Saving…" : currentDesignId ? "Save" : "Save Design"}
        </button>
      </div>
    ) : null}
    <Dialog open={saveNameDialog.open} onOpenChange={(open) => setSaveNameDialog((prev) => ({ ...prev, open }))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{saveNameDialog.mode === "save-as-new" ? "Save as new design" : "Name this design"}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={saveNameValue}
          onChange={(e) => setSaveNameValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleConfirmSaveName(); }}
          placeholder="Untitled design"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setSaveNameDialog({ open: false, mode: null })}>Cancel</Button>
          <Button onClick={handleConfirmSaveName}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {mode === "gangsheet" && !gangSheetOpen && imageInfo && (
      <div className="mb-4 flex items-center gap-3 rounded-xl border-2 border-[#4dff80]/70 bg-[#244e7a] px-3 py-2.5 shadow-lg shadow-black/30">
        <button
          type="button"
          onClick={() => { void handleAddToGangSheet(); }}
          disabled={isProcessing}
          className="flex-1 flex items-center justify-center gap-2.5 h-12 rounded-lg bg-[#4dff80] hover:bg-[#2ee66a] text-[#05321a] text-base font-bold tracking-tight shadow-md disabled:opacity-50 transition-colors"
          title="Add current sticker to the gang sheet for batch printing"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
          Add to Gang Sheet
        </button>
        {gangSheetItems.length > 0 && (
          <button
            type="button"
            onClick={() => setGangSheetOpen(true)}
            className="flex items-center gap-2 h-12 px-4 rounded-lg bg-[#2d5a8a]/50 hover:bg-[#2d5a8a]/70 text-white text-sm font-semibold transition-colors"
          >
            View Gangsheet
            <span className="min-w-[22px] h-[22px] flex items-center justify-center bg-[#4dff80] text-[#05321a] text-xs font-bold rounded-full px-1.5">
              {gangSheetItems.length}
            </span>
            <span className="text-xs text-cyan-100/80">{gangSheetItems.reduce((s, i) => s + clampGangSheetQuantity(i.quantity), 0)} total</span>
          </button>
        )}
      </div>
    )}
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
      {/* Input-only uploader for Change Design; avoids mounting a second upload UI. */}
      <UploadSection
        onImageUpload={handleImageUpload}
        onPDFUpload={handlePDFUpload}
        onSVGUpload={handleSVGUpload}
        inputOnly
        inputId="spot-uv-change-design-input"
      />
      {/* Left sidebar - Settings. Hidden (not unmounted) in read-only / gangsheet view — still needed for color extraction. */}
      <div className={isReadOnlyView || gangSheetOpen ? "hidden" : "lg:col-span-4 xl:col-span-3 space-y-3"}>
        <ControlsSection
          strokeSettings={strokeSettings}
          resizeSettings={resizeSettings}
          shapeSettings={shapeSettings}
          stickerSize={stickerSize}
          cutContourLabel={cutContourLabel}
          onStrokeChange={handleStrokeChange}
          onResizeChange={handleResizeChange}
          onShapeChange={handleShapeChange}
          onStickerSizeChange={handleStickerSizeChange}
          onDownload={handleDownload}
          isProcessing={isProcessing}
          imageInfo={imageInfo}
          canvasRef={canvasRef}
          onStepChange={() => {}}
          onRemoveBackground={handleRemoveBackground}
          isRemovingBackground={isRemovingBackground}
          onChangeDesign={() => document.getElementById('spot-uv-change-design-input')?.click()}
          onClearDesign={imageInfo ? handleClearDesign : undefined}
          onSpotPreviewChange={setSpotPreviewData}
          detectedAlgorithm={detectedAlgorithm}
          segmentationData={segmentationData}
          isSegmenting={isSegmenting}
          onSegmentImage={handleSegmentImage}
          onSegmentationChange={handleSegmentationChange}
          onSegmentLayerToggle={handleSegmentLayerToggle}
          onSegmentLayerLabelChange={handleSegmentLayerLabelChange}
          onSegmentLayerSpotChange={handleSegmentLayerSpotChange}
          highlightedColorIndex={highlightedColor?.colorIndex ?? null}
          highlightedRegionId={highlightedColor?.regionId ?? null}
          onHighlightRegion={(colorIndex, regionId) => {
            setHighlightWithTimer({ colorIndex, regionId });
          }}
          spotPaintMode={spotPaintMode}
          onSpotPaintModeChange={(mode) => {
            setSpotPaintMode(mode);
            if (mode) setMagicWandMode(false);
          }}
          pendingSpotPaint={pendingSpotPaint}
          onSpotPaintApplied={() => setPendingSpotPaint(null)}
          spotColorRestore={spotColorRestore}
          enableSpotColors={spotsEnabled}
        />
      </div>
      {mode === "gangsheet" && gangSheetOpen && (
        <div className="lg:col-span-4 xl:col-span-3 space-y-3">
          <GangSheetPanel
            items={gangSheetItems}
            onItemsChange={setGangSheetItems}
            settings={gangSheetSettings}
            onSettingsChange={setGangSheetSettings}
            onFillSheet={handleFillGangSheet}
            packResult={gangPack}
          />
        </div>
      )}
      
      {/* Right area - Upload, Info, and Preview. Full width in read-only view. */}
      <div className={isReadOnlyView ? "lg:col-span-12" : "lg:col-span-8 xl:col-span-9"}>
        <div className="sticky top-4 space-y-3">
          {gangSheetOpen ? (
            <div className="flex items-center justify-between gap-2 bg-white rounded-lg border border-gray-100 shadow-sm px-3 py-2">
              <button
                type="button"
                onClick={handleFillGangSheet}
                disabled={gangSheetItems.length === 0}
                className="h-10 px-4 rounded-lg bg-[#4dff80] hover:bg-[#2ee66a] disabled:opacity-40 text-[#05321a] text-sm font-bold"
              >
                Fill Sheet
              </button>
              <button
                type="button"
                onClick={() => setGangSheetOpen(false)}
                className="h-10 px-4 rounded-lg bg-[#3a6aa0] hover:bg-[#4a7ab5] text-white text-sm font-semibold"
              >
                Back to Designer
              </button>
            </div>
          ) : null}
          {/* Top row: Actions bar — edit tools only, hidden in read-only / gangsheet view */}
          {!isReadOnlyView && !gangSheetOpen && <div className="flex items-center gap-2 bg-white rounded-lg border border-gray-100 shadow-sm px-3 py-2">
            {imageInfo && (
              <button
                onClick={() => handleRemoveBackground(85)}
                disabled={isRemovingBackground}
                className="group relative flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap text-white shadow-md disabled:opacity-50 overflow-hidden transition-all duration-200 bg-gradient-to-r from-sky-500 to-cyan-500 hover:from-sky-600 hover:to-cyan-600 hover:shadow-lg hover:shadow-sky-200 active:scale-[0.95] active:shadow-sm"
              >
                <span className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out rounded-lg"></span>
                {isRemovingBackground ? (
                  <svg className="relative w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg>
                ) : (
                  <svg className="relative w-4 h-4 transition-transform duration-200 group-hover:rotate-12 group-active:rotate-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M3 9h6"/><path d="M3 15h6"/></svg>
                )}
                <span className="relative">{isRemovingBackground ? 'Removing...' : 'Remove White Background'}</span>
              </button>
            )}

            {imageInfo && (
              <button
                onClick={() => {
                  const next = !magicWandMode;
                  setMagicWandMode(next);
                  if (next) setSpotPaintMode(null);
                }}
                disabled={isRemovingBackground || isMagicWandRunning}
                className={`group relative flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap text-white shadow-md disabled:opacity-50 overflow-hidden transition-all duration-200 active:scale-[0.95] active:shadow-sm ${magicWandMode
                  ? 'bg-gradient-to-r from-fuchsia-600 to-pink-600 hover:from-fuchsia-700 hover:to-pink-700 ring-2 ring-fuchsia-300'
                  : 'bg-gradient-to-r from-fuchsia-500 to-pink-500 hover:from-fuchsia-600 hover:to-pink-600 hover:shadow-lg hover:shadow-fuchsia-200'}`}
                title={magicWandMode ? 'Click on the preview to erase a color region' : 'Magic wand: click to erase any color'}
              >
                <span className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out rounded-lg"></span>
                {isMagicWandRunning ? (
                  <svg className="relative w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg>
                ) : (
                  <svg className="relative w-4 h-4 transition-transform duration-200 group-hover:rotate-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m14 4 6 6"/><path d="M14 4l-2.5 2.5"/><path d="M11.5 6.5 4 14l6 6 7.5-7.5"/><path d="m18 8 4 4"/></svg>
                )}
                <span className="relative">{magicWandMode ? (isMagicWandRunning ? 'Erasing...' : 'Click to Erase') : 'Magic Wand'}</span>
              </button>
            )}

            {magicWandMode && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-fuchsia-50 border border-fuchsia-100">
                <span className="text-[10px] font-semibold text-fuchsia-700 uppercase tracking-wide">Tolerance</span>
                <input
                  type="range"
                  min={0}
                  max={50}
                  step={1}
                  value={Math.round(magicWandTolerance * 100)}
                  onChange={(e) => setMagicWandTolerance(parseInt(e.target.value, 10) / 100)}
                  className="w-28 accent-fuchsia-500"
                  title="Higher = matches more colors. 5-10% works for most solid backgrounds."
                />
                <span className="text-[10px] font-mono text-fuchsia-700 w-7 text-right">{Math.round(magicWandTolerance * 100)}%</span>
              </div>
            )}

            {imageInfo && (
              <button
                onClick={() => { void handleIncreaseQuality(); }}
                disabled={isUpscaling || isRemovingBackground || isMagicWandRunning}
                className="group relative flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap text-white shadow-md disabled:opacity-50 overflow-hidden transition-all duration-200 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 hover:shadow-lg hover:shadow-amber-200 active:scale-[0.95] active:shadow-sm"
                title="Increase print quality with a local 2x/4x upscale"
              >
                <span className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out rounded-lg"></span>
                {isUpscaling ? (
                  <svg className="relative w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg>
                ) : (
                  <svg className="relative w-4 h-4 transition-transform duration-200 group-hover:rotate-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z" /></svg>
                )}
                <span className="relative">{isUpscaling ? 'Increasing…' : 'Increase Quality'}</span>
              </button>
            )}

            {imageInfo && (
              <button
                type="button"
                onClick={() => setQrStudioOpen(true)}
                title={qrScanStatus.message}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold whitespace-nowrap text-white shadow-md bg-indigo-600 hover:bg-indigo-700"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" /><path d="M14 14h3v3h4v4h-7z" />
                </svg>
                QR Repair Studio
                {qrScanStatus.state === "scanning"
                  ? <span className="text-indigo-200">Scanning…</span>
                  : !!imageInfo.qrCodes?.length && <span className="text-indigo-200">({imageInfo.qrCodes.length})</span>}
              </button>
            )}

            <div className="flex-1"></div>
            
            {lockedContour && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-indigo-50 rounded border border-indigo-200">
                <div className="w-2 h-2 rounded-full bg-indigo-500"></div>
                <span className="text-[10px] text-indigo-600 font-medium">{lockedContour.label}</span>
                <svg className="w-2.5 h-2.5 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                <button
                  onClick={() => setLockedContour(null)}
                  className="ml-0.5 text-indigo-400 hover:text-indigo-600 transition-colors"
                  title="Remove locked contour"
                >
                  <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            )}
          </div>}

          {/* Preview - Square */}
          <PreviewSection
            ref={canvasRef}
            isEnhancing={isUpscaling}
            onPreviewStatus={handlePreviewStatus}
            imageInfo={imageInfo}
            strokeSettings={debouncedStrokeSettings}
            resizeSettings={debouncedResizeSettings}
            shapeSettings={debouncedShapeSettings}
            cadCutBounds={cadCutBounds}
            spotPreviewData={spotPreviewData}
            showCutLineInfo={false}
            onDetectedAlgorithm={setDetectedAlgorithm}
            detectedShapeType={detectedShapeType}
            detectedShapeInfo={detectedShapeInfo}
            detectedAlgorithm={detectedAlgorithm}
            onStrokeChange={handleStrokeChange}
            lockedContour={lockedContour}
            segmentationData={segmentationData}
            fileName={imageInfo?.file?.name}
            onResizeChange={handleResizeChange}
            onUndo={handleUndo}
            onRedo={handleRedo}
            canUndo={canUndo}
            canRedo={canRedo}
            readOnly={isReadOnlyView || gangSheetOpen}
            gangSheetView={gangSheetView}
            spotPaintMode={spotPaintMode}
            magicWandMode={magicWandMode}
            onMagicWandPick={handleMagicWandClick}
            onSpotColorClick={(colorIndex, regionId) => {
              if (spotPaintMode) {
                if (snapshotTimerRef.current) {
                  clearTimeout(snapshotTimerRef.current);
                  snapshotTimerRef.current = null;
                }
                pushSnapshot();
                setPendingSpotPaint({ colorIndex, regionId, mode: spotPaintMode, id: Date.now() });
              }
              setHighlightWithTimer({ colorIndex, regionId });
            }}
          />
        </div>
      </div>
      
      {noCutlinesDialog.pending && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-xs mx-4 text-center">
            <div className="text-lg font-semibold text-gray-800 mb-2">No cutlines?</div>
            <p className="text-sm text-gray-500 mb-5">Your download won't include cut lines. Continue anyway?</p>
            <div className="flex gap-3">
              <button
                onClick={() => setNoCutlinesDialog({ pending: false, args: null })}
                className="flex-1 px-4 py-2.5 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 transition-colors"
              >
                No
              </button>
              <button
                onClick={async () => {
                  const args = noCutlinesDialog.args;
                  setNoCutlinesDialog({ pending: false, args: null });
                  if (!imageInfo) return;
                  setIsProcessing(true);
                  try {
                    const nameWithoutExt = imageInfo.file.name.replace(/\.[^/.]+$/, '');
                    if (args?.format === 'pdf') {
                      const noCtlinesSpotPixelMap = (spotPreviewData.pixelMap && spotPreviewData.mapWidth && spotPreviewData.mapHeight)
                        ? { pixelMap: spotPreviewData.pixelMap, mapWidth: spotPreviewData.mapWidth, mapHeight: spotPreviewData.mapHeight }
                        : undefined;
                      await downloadDesignOnlyPDF(
                        imageInfo.image,
                        resizeSettings,
                        `${nameWithoutExt}.pdf`,
                        args.spotColors,
                        args.singleArtboard,
                        { qrCodes: imageInfo.qrCodes, enabled: imageInfo.qrRerenderEnabled === true },
                        noCtlinesSpotPixelMap,
                        imageInfo
                      );
                    } else {
                      const dpi = 300;
                      await downloadCanvas(
                        imageInfo.image,
                        strokeSettings,
                        resizeSettings.widthInches,
                        resizeSettings.heightInches,
                        dpi,
                        `${nameWithoutExt}.png`,
                        undefined
                      );
                    }
                  } catch (error) {
                    console.error("Download failed:", error);
                  } finally {
                    setIsProcessing(false);
                  }
                }}
                className="flex-1 px-4 py-2.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 transition-colors"
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}

      {isUpscaling && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-slate-900 border border-slate-700/50 rounded-2xl p-8 max-w-sm mx-4 text-center shadow-2xl">
            <div className="relative w-16 h-16 mx-auto mb-5">
              <div className="absolute inset-0 rounded-full border-4 border-slate-700"></div>
              <div className="absolute inset-0 rounded-full border-4 border-t-transparent animate-spin border-amber-500"></div>
              <div className="absolute inset-0 flex items-center justify-center">
                <svg className="w-6 h-6 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z" /></svg>
              </div>
            </div>
            <div className="text-white text-lg font-semibold mb-2">Increasing Quality</div>
            <div className="text-sm mb-4 text-amber-300">{enhanceStage || 'Starting up...'}</div>
            <p className="text-xs text-slate-400">This may take up to a minute. Please wait.</p>
          </div>
        </div>
      )}

      {imageInfo && qrStudioOpen && (
        <QRRepairStudio
          open={qrStudioOpen}
          onOpenChange={setQrStudioOpen}
          image={imageInfo.image}
          qrCodes={imageInfo.qrCodes ?? []}
          onApply={handleApplyQRRepairs}
          onScan={deep => runQRDetection(imageInfo.image, { force: true, deep })}
          onCancelScan={cancelQRScan}
          scanStatus={qrScanStatus}
          printScale={resizeSettings.widthInches * 300 / (imageInfo.image.naturalWidth || imageInfo.image.width)}
          printScaleY={resizeSettings.heightInches * 300 / (imageInfo.image.naturalHeight || imageInfo.image.height)}
        />
      )}

      {/* Processing Modal */}
      {isProcessing && !isUpscaling && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-slate-900 border border-slate-700/50 rounded-lg p-6 max-w-sm mx-4">
            <div className="flex items-center space-x-3">
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-indigo-500 border-t-transparent"></div>
              <span className="text-white">Processing...</span>
            </div>
          </div>
        </div>
      )}

    </div>
    </>
  );
}
