import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { StrokeSettings, ResizeSettings, ImageInfo, ShapeSettings, StickerSize, type SegmentationData } from "./image-editor";
import { STICKER_SIZES } from "./lib/types";
import { useToast } from "@/hooks/use-toast";
import { generateContourPDFBase64 } from "./lib/contour-outline";
import { generateShapePDFBase64, calculateShapeDimensions } from "./lib/shape-outline";
import { getContourWorkerManager, type DetectedAlgorithm } from "./lib/contour-worker-manager";
import { extractColorsFromImageAsync, detectColorRegionsAsync, ExtractedColor, type ColorExtractionResult } from "./lib/color-extractor";
import { mergeDetectedColorRegions } from "./lib/spot-selection-state";
import { Download, ChevronDown, ChevronUp, Eye, EyeOff, X, Layers, Palette, Pipette, Trash2, Link, Unlink, Settings2, Spline, Shapes } from "lucide-react";
import SizeInput from "@/components/image-editor/size-input";

export interface SpotPreviewData {
  enabled: boolean;
  colors: ExtractedColor[];
  pixelMap?: Int16Array;
  mapWidth?: number;
  mapHeight?: number;
  /**
   * User-editable spot color separation labels. Default to RDG_WHITE /
   * RDG_GLOSS in the controls section. Threaded into SpotPreviewData so
   * downstream consumers (e.g. the gang sheet add-to handler) can apply
   * the same custom names that single-design downloads use.
   */
  spotWhiteName?: string;
  spotGlossName?: string;
}

interface ControlsSectionProps {
  strokeSettings: StrokeSettings;
  resizeSettings: ResizeSettings;
  shapeSettings: ShapeSettings;
  stickerSize: StickerSize;
  // Current export label (may be a manual override of what was actually detected in the file) — compared against pdfCutContourInfo.detectedLabel to explain any mismatch.
  cutContourLabel?: 'CutContour' | 'PerfCutContour' | 'KissCut';
  onStrokeChange: (settings: Partial<StrokeSettings>) => void;
  onResizeChange: (settings: Partial<ResizeSettings>) => void;
  onShapeChange: (settings: Partial<ShapeSettings>) => void;
  onStickerSizeChange: (size: StickerSize) => void;
  onDownload: (downloadType?: 'standard' | 'highres' | 'vector' | 'cutcontour' | 'design-only' | 'download-package', format?: 'png' | 'pdf' | 'eps' | 'svg', spotColors?: Array<{hex: string; rgb: {r: number; g: number; b: number}; spotWhite: boolean; spotGloss: boolean; spotWhiteName?: string; spotGlossName?: string; spotFluorY: boolean; spotFluorM: boolean; spotFluorG: boolean; spotFluorOrange: boolean; spotFluorYName?: string; spotFluorMName?: string; spotFluorGName?: string; spotFluorOrangeName?: string}>, singleArtboard?: boolean) => void;
  isProcessing: boolean;
  imageInfo: ImageInfo | null;
  canvasRef?: React.RefObject<HTMLCanvasElement>;
  onStepChange?: (step: number) => void;
  onRemoveBackground?: (threshold: number) => void;
  isRemovingBackground?: boolean;
  onSpotPreviewChange?: (data: SpotPreviewData) => void;
  detectedAlgorithm?: DetectedAlgorithm;
  segmentationData?: SegmentationData;
  isSegmenting?: boolean;
  onSegmentImage?: () => void;
  onSegmentationChange?: (data: Partial<SegmentationData>) => void;
  onSegmentLayerToggle?: (layerId: string) => void;
  onSegmentLayerLabelChange?: (layerId: string, label: string) => void;
  onSegmentLayerSpotChange?: (layerId: string, field: 'spotWhite' | 'spotGloss', value: boolean) => void;
  highlightedColorIndex?: number | null;
  highlightedRegionId?: number | null;
  onHighlightRegion?: (colorIndex: number, regionId: number | null) => void;
  onChangeDesign?: () => void;
  onClearDesign?: () => void;
  spotPaintMode?: 'white' | 'gloss' | 'both' | 'clear' | null;
  onSpotPaintModeChange?: (mode: 'white' | 'gloss' | 'both' | 'clear' | null) => void;
  pendingSpotPaint?: { colorIndex: number; regionId: number | null; mode: string; id: number } | null;
  onSpotPaintApplied?: () => void;
  spotColorRestore?: { colors: ExtractedColor[]; id: number; spotWhiteName?: string; spotGlossName?: string } | null;
  enableSpotColors?: boolean;
}

export default function ControlsSection({
  strokeSettings,
  resizeSettings,
  shapeSettings,
  stickerSize,
  cutContourLabel,
  onStrokeChange,
  onResizeChange,
  onShapeChange,
  onStickerSizeChange,
  onDownload,
  isProcessing,
  imageInfo,
  canvasRef,
  onStepChange,
  onRemoveBackground,
  isRemovingBackground,
  onSpotPreviewChange,
  detectedAlgorithm,
  segmentationData,
  isSegmenting,
  onSegmentImage,
  onSegmentationChange,
  onSegmentLayerToggle,
  onSegmentLayerLabelChange,
  onSegmentLayerSpotChange,
  highlightedColorIndex,
  highlightedRegionId,
  onHighlightRegion,
  onChangeDesign,
  onClearDesign,
  spotPaintMode,
  onSpotPaintModeChange,
  pendingSpotPaint,
  onSpotPaintApplied,
  spotColorRestore,
  enableSpotColors = true,
}: ControlsSectionProps) {
  const { toast } = useToast();
  const [showSpotColors, setShowSpotColors] = useState(false);
  const [extractedColors, setExtractedColors] = useState<ExtractedColor[]>([]);
  const [isExtractingColors, setIsExtractingColors] = useState(false);
  const [spotPreviewEnabled, setSpotPreviewEnabled] = useState(true);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerNotes, setCustomerNotes] = useState("");
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [showSendForm, setShowSendForm] = useState(false);
  const [showSizeSection, setShowSizeSection] = useState(false);
  const [spotWhiteName, setSpotWhiteName] = useState("RDG_WHITE");
  const [spotGlossName, setSpotGlossName] = useState("RDG_GLOSS");
  const [expandedColorIndex, setExpandedColorIndex] = useState<number | null>(null);
  const [showOutlineType, setShowOutlineType] = useState(true);
  const [showShapeAdvanced, setShowShapeAdvanced] = useState(false);
  const [contourPanelOpen, setContourPanelOpen] = useState(true);
  const [shapePanelOpen, setShapePanelOpen] = useState(true);
  const [transparentFillNotice, setTransparentFillNotice] = useState<'contour' | 'shape' | null>(null);
  const [acknowledgedTransparentPreview, setAcknowledgedTransparentPreview] = useState(false);
  const colorListRef = useRef<HTMLDivElement>(null);

  const canDownload = !!imageInfo;
  const extractionRef = useRef<ColorExtractionResult | null>(null);

  const fillPalette = (() => {
    const base = ['#FFFFFF', '#000000', '#FF0000', '#0066FF', '#00AA00'];
    const designHexes = extractedColors.slice(0, 3).map(c => c.hex.toUpperCase());
    // Colours the user removed via "Remove Color" go first (most-recent first
    // — that's the order they're stored in). They typically want to put one
    // of those exact colours back behind the cut contour (or use it as bleed)
    // once the cutline has been traced against the transparent design.
    const removed = (imageInfo?.removedColors ?? []).map((c) => c.toUpperCase());
    const ordered = [...removed, ...base, ...designHexes];
    const merged = Array.from(new Set(ordered));
    // Make room for every removed colour plus the base palette; cap so the
    // strip doesn't grow unbounded.
    return merged.slice(0, Math.max(5, removed.length) + 5).slice(0, 9);
  })();

  const applyTransparentFill = (target: 'contour' | 'shape') => {
    if (target === 'shape') {
      onShapeChange({ fillColor: 'transparent' });
    } else {
      onStrokeChange({ backgroundColor: 'transparent' });
    }
  };

  const requestTransparentFill = (target: 'contour' | 'shape') => {
    const current = target === 'shape' ? shapeSettings.fillColor : strokeSettings.backgroundColor;
    if (current === 'transparent') return;
    if (acknowledgedTransparentPreview) {
      applyTransparentFill(target);
      return;
    }
    setTransparentFillNotice(target);
  };

  const acceptTransparentPreview = () => {
    if (transparentFillNotice) applyTransparentFill(transparentFillNotice);
    setAcknowledgedTransparentPreview(true);
    setTransparentFillNotice(null);
  };

  const keepWhiteFill = () => {
    if (transparentFillNotice === 'shape') {
      onShapeChange({ fillColor: '#FFFFFF' });
    } else {
      onStrokeChange({ backgroundColor: '#FFFFFF' });
    }
    setTransparentFillNotice(null);
  };

  const whiteVinylFillNotice = (
    <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-2">
      <p className="text-[11px] leading-snug text-[#fbbf24]">
        Preview only. These print on white vinyl — anything that looks see-through here will be white.
      </p>
    </div>
  );

  const spotRestoreIdRef = useRef<number>(0);
  useEffect(() => {
    if (!spotColorRestore || spotColorRestore.id === spotRestoreIdRef.current) return;
    spotRestoreIdRef.current = spotColorRestore.id;
    // Also restore custom names — otherwise this component's own defaults overwrite them right back.
    if (spotColorRestore.spotWhiteName) setSpotWhiteName(spotColorRestore.spotWhiteName);
    if (spotColorRestore.spotGlossName) setSpotGlossName(spotColorRestore.spotGlossName);
    setExtractedColors(prev => {
      if (prev.length === 0 && spotColorRestore.colors.length === 0) return prev;
      return spotColorRestore.colors.map((restored, i) => {
        const existing = prev[i];
        if (!existing) return restored;
        return {
          ...existing,
          spotWhite: restored.spotWhite,
          spotGloss: restored.spotGloss,
          regions: existing.regions?.map(r => {
            const restoredRegion = restored.regions?.find(rr => rr.id === r.id);
            if (!restoredRegion) return r;
            return { ...r, spotWhite: restoredRegion.spotWhite, spotGloss: restoredRegion.spotGloss };
          }),
        };
      });
    });
  }, [spotColorRestore]);

  const spotSourceImage = imageInfo?.image;
  const spotSourceUrl = spotSourceImage?.src;

  useEffect(() => {
    if (!enableSpotColors) {
      extractionRef.current = null;
      setExtractedColors([]);
      setIsExtractingColors(false);
      return;
    }
    if (spotSourceImage) {
      let cancelled = false;
      let paletteReady = false;
      extractionRef.current = null;
      setIsExtractingColors(true);
      setExtractedColors([]);
      const rafId = requestAnimationFrame(() => {
        void (async () => {
          try {
            const result = await extractColorsFromImageAsync(spotSourceImage, 999);
            if (cancelled) return;
            extractionRef.current = result;
            setExtractedColors([...result.colors]);
            paletteReady = true;
            setIsExtractingColors(false);

            if (result.width <= 0 || result.height <= 0 || result.colors.length === 0) return;

            const canvas = document.createElement('canvas');
            canvas.width = result.width;
            canvas.height = result.height;
            const ctx = canvas.getContext('2d');
            let imgData: ImageData | undefined;
            if (ctx) {
              ctx.drawImage(spotSourceImage, 0, 0, result.width, result.height);
              imgData = ctx.getImageData(0, 0, result.width, result.height);
            }

            // The detector mutates its input. Do not let it mutate displayed
            // state or replace selections made while its worker was running.
            const regionColors = result.colors.map(color => ({ ...color }));
            await detectColorRegionsAsync(result.pixelMap, result.width, result.height, regionColors, imgData);
            if (cancelled) return;
            setExtractedColors(current => mergeDetectedColorRegions(current, regionColors));
          } catch (err) {
            console.warn('[SpotColors] color extraction failed', err);
            if (!cancelled && !paletteReady) {
              extractionRef.current = null;
              setExtractedColors([]);
              setIsExtractingColors(false);
            }
          }
        })();
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(rafId);
      };
    } else {
      extractionRef.current = null;
      setExtractedColors([]);
      setIsExtractingColors(false);
    }
  // QR results and other metadata replace imageInfo without changing pixels.
  // Only actual artwork changes should reset the editable spot selections.
  }, [spotSourceImage, spotSourceUrl, enableSpotColors]);

  // Auto-expand color and scroll to it when user clicks on canvas
  useEffect(() => {
    if (highlightedColorIndex != null && highlightedColorIndex >= 0) {
      setShowSpotColors(true);
      setShowOutlineType(false);
      const color = extractedColors[highlightedColorIndex];
      if (color?.regions && color.regions.length > 1) {
        setExpandedColorIndex(highlightedColorIndex);
      }
      // Scroll the highlighted color into view
      setTimeout(() => {
        const el = colorListRef.current?.querySelector(`[data-color-index="${highlightedColorIndex}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 100);
    }
  }, [highlightedColorIndex, highlightedRegionId]);

  const handleSpotColorsToggle = () => {
    setShowSpotColors(prev => {
      const next = !prev;
      if (next) setShowOutlineType(false);
      return next;
    });
  };

  const updateSpotColor = (index: number, field: 'spotWhite' | 'spotGloss', value: boolean) => {
    if (value) setSpotPreviewEnabled(true);

    setExtractedColors(prev => prev.map((color, i) => {
      if (i !== index) return color;
      const updated = { ...color, [field]: value };
      if (updated.regions) {
        updated.regions = updated.regions.map(r => ({ ...r, [field]: value }));
      }
      return updated;
    }));
  };

  const cycleSpotAssignment = (index: number) => {
    const color = extractedColors[index];
    const { spotWhite, spotGloss } = color;
    setSpotPreviewEnabled(true);
    if (!spotWhite && !spotGloss) {
      updateSpotColor(index, 'spotWhite', true);
    } else if (spotWhite && !spotGloss) {
      setExtractedColors(prev => prev.map((c, i) => {
        if (i !== index) return c;
        const updated = { ...c, spotWhite: false, spotGloss: true };
        if (updated.regions) {
          updated.regions = updated.regions.map(r => ({ ...r, spotWhite: false, spotGloss: true }));
        }
        return updated;
      }));
    } else if (!spotWhite && spotGloss) {
      updateSpotColor(index, 'spotWhite', true);
    } else {
      setExtractedColors(prev => prev.map((c, i) => {
        if (i !== index) return c;
        const updated = { ...c, spotWhite: false, spotGloss: false };
        if (updated.regions) {
          updated.regions = updated.regions.map(r => ({ ...r, spotWhite: false, spotGloss: false }));
        }
        return updated;
      }));
    }
  };

  const swatchClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSwatchClick = useCallback((index: number) => {
    if (swatchClickTimer.current) {
      clearTimeout(swatchClickTimer.current);
      swatchClickTimer.current = null;
      onHighlightRegion?.(index, null);
      return;
    }
    swatchClickTimer.current = setTimeout(() => {
      swatchClickTimer.current = null;
      onHighlightRegion?.(index, null);
    }, 250);
  }, [onHighlightRegion]);

  useEffect(() => {
    if (!pendingSpotPaint) return;
    const { colorIndex, regionId, mode } = pendingSpotPaint;
    if (colorIndex < 0 || colorIndex >= extractedColors.length) {
      onSpotPaintApplied?.();
      return;
    }
    setSpotPreviewEnabled(true);
    const color = extractedColors[colorIndex];
    const hasRegions = color.regions && color.regions.length > 0;

    if (hasRegions && regionId != null) {
      // Per-shape: toggle spot on the specific region only
      setExtractedColors(prev => prev.map((c, i) => {
        if (i !== colorIndex || !c.regions) return c;
        const updatedRegions = c.regions.map(r => {
          // Initialize undefined spots to false so they don't inherit color-level values
          const baseWhite = r.spotWhite ?? false;
          const baseGloss = r.spotGloss ?? false;
          if (r.id !== regionId) return { ...r, spotWhite: baseWhite, spotGloss: baseGloss };
          if (mode === 'white') return { ...r, spotWhite: !baseWhite, spotGloss: baseGloss };
          if (mode === 'gloss') return { ...r, spotWhite: baseWhite, spotGloss: !baseGloss };
          if (mode === 'both') {
            const allSet = baseWhite && baseGloss;
            return { ...r, spotWhite: !allSet, spotGloss: !allSet };
          }
          if (mode === 'clear') return { ...r, spotWhite: false, spotGloss: false };
          return { ...r, spotWhite: baseWhite, spotGloss: baseGloss };
        });
        // Derive color-level flags: true if ANY region has the assignment
        const anyWhite = updatedRegions.some(r => r.spotWhite);
        const anyGloss = updatedRegions.some(r => r.spotGloss);
        return { ...c, regions: updatedRegions, spotWhite: anyWhite, spotGloss: anyGloss };
      }));
    } else {
      // No regions or no regionId: color-level toggle (legacy behavior)
      if (mode === 'white') {
        updateSpotColor(colorIndex, 'spotWhite', !color.spotWhite);
      } else if (mode === 'gloss') {
        updateSpotColor(colorIndex, 'spotGloss', !color.spotGloss);
      } else if (mode === 'both') {
        const allSet = color.spotWhite && color.spotGloss;
        setExtractedColors(prev => prev.map((c, i) =>
          i === colorIndex ? { ...c, spotWhite: !allSet, spotGloss: !allSet } : c
        ));
      } else if (mode === 'clear') {
        setExtractedColors(prev => prev.map((c, i) =>
          i === colorIndex ? { ...c, spotWhite: false, spotGloss: false } : c
        ));
      }
    }
    onSpotPaintApplied?.();
  }, [pendingSpotPaint]);

  const toggleRegionSpot = (colorIndex: number, regionId: number, field: 'spotWhite' | 'spotGloss') => {
    setSpotPreviewEnabled(true);
    setExtractedColors(prev => prev.map((color, i) => {
      if (i !== colorIndex || !color.regions) return color;
      const updatedRegions = color.regions.map(r =>
        r.id === regionId ? { ...r, [field]: !r[field] } : r
      );
      const anyWhite = updatedRegions.some(r => r.spotWhite);
      const anyGloss = updatedRegions.some(r => r.spotGloss);
      return { ...color, regions: updatedRegions, spotWhite: anyWhite, spotGloss: anyGloss };
    }));
  };

  // Notify parent of spot preview changes (includes pixelMap for fast overlay rendering)
  useEffect(() => {
    const ext = extractionRef.current;
    onSpotPreviewChange?.({
      enabled: spotPreviewEnabled,
      colors: extractedColors,
      pixelMap: ext?.pixelMap,
      mapWidth: ext?.width,
      mapHeight: ext?.height,
      spotWhiteName,
      spotGlossName,
    });
  }, [spotPreviewEnabled, extractedColors, onSpotPreviewChange, spotWhiteName, spotGlossName]);

  const handleSendDesign = async () => {
    if (!customerName.trim() || !customerEmail.trim()) {
      toast({
        title: "Missing Information",
        description: "Please enter your full name and email address.",
        variant: "destructive",
      });
      return;
    }
    setShowConfirmDialog(true);
  };

  const confirmAndSend = async () => {
    setShowConfirmDialog(false);
    setIsSending(true);

    try {
      let pdfBase64 = "";
      
      if (imageInfo?.image) {
        if (strokeSettings.enabled) {
          const workerManager = getContourWorkerManager();
          const cachedData = workerManager.getCachedContourData();
          const result = await generateContourPDFBase64(imageInfo.image, strokeSettings, resizeSettings, cachedData || undefined, undefined, imageInfo);
          pdfBase64 = result || "";
        } else if (shapeSettings.enabled) {
          const result = await generateShapePDFBase64(imageInfo.image, shapeSettings, resizeSettings);
          pdfBase64 = result || "";
        }
      }

      if (!pdfBase64) {
        throw new Error("Failed to generate PDF. Please try again.");
      }

      const formData = new FormData();
      formData.append('customerName', customerName.trim());
      formData.append('customerEmail', customerEmail.trim());
      formData.append('customerNotes', customerNotes.trim());
      formData.append('pdfData', pdfBase64);
      formData.append('stickerSize', stickerSize.toString());
      formData.append('outlineType', strokeSettings.enabled ? 'contour' : 'shape');

      const response = await fetch('/api/send-design', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to send design');
      }

      toast({
        title: "Design Sent Successfully!",
        description: "We've received your design. Check your email for confirmation.",
      });

      setCustomerName("");
      setCustomerEmail("");
      setCustomerNotes("");
      setShowSendForm(false);
    } catch (error) {
      console.error('Error sending design:', error);
      toast({
        title: "Error Sending Design",
        description: error instanceof Error ? error.message : "Please try again later.",
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* All Design Options Card */}
      {/* Add/Change Design button + Clear Design */}
      {onChangeDesign && (
        <div className="flex items-center gap-2">
          <button
            onClick={onChangeDesign}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium bg-[#0e7490] hover:bg-[#0891b2] text-white rounded-xl shadow-md shadow-cyan-900/40 hover:shadow-cyan-500/20 transition-all"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Add/Change Design
          </button>
          {onClearDesign && (
            <button
              onClick={onClearDesign}
              className="p-2.5 rounded-xl border border-red-400/40 text-[#f87171] hover:bg-red-500/15 hover:text-red-300 hover:border-red-400/70 transition-all"
              title="Remove current design (keeps gang sheet)"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      <div className="bg-[#3a6aa0] rounded-xl border border-white/10 shadow-sm overflow-hidden">
        {/* Size Selection - Collapsible */}
        <div className="border-b border-white/10">
          <button
            onClick={() => setShowSizeSection(!showSizeSection)}
            className="flex items-center justify-between w-full px-4 py-3 text-sm font-medium text-[#e8eef6] hover:bg-white/5 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-lg bg-cyan-400/15 flex items-center justify-center">
                <span className="text-[#22d3ee] font-bold text-xs">{Math.max(resizeSettings.widthInches, resizeSettings.heightInches).toFixed(1)}"</span>
              </div>
              <span>Size</span>
            </div>
            {showSizeSection ? <ChevronUp className="h-4 w-4 text-[#9fb3c8]" /> : <ChevronDown className="h-4 w-4 text-[#9fb3c8]" />}
          </button>
          
          {showSizeSection && (
            <div className="px-4 pb-3 space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {STICKER_SIZES.map((size) => {
                  const selected = Math.abs(stickerSize - size.value) < 0.04;
                  return (
                    <button
                      key={size.value}
                      type="button"
                      onClick={() => onStickerSizeChange(size.value)}
                      className={`rounded-md px-2 py-1 text-[11px] font-semibold ${
                        selected ? "bg-[#22d3ee] text-[#2d5a8a]" : "bg-white/10 text-[#e8eef6] hover:bg-white/15"
                      }`}
                    >
                      {size.label}
                    </button>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center justify-center gap-1.5 rounded-lg border-2 border-cyan-500 bg-cyan-100 px-2 py-1.5 shadow-sm">
                <span className="text-[13px] font-bold leading-none tracking-tight text-cyan-900">Size</span>
                <span className="text-[12px] font-bold leading-none text-cyan-900">W</span>
                <SizeInput
                  value={resizeSettings.widthInches}
                  onCommit={(newWidth) => {
                    if (resizeSettings.maintainAspectRatio && imageInfo) {
                      const aspectRatio = resizeSettings.heightInches / resizeSettings.widthInches;
                      onResizeChange({ widthInches: newWidth, heightInches: newWidth * aspectRatio });
                    } else {
                      onResizeChange({ widthInches: newWidth });
                    }
                  }}
                  title="Width"
                  min={0.5}
                  max={24}
                  lang="en"
                />
                <span className="text-[12px] font-semibold text-cyan-900">"</span>
                <button
                  type="button"
                  onClick={() => onResizeChange({ maintainAspectRatio: !resizeSettings.maintainAspectRatio })}
                  className={`flex h-6 w-6 items-center justify-center rounded ${resizeSettings.maintainAspectRatio ? 'bg-white text-cyan-600 shadow-sm' : 'text-cyan-700/70 hover:bg-white/70'}`}
                  title={resizeSettings.maintainAspectRatio ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                >
                  {resizeSettings.maintainAspectRatio ? <Link className="w-3.5 h-3.5" /> : <Unlink className="w-3.5 h-3.5" />}
                </button>
                <span className="text-[12px] font-bold leading-none text-cyan-900">H</span>
                <SizeInput
                  value={resizeSettings.heightInches}
                  onCommit={(newHeight) => {
                    if (resizeSettings.maintainAspectRatio && imageInfo) {
                      const aspectRatio = resizeSettings.widthInches / resizeSettings.heightInches;
                      onResizeChange({ heightInches: newHeight, widthInches: newHeight * aspectRatio });
                    } else {
                      onResizeChange({ heightInches: newHeight });
                    }
                  }}
                  title="Height"
                  min={0.5}
                  max={24}
                  lang="en"
                />
                <span className="text-[12px] font-semibold text-cyan-900">"</span>
              </div>
            </div>
          )}
        </div>

        {/* Outline Type - Collapsible Dropdown */}
        {imageInfo && <div className="border-b border-white/10">
          <button
            onClick={() => setShowOutlineType(!showOutlineType)}
            className={`flex items-center justify-between w-full px-4 py-3 text-left transition-colors ${showOutlineType ? 'bg-cyan-400/10 hover:bg-cyan-400/15' : 'hover:bg-white/5'}`}
          >
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-[#22d3ee]" />
              <span className="text-sm font-medium text-[#e8eef6]">Outline Type</span>
              {(strokeSettings.enabled || shapeSettings.enabled) && (
                <span className="text-xs text-[#9fb3c8]">
                  ({strokeSettings.enabled ? 'Contour' : 'Shape'})
                </span>
              )}
            </div>
            <div className={`p-1 rounded-md transition-all ${showOutlineType ? 'bg-cyan-400/25' : 'bg-white/10 hover:bg-white/15'}`}>
              <ChevronDown className={`w-4 h-4 transition-transform ${showOutlineType ? 'rotate-180 text-[#22d3ee]' : 'text-[#9fb3c8]'}`} />
            </div>
          </button>

          {showOutlineType && (
            <div className="px-4 pb-3 space-y-3">
              {imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour ? (
                <div className="p-2.5 bg-teal-400/10 border border-teal-400/25 rounded-lg">
                  <p className="text-sm font-medium text-[#5eead4]">Cutline already in file</p>
                  {cutContourLabel && cutContourLabel !== (imageInfo.pdfCutContourInfo?.detectedLabel ?? 'CutContour') ? (
                    // Export label was manually overridden away from what the file actually has — say both, so the two badges never silently disagree.
                    <p className="text-xs text-teal-300/80 mt-0.5">File has {imageInfo.pdfCutContourInfo?.detectedLabel ?? 'CutContour'} — exporting as {cutContourLabel}</p>
                  ) : (
                    <p className="text-xs text-teal-300/80 mt-0.5">{imageInfo.pdfCutContourInfo?.detectedLabel ?? 'CutContour'} detected</p>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => {
                      if (strokeSettings.enabled) {
                        setContourPanelOpen(prev => !prev);
                      } else {
                        onShapeChange({ enabled: false });
                        onStrokeChange({ enabled: true });
                        setContourPanelOpen(true);
                      }
                    }}
                    className={`flex items-center gap-2 py-2 px-3 rounded-lg transition-all font-semibold text-sm border-2 ${
                      strokeSettings.enabled
                        ? 'bg-[#0e7490] text-white border-[#22d3ee] shadow-lg shadow-cyan-900/40 ring-2 ring-[#22d3ee]/50'
                        : 'bg-cyan-400/10 text-[#e8eef6] border-cyan-400/30 hover:bg-cyan-400/20 hover:border-[#22d3ee]/50'
                    }`}
                  >
                    <Spline className={`w-4 h-4 ${strokeSettings.enabled ? 'text-white' : 'text-[#22d3ee]'}`} />
                    Contour
                  </button>
                  <button
                    onClick={() => {
                      if (shapeSettings.enabled) {
                        setShapePanelOpen(prev => !prev);
                      } else {
                        onStrokeChange({ enabled: false });
                        onShapeChange({ enabled: true });
                        setShapePanelOpen(true);
                      }
                    }}
                    className={`flex items-center gap-2 py-2 px-3 rounded-lg transition-all font-semibold text-sm border-2 ${
                      shapeSettings.enabled
                        ? 'bg-teal-600 text-white border-[#5eead4] shadow-lg shadow-teal-900/40 ring-2 ring-[#5eead4]/50'
                        : 'bg-teal-400/10 text-[#e8eef6] border-teal-400/30 hover:bg-teal-400/20 hover:border-[#5eead4]/50'
                    }`}
                  >
                    <Shapes className={`w-4 h-4 ${shapeSettings.enabled ? 'text-white' : 'text-[#5eead4]'}`} />
                    Shape
                  </button>
                </div>
              )}

              {/* Contour Settings */}
              {strokeSettings.enabled && contourPanelOpen && !(imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour) && (
                <div className="space-y-3 pt-2 border-t border-white/10">
                  <div>
                    <Label className="text-xs text-[#9fb3c8] font-medium">Contour Margin</Label>
                    <Select
                      value={strokeSettings.width.toString()}
                      onValueChange={(value) => onStrokeChange({ width: parseFloat(value) })}
                    >
                      <SelectTrigger className="mt-2 bg-[#2d5a8a] border-white/15 text-[#e8eef6] text-sm rounded-lg">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {detectedAlgorithm === 'scattered' ? (
                          <>
                            <SelectItem value="0.07">Small</SelectItem>
                            <SelectItem value="0.14">Medium</SelectItem>
                            <SelectItem value="0.25">Large</SelectItem>
                          </>
                        ) : (
                          <>
                            <SelectItem value="0">Zero Hero</SelectItem>
                            <SelectItem value="0.02">Small</SelectItem>
                            <SelectItem value="0.04">Medium</SelectItem>
                            <SelectItem value="0.07">Large</SelectItem>
                            <SelectItem value="0.14">Extra Large</SelectItem>
                            <SelectItem value="0.25">Huge</SelectItem>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div>
                    <Label className="text-xs text-[#9fb3c8] font-medium">Fill Color</Label>
                    <div className="flex items-center gap-3 mt-2">
                      <input
                        type="color"
                        value={strokeSettings.backgroundColor === 'transparent' || strokeSettings.backgroundColor === 'holographic' ? '#FFFFFF' : strokeSettings.backgroundColor}
                        onChange={(e) => onStrokeChange({ backgroundColor: e.target.value })}
                        className="w-8 h-8 rounded-lg cursor-pointer border border-white/20"
                        disabled={strokeSettings.backgroundColor === 'holographic'}
                      />
                      <div className="flex gap-1.5 flex-wrap">
                        <button
                          onClick={() => requestTransparentFill('contour')}
                          className={`w-6 h-6 rounded-lg border relative overflow-hidden transition-all ${strokeSettings.backgroundColor === 'transparent' ? 'ring-2 ring-[#22d3ee] ring-offset-1 ring-offset-[#3a6aa0]' : 'border-white/20 hover:border-white/40'}`}
                          style={{ backgroundColor: '#fff' }}
                          title="Preview only — prints white"
                        >
                          <div 
                            className="absolute inset-0" 
                            style={{
                              background: 'linear-gradient(to top right, transparent calc(50% - 1px), #ef4444 calc(50% - 1px), #ef4444 calc(50% + 1px), transparent calc(50% + 1px))'
                            }}
                          />
                        </button>
                        {fillPalette.map((color) => (
                          <button
                            key={color}
                            onClick={() => onStrokeChange({ backgroundColor: color })}
                            className={`w-6 h-6 rounded-lg border transition-all ${strokeSettings.backgroundColor === color && strokeSettings.backgroundColor !== 'holographic' ? 'ring-2 ring-[#22d3ee] ring-offset-1 ring-offset-[#3a6aa0]' : 'border-white/20 hover:border-white/40'}`}
                            style={{ backgroundColor: color }}
                            title={color}
                          />
                        ))}
                      </div>
                    </div>
                    {strokeSettings.backgroundColor === 'transparent' && whiteVinylFillNotice}
                  </div>

                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="include-holes"
                      checked={strokeSettings.includeHoles ?? false}
                      onCheckedChange={(checked) => onStrokeChange({ includeHoles: !!checked })}
                    />
                    <Label htmlFor="include-holes" className="text-xs text-[#9fb3c8] font-medium cursor-pointer">
                      Include Holes
                    </Label>
                  </div>
                </div>
              )}

              {/* PDF CutContour Options */}
              {imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour && (
                <div className="space-y-3 pt-2 border-t border-white/10">
                  <div className="text-sm font-medium text-[#e8eef6]">PDF Options</div>
                  <div>
                    <Label className="text-xs text-[#9fb3c8]">Fill Color</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <input
                        type="color"
                        value={strokeSettings.backgroundColor === 'transparent' || strokeSettings.backgroundColor === 'holographic' ? '#FFFFFF' : strokeSettings.backgroundColor}
                        onChange={(e) => onStrokeChange({ backgroundColor: e.target.value })}
                        className="w-8 h-8 rounded cursor-pointer border border-white/20"
                        disabled={strokeSettings.backgroundColor === 'holographic'}
                      />
                      <div className="flex gap-1 flex-wrap">
                        <button
                          onClick={() => requestTransparentFill('contour')}
                          className={`w-5 h-5 rounded border relative overflow-hidden ${strokeSettings.backgroundColor === 'transparent' ? 'ring-2 ring-[#22d3ee]' : 'border-white/20'}`}
                          style={{ backgroundColor: '#fff' }}
                          title="Preview only — prints white"
                        >
                          <div 
                            className="absolute inset-0" 
                            style={{
                              background: 'linear-gradient(to top right, transparent calc(50% - 1px), #ef4444 calc(50% - 1px), #ef4444 calc(50% + 1px), transparent calc(50% + 1px))'
                            }}
                          />
                        </button>
                        {fillPalette.map((color) => (
                          <button
                            key={color}
                            onClick={() => onStrokeChange({ backgroundColor: color })}
                            className={`w-5 h-5 rounded border ${strokeSettings.backgroundColor === color && strokeSettings.backgroundColor !== 'holographic' ? 'ring-2 ring-[#22d3ee]' : 'border-white/20'}`}
                            style={{ backgroundColor: color }}
                            title={color}
                          />
                        ))}
                      </div>
                    </div>
                    {strokeSettings.backgroundColor === 'transparent' && whiteVinylFillNotice}
                  </div>
                </div>
              )}

              {/* Shape Settings - Redesigned UX */}
              {shapeSettings.enabled && shapePanelOpen && !(imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour) && (
                <div className="pt-2 border-t border-white/10">
                  {/* ── Visual Shape Picker Grid ── */}
                  <div className="grid grid-cols-3 gap-1.5 px-0.5">
                    {([
                      { type: 'circle' as const, label: 'Circle', svg: <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="2" /> },
                      { type: 'oval' as const, label: 'Oval', svg: <ellipse cx="16" cy="16" rx="15" ry="11" fill="none" stroke="currentColor" strokeWidth="2" /> },
                      { type: 'rounded-rectangle' as const, label: 'Rounded', svg: <rect x="3" y="6" width="26" height="20" rx="5" fill="none" stroke="currentColor" strokeWidth="2" /> },
                      { type: 'square' as const, label: 'Square', svg: <rect x="5" y="5" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" /> },
                      { type: 'rectangle' as const, label: 'Rectangle', svg: <rect x="2" y="7" width="28" height="18" fill="none" stroke="currentColor" strokeWidth="2" /> },
                      { type: 'rounded-square' as const, label: 'Rounded Sq', svg: <rect x="5" y="5" width="22" height="22" rx="5" fill="none" stroke="currentColor" strokeWidth="2" /> },
                    ]).map(s => (
                      <button
                        key={s.type}
                        onClick={() => onShapeChange({ type: s.type })}
                        className={`flex flex-col items-center gap-0.5 py-2 px-1 rounded-lg transition-all ${
                          shapeSettings.type === s.type
                            ? 'bg-teal-400/15 ring-2 ring-[#5eead4] text-[#5eead4] shadow-sm'
                            : 'bg-white/5 text-[#9fb3c8] hover:bg-white/10 hover:text-[#e8eef6]'
                        }`}
                      >
                        <svg width="32" height="32" viewBox="0 0 32 32">{s.svg}</svg>
                        <span className="text-[9px] font-medium leading-tight">{s.label}</span>
                      </button>
                    ))}
                  </div>

                  {/* ── Corner Radius (rounded shapes only) ── */}
                  {(shapeSettings.type === 'rounded-square' || shapeSettings.type === 'rounded-rectangle') && (
                    <div className="mt-2 px-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-[#9fb3c8] w-12">Corners</span>
                        <input
                          type="range" min="0.05" max="1.00" step="0.01"
                          value={shapeSettings.cornerRadius || 0.25}
                          onChange={(e) => onShapeChange({ cornerRadius: parseFloat(e.target.value) })}
                          className="flex-1 h-1.5 bg-white/15 rounded-lg appearance-none cursor-pointer accent-[#5eead4]"
                        />
                        <span className="text-[10px] text-[#9fb3c8] w-8 text-right">{(shapeSettings.cornerRadius || 0.25).toFixed(2)}"</span>
                      </div>
                    </div>
                  )}

                  {/* ── Die Size Badge ── */}
                  {(() => {
                    const autoDims = calculateShapeDimensions(resizeSettings.widthInches, resizeSettings.heightInches, shapeSettings.type, shapeSettings.offset);
                    const wVal = shapeSettings.shapeWidthOverride && shapeSettings.shapeWidthOverride > 0 ? shapeSettings.shapeWidthOverride : autoDims.widthInches;
                    const hVal = shapeSettings.shapeHeightOverride && shapeSettings.shapeHeightOverride > 0 ? shapeSettings.shapeHeightOverride : autoDims.heightInches;
                    return (
                      <div className="mt-3 mx-0.5 p-2 bg-teal-400/10 rounded-lg border border-teal-400/25">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-semibold text-[#5eead4] uppercase tracking-wider">Cut Size</span>
                          <span className="text-sm font-bold text-[#e8eef6]">{wVal.toFixed(2)}" × {hVal.toFixed(2)}"</span>
                        </div>
                      </div>
                    );
                  })()}

                  {/* ── Margin + Fill (Essential Controls) ── */}
                  <div className="mt-3 space-y-2.5 px-0.5">
                    {/* Margin */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <Label className="text-xs text-[#9fb3c8] font-medium">Margin</Label>
                        <span className="text-[10px] text-[#5eead4] font-mono bg-teal-400/15 px-1.5 py-0.5 rounded">{shapeSettings.offset.toFixed(3)}"</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number" min="0" max="2" step="0.0125"
                          value={shapeSettings.offset}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            if (!isNaN(v) && v >= 0) onShapeChange({ offset: Math.min(2, v) });
                          }}
                          className="w-16 h-7 text-xs text-center border border-white/15 rounded-lg px-1 bg-[#2d5a8a] text-[#e8eef6] focus:ring-1 focus:ring-[#5eead4] focus:border-[#5eead4]"
                        />
                        <div className="flex gap-1 flex-1">
                          {[{v:0,l:'Zero'},{v:0.0625,l:'Small'},{v:0.125,l:'Medium'},{v:0.25,l:'Large'},{v:0.40,l:'X-Large'}].map(p => (
                            <button
                              key={p.v}
                              onClick={() => onShapeChange({ offset: p.v })}
                              className={`flex-1 py-1 text-[10px] rounded-md font-medium transition-all ${
                                Math.abs(shapeSettings.offset - p.v) < 0.001
                                  ? 'bg-[#5eead4] text-[#2d5a8a] shadow-sm'
                                  : 'bg-white/10 text-[#9fb3c8] hover:bg-white/15'
                              }`}
                            >
                              {p.l}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Fill Color */}
                    <div>
                      <Label className="text-xs text-[#9fb3c8] font-medium">Fill</Label>
                      <div className="flex items-center gap-2 mt-1.5">
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => requestTransparentFill('shape')}
                            className={`w-7 h-7 rounded-lg border-2 relative overflow-hidden transition-all ${shapeSettings.fillColor === 'transparent' ? 'ring-2 ring-[#5eead4] ring-offset-1 ring-offset-[#3a6aa0]' : 'border-white/20 hover:border-white/40'}`}
                            style={{ backgroundColor: '#fff' }}
                            title="Preview only — prints white"
                          >
                            <div className="absolute inset-0" style={{ background: 'linear-gradient(to top right, transparent calc(50% - 1px), #ef4444 calc(50% - 1px), #ef4444 calc(50% + 1px), transparent calc(50% + 1px))' }} />
                          </button>
                          {fillPalette.map((color) => (
                            <button
                              key={color}
                              onClick={() => onShapeChange({ fillColor: color })}
                              className={`w-7 h-7 rounded-lg border-2 transition-all ${shapeSettings.fillColor === color && shapeSettings.fillColor !== 'holographic' ? 'ring-2 ring-[#5eead4] ring-offset-1 ring-offset-[#3a6aa0]' : 'border-white/20 hover:border-white/40'}`}
                              style={{ backgroundColor: color }}
                              title={color}
                            />
                          ))}
                        </div>
                        <label
                          className="relative flex items-center gap-1 px-2 py-1.5 bg-white/10 hover:bg-white/15 rounded-lg cursor-pointer transition-colors border border-white/15 shadow-sm"
                          title="Pick custom color"
                        >
                          <Palette className="w-3.5 h-3.5 text-[#9fb3c8]" />
                          <span className="text-[10px] font-medium text-[#9fb3c8]">Custom</span>
                          <input
                            type="color"
                            value={shapeSettings.fillColor === 'transparent' || shapeSettings.fillColor === 'holographic' ? '#FFFFFF' : shapeSettings.fillColor}
                            onChange={(e) => onShapeChange({ fillColor: e.target.value })}
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                            disabled={shapeSettings.fillColor === 'holographic'}
                          />
                        </label>
                      </div>
                      {shapeSettings.fillColor === 'transparent' && whiteVinylFillNotice}
                    </div>
                  </div>

                  {/* ── Advanced Settings Toggle ── */}
                  <button
                    onClick={() => setShowShapeAdvanced(!showShapeAdvanced)}
                    className="mt-3 flex items-center gap-1.5 w-full px-1 py-1.5 text-[11px] text-[#9fb3c8] hover:text-[#e8eef6] transition-colors"
                  >
                    <Settings2 className="w-3 h-3" />
                    <span>Advanced</span>
                    <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${showShapeAdvanced ? '' : '-rotate-90'}`} />
                  </button>

                  {/* ── Advanced Settings ── */}
                  {showShapeAdvanced && (
                    <div className="space-y-3 px-0.5 pb-1 border-t border-dashed border-white/10 pt-2">
                      {/* Cut Size Override */}
                      {(() => {
                        const autoDims = calculateShapeDimensions(resizeSettings.widthInches, resizeSettings.heightInches, shapeSettings.type, shapeSettings.offset);
                        const hasOverride = (shapeSettings.shapeWidthOverride && shapeSettings.shapeWidthOverride > 0) || (shapeSettings.shapeHeightOverride && shapeSettings.shapeHeightOverride > 0);
                        const wVal = shapeSettings.shapeWidthOverride && shapeSettings.shapeWidthOverride > 0 ? shapeSettings.shapeWidthOverride : autoDims.widthInches;
                        const hVal = shapeSettings.shapeHeightOverride && shapeSettings.shapeHeightOverride > 0 ? shapeSettings.shapeHeightOverride : autoDims.heightInches;
                        return (
                          <div>
                            <Label className="text-xs text-[#9fb3c8]">Custom Cut Size</Label>
                            <div className="flex items-center gap-1.5 mt-1">
                              <div className="flex-1">
                                <span className="text-[10px] text-[#9fb3c8]">W"</span>
                                <input
                                  type="number" min="0.5" max="20" step="0.1"
                                  value={parseFloat(wVal.toFixed(2))}
                                  onChange={(e) => {
                                    const v = parseFloat(e.target.value);
                                    if (!isNaN(v) && v >= 0.5) {
                                      const changes: Partial<ShapeSettings> = { shapeWidthOverride: v };
                                      if (shapeSettings.lockShapeAspect !== false) {
                                        const ratio = autoDims.heightInches / autoDims.widthInches;
                                        changes.shapeHeightOverride = parseFloat((v * ratio).toFixed(3));
                                      }
                                      onShapeChange(changes);
                                    }
                                  }}
                                  className="w-full h-7 text-xs text-center border border-white/15 rounded px-1 bg-[#2d5a8a] text-[#e8eef6]"
                                />
                              </div>
                              <button
                                onClick={() => onShapeChange({ lockShapeAspect: !(shapeSettings.lockShapeAspect !== false) })}
                                className="mt-3 p-1 rounded hover:bg-white/10 transition-colors"
                                title={shapeSettings.lockShapeAspect !== false ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                              >
                                {shapeSettings.lockShapeAspect !== false
                                  ? <Link className="w-3.5 h-3.5 text-[#5eead4]" />
                                  : <Unlink className="w-3.5 h-3.5 text-[#9fb3c8]" />}
                              </button>
                              <div className="flex-1">
                                <span className="text-[10px] text-[#9fb3c8]">H"</span>
                                <input
                                  type="number" min="0.5" max="20" step="0.1"
                                  value={parseFloat(hVal.toFixed(2))}
                                  onChange={(e) => {
                                    const v = parseFloat(e.target.value);
                                    if (!isNaN(v) && v >= 0.5) {
                                      const changes: Partial<ShapeSettings> = { shapeHeightOverride: v };
                                      if (shapeSettings.lockShapeAspect !== false) {
                                        const ratio = autoDims.widthInches / autoDims.heightInches;
                                        changes.shapeWidthOverride = parseFloat((v * ratio).toFixed(3));
                                      }
                                      onShapeChange(changes);
                                    }
                                  }}
                                  className="w-full h-7 text-xs text-center border border-white/15 rounded px-1 bg-[#2d5a8a] text-[#e8eef6]"
                                />
                              </div>
                            </div>
                            {hasOverride && (
                              <button
                                onClick={() => onShapeChange({ shapeWidthOverride: 0, shapeHeightOverride: 0 })}
                                className="mt-1 text-[10px] text-[#5eead4] hover:text-teal-200 font-medium"
                              >
                                Reset to Auto
                              </button>
                            )}
                          </div>
                        );
                      })()}

                      {/* Border */}
                      <div>
                        <div className="flex items-center justify-between">
                          <Label className="text-xs text-[#9fb3c8]">Printed Border</Label>
                          <input
                            type="checkbox"
                            checked={shapeSettings.strokeEnabled || false}
                            onChange={(e) => onShapeChange({ strokeEnabled: e.target.checked })}
                            className="w-3.5 h-3.5 rounded border-white/20 text-[#5eead4] focus:ring-[#5eead4]"
                          />
                        </div>
                        {shapeSettings.strokeEnabled && (
                          <div className="flex items-center gap-2 mt-1">
                            <input
                              type="color"
                              value={shapeSettings.strokeColor || '#000000'}
                              onChange={(e) => onShapeChange({ strokeColor: e.target.value })}
                              className="w-6 h-6 rounded cursor-pointer border border-white/20"
                            />
                            <input
                              type="range" min="0.5" max="4" step="0.25"
                              value={shapeSettings.strokeWidth || 1}
                              onChange={(e) => onShapeChange({ strokeWidth: parseFloat(e.target.value) })}
                              className="flex-1 h-1.5 bg-white/15 rounded-lg appearance-none cursor-pointer accent-[#5eead4]"
                            />
                            <span className="text-[10px] text-[#9fb3c8] w-8 text-right">{(shapeSettings.strokeWidth || 1).toFixed(1)}pt</span>
                          </div>
                        )}
                      </div>

                      {/* Image Position */}
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <Label className="text-xs text-[#9fb3c8]">Image Position</Label>
                          {(shapeSettings.imageOffsetX || shapeSettings.imageOffsetY || (shapeSettings.imageScale && shapeSettings.imageScale !== 1)) ? (
                            <button
                              onClick={() => onShapeChange({ imageOffsetX: 0, imageOffsetY: 0, imageScale: 1 })}
                              className="text-[9px] text-[#5eead4] hover:text-teal-200 font-medium"
                            >
                              Reset
                            </button>
                          ) : null}
                        </div>
                        <div className="grid grid-cols-3 gap-1.5">
                          <div>
                            <span className="text-[9px] text-[#9fb3c8]">X offset</span>
                            <input
                              type="number" step="0.01"
                              value={shapeSettings.imageOffsetX || 0}
                              onChange={(e) => onShapeChange({ imageOffsetX: parseFloat(e.target.value) || 0 })}
                              className="w-full h-6 text-[10px] text-center border border-white/15 rounded px-1 bg-[#2d5a8a] text-[#e8eef6]"
                            />
                          </div>
                          <div>
                            <span className="text-[9px] text-[#9fb3c8]">Y offset</span>
                            <input
                              type="number" step="0.01"
                              value={shapeSettings.imageOffsetY || 0}
                              onChange={(e) => onShapeChange({ imageOffsetY: parseFloat(e.target.value) || 0 })}
                              className="w-full h-6 text-[10px] text-center border border-white/15 rounded px-1 bg-[#2d5a8a] text-[#e8eef6]"
                            />
                          </div>
                          <div>
                            <span className="text-[9px] text-[#9fb3c8]">Scale %</span>
                            <input
                              type="number" min="50" max="200" step="5"
                              value={Math.round((shapeSettings.imageScale || 1) * 100)}
                              onChange={(e) => {
                                const pct = parseInt(e.target.value);
                                if (!isNaN(pct) && pct >= 50 && pct <= 200) onShapeChange({ imageScale: pct / 100 });
                              }}
                              className="w-full h-6 text-[10px] text-center border border-white/15 rounded px-1 bg-[#2d5a8a] text-[#e8eef6]"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>}

        {/* Spot Colors Button & Panel - hidden on the gangsheet builder for now */}
        {imageInfo && enableSpotColors && (
          <div className="border-b border-white/10">
            <button
              onClick={handleSpotColorsToggle}
              className={`flex items-center justify-between w-full px-4 py-3 text-left hover:bg-white/5 transition-colors ${showSpotColors ? 'bg-amber-400/10' : ''}`}
            >
              <div className="flex items-center gap-2">
                <Palette className="w-4 h-4 text-[#fbbf24]" />
                <span className="text-sm font-medium text-[#e8eef6]">Spot White and Gloss</span>
              </div>
              <ChevronDown className={`w-4 h-4 text-[#9fb3c8] transition-transform ${showSpotColors ? 'rotate-180' : ''}`} />
            </button>

            {showSpotColors && (
              <div className="px-4 pb-3 space-y-3">
              <div className="flex items-center justify-end mb-2">
                <button
                  onClick={() => setSpotPreviewEnabled(!spotPreviewEnabled)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${
                    spotPreviewEnabled 
                      ? 'bg-amber-400/20 text-[#fbbf24] border border-amber-400/40' 
                      : 'bg-white/10 text-[#9fb3c8] border border-white/15 hover:bg-white/15'
                  }`}
                  title={spotPreviewEnabled ? "Hide spot preview" : "Show spot preview"}
                >
                  {spotPreviewEnabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  Preview
                </button>
              </div>

              {extractedColors.some(c => c.percentage >= 1) && (() => {
                const bulkAllWhite = extractedColors.every(c => {
                  if (c.regions && c.regions.length > 0) return c.regions.every(r => r.spotWhite);
                  return c.spotWhite;
                });
                const bulkAllGloss = extractedColors.every(c => {
                  if (c.regions && c.regions.length > 0) return c.regions.every(r => r.spotGloss);
                  return c.spotGloss;
                });
                const bulkAllBoth = bulkAllWhite && bulkAllGloss;
                const applyToAll = (white: boolean, gloss: boolean) => {
                  setSpotPreviewEnabled(true);
                  setExtractedColors(prev => prev.map(c => ({
                    ...c,
                    spotWhite: white,
                    spotGloss: gloss,
                    regions: c.regions?.map(r => ({ ...r, spotWhite: white, spotGloss: gloss }))
                  })));
                };
                return (
                <div className="flex items-center gap-1.5 mb-2">
                  <button
                    onClick={() => applyToAll(!bulkAllWhite, bulkAllGloss)}
                    className={`flex-1 px-2 py-1.5 rounded text-[10px] font-bold transition-all border-2 ${
                      bulkAllWhite
                        ? 'bg-[#fbbf24] text-[#2d5a8a] border-amber-300 shadow-md ring-2 ring-amber-300/50'
                        : 'bg-amber-400/10 text-[#fbbf24] border-amber-400/30 hover:bg-amber-400/20'
                    }`}
                  >
                    All White
                  </button>
                  <button
                    onClick={() => applyToAll(bulkAllWhite, !bulkAllGloss)}
                    className={`flex-1 px-2 py-1.5 rounded text-[10px] font-bold transition-all border-2 ${
                      bulkAllGloss
                        ? 'bg-[#67e8f9] text-[#2d5a8a] border-cyan-300 shadow-md ring-2 ring-cyan-300/50'
                        : 'bg-cyan-400/10 text-[#67e8f9] border-cyan-400/30 hover:bg-cyan-400/20'
                    }`}
                  >
                    All Gloss
                  </button>
                  <button
                    onClick={() => bulkAllBoth ? applyToAll(false, false) : applyToAll(true, true)}
                    className={`flex-1 px-2 py-1.5 rounded text-[10px] font-bold transition-all border-2 ${
                      bulkAllBoth
                        ? 'bg-gradient-to-r from-[#fbbf24] to-[#67e8f9] text-[#2d5a8a] border-amber-300 shadow-md ring-2 ring-cyan-300/40'
                        : 'bg-white/10 text-[#e8eef6] border-white/15 hover:bg-white/15'
                    }`}
                  >
                    All W+G
                  </button>
                  <button
                    onClick={() => applyToAll(false, false)}
                    className="flex-1 px-2 py-1.5 rounded text-[10px] font-bold transition-all border-2 bg-white/5 text-[#9fb3c8] border-white/15 hover:bg-white/10"
                  >
                    Clear
                  </button>
                </div>
                );
              })()}

              {extractedColors.some(c => c.percentage >= 1) && (
                <div className={`flex items-center gap-1.5 mb-2 rounded-lg border transition-all ${spotPaintMode ? 'px-2 py-1.5 bg-cyan-400/10 border-cyan-400/30' : 'border-transparent'}`}>
                  {!spotPaintMode ? (
                    <button
                      onClick={() => onSpotPaintModeChange?.('white')}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-cyan-400/10 text-[#22d3ee] border border-cyan-400/30 hover:bg-cyan-400/20 hover:border-[#22d3ee]/50 hover:shadow-sm transition-all cursor-pointer"
                      title="Activate paint tool to select shapes on the preview"
                    >
                      <Pipette className="w-3.5 h-3.5" />
                      Click & Select From Preview
                    </button>
                  ) : (
                    <button
                      onClick={() => onSpotPaintModeChange?.(null)}
                      className="p-1.5 rounded bg-[#0e7490] text-white shadow-sm transition-all"
                      title="Deactivate paint tool"
                    >
                      <Pipette className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {spotPaintMode && (
                    <>
                      <div className="w-px h-5 bg-white/15" />
                      <button
                        onClick={() => onSpotPaintModeChange?.('white')}
                        className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${spotPaintMode === 'white' ? 'bg-[#fbbf24] text-[#2d5a8a] shadow-sm' : 'text-[#fbbf24] hover:bg-amber-400/15 border border-amber-400/30'}`}
                        title="Toggle White on click"
                      >White</button>
                      <button
                        onClick={() => onSpotPaintModeChange?.('gloss')}
                        className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${spotPaintMode === 'gloss' ? 'bg-[#67e8f9] text-[#2d5a8a] shadow-sm' : 'text-[#67e8f9] hover:bg-cyan-400/15 border border-cyan-400/30'}`}
                        title="Toggle Gloss on click"
                      >Gloss</button>
                      <button
                        onClick={() => onSpotPaintModeChange?.('both')}
                        className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${spotPaintMode === 'both' ? 'bg-gradient-to-r from-[#fbbf24] to-[#67e8f9] text-[#2d5a8a] shadow-sm' : 'text-[#e8eef6] hover:bg-white/10 border border-white/15'}`}
                        title="Toggle White + Gloss on click"
                      >W+G</button>
                      <button
                        onClick={() => onSpotPaintModeChange?.('clear')}
                        className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${spotPaintMode === 'clear' ? 'bg-[#f87171] text-white shadow-sm' : 'text-[#9fb3c8] hover:bg-white/10 border border-white/15'}`}
                        title="Clear spot assignment on click"
                      ><X className="w-3 h-3 inline" /></button>
                    </>
                  )}
                </div>
              )}
              
              {isExtractingColors ? (
                <div className="text-xs text-[#9fb3c8] italic">Detecting colors…</div>
              ) : !extractedColors.some(c => c.percentage >= 1) ? (
                <div className="text-xs text-[#9fb3c8] italic">No colors detected</div>
              ) : (
                <>
                <div ref={colorListRef} className="space-y-2 max-h-[400px] overflow-y-auto">
                  {extractedColors.map((color, index) => ({ color, index })).filter(({ color }) => color.percentage >= 1).map(({ color, index }) => {
                    const hasRegions = color.regions && color.regions.length > 1;
                    const isExpanded = expandedColorIndex === index;
                    const isHighlighted = highlightedColorIndex === index;

                    const allWhite = hasRegions ? color.regions!.every(r => r.spotWhite) : color.spotWhite;
                    const someWhite = hasRegions ? color.regions!.some(r => r.spotWhite) : color.spotWhite;
                    const allGloss = hasRegions ? color.regions!.every(r => r.spotGloss) : color.spotGloss;
                    const someGloss = hasRegions ? color.regions!.some(r => r.spotGloss) : color.spotGloss;
                    const mixedWhite = someWhite && !allWhite;
                    const mixedGloss = someGloss && !allGloss;

                    return (
                      <div key={index} data-color-index={index} className={`bg-[#2d5a8a] rounded border transition-all ${isHighlighted ? 'border-[#22d3ee] ring-2 ring-[#22d3ee]/40' : 'border-white/10'}`}>
                        <div className="flex items-center gap-3 p-2">
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {hasRegions && (
                              <button
                                onClick={() => setExpandedColorIndex(isExpanded ? null : index)}
                                className="p-0.5 hover:bg-white/10 rounded"
                                title={`${color.regions!.length} shapes`}
                              >
                                {isExpanded ? <ChevronUp className="w-3 h-3 text-[#9fb3c8]" /> : <ChevronDown className="w-3 h-3 text-[#9fb3c8]" />}
                              </button>
                            )}
                            <div
                              className="w-8 h-8 rounded-lg cursor-pointer transition-all border border-white/20 hover:border-white/40"
                              style={{ backgroundColor: color.hex }}
                              title="Click to highlight on canvas"
                              onClick={() => handleSwatchClick(index)}
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-mono text-[#e8eef6] truncate">{color.name || color.hex}</div>
                            <div className="text-[10px] text-[#9fb3c8]">
                              {color.hex} - {color.percentage.toFixed(1)}%
                              {hasRegions && <span className="ml-1 text-[#22d3ee]">({color.regions!.length} shapes)</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={(e) => { e.stopPropagation(); updateSpotColor(index, 'spotWhite', !color.spotWhite); }}
                              className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${
                                allWhite
                                  ? 'bg-[#fbbf24] text-[#2d5a8a] shadow-sm'
                                  : someWhite
                                  ? 'bg-amber-400/30 text-[#fbbf24] border border-amber-400/40'
                                  : 'text-[#fbbf24] hover:bg-amber-400/15 border border-amber-400/30'
                              }`}
                              title={allWhite ? 'Remove White from all shapes' : someWhite ? `White on some shapes (${color.regions?.filter(r => r.spotWhite).length}/${color.regions?.length})` : 'Apply White to all shapes'}
                            >White</button>
                            <button
                              onClick={(e) => { e.stopPropagation(); updateSpotColor(index, 'spotGloss', !color.spotGloss); }}
                              className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${
                                allGloss
                                  ? 'bg-[#67e8f9] text-[#2d5a8a] shadow-sm'
                                  : someGloss
                                  ? 'bg-cyan-400/30 text-[#67e8f9] border border-cyan-400/40'
                                  : 'text-[#67e8f9] hover:bg-cyan-400/15 border border-cyan-400/30'
                              }`}
                              title={allGloss ? 'Remove Gloss from all shapes' : someGloss ? `Gloss on some shapes (${color.regions?.filter(r => r.spotGloss).length}/${color.regions?.length})` : 'Apply Gloss to all shapes'}
                            >Gloss</button>
                          </div>
                        </div>
                        {hasRegions && isExpanded && (
                          <div className="border-t border-white/10 px-2 pb-2 pt-1 space-y-1">
                            <span className="text-[10px] text-[#9fb3c8] font-medium">Shapes:</span>
                            {color.regions!.map((region) => {
                              const isRegionHighlighted = isHighlighted && highlightedRegionId === region.id;
                              return (
                              <div
                                key={region.id}
                                className={`flex items-center gap-2 px-1 py-0.5 rounded cursor-pointer transition-all ${isRegionHighlighted ? 'bg-cyan-400/15 ring-2 ring-[#22d3ee]' : 'hover:bg-white/5'}`}
                                onClick={() => onHighlightRegion?.(index, region.id)}
                              >
                                {region.thumbnailUrl ? (
                                  <img src={region.thumbnailUrl} alt={`Shape ${region.id + 1}`} className="w-7 h-7 rounded border border-white/15 object-contain bg-[#3a6aa0] flex-shrink-0" />
                                ) : (
                                  <div className="w-5 h-5 rounded border border-white/20 flex-shrink-0" style={{ backgroundColor: color.hex }} />
                                )}
                                <span className="text-[10px] text-[#e8eef6] flex-1">Shape {region.id + 1}</span>
                                <div className="flex items-center gap-0.5 ml-auto">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); toggleRegionSpot(index, region.id, 'spotWhite'); }}
                                    className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition-all ${region.spotWhite ? 'bg-[#fbbf24] text-[#2d5a8a] shadow-sm' : 'text-[#fbbf24] hover:bg-amber-400/15 border border-amber-400/30'}`}
                                    title={region.spotWhite ? 'Remove White' : 'Add White'}
                                  >White</button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); toggleRegionSpot(index, region.id, 'spotGloss'); }}
                                    className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition-all ${region.spotGloss ? 'bg-[#67e8f9] text-[#2d5a8a] shadow-sm' : 'text-[#67e8f9] hover:bg-cyan-400/15 border border-cyan-400/30'}`}
                                    title={region.spotGloss ? 'Remove Gloss' : 'Add Gloss'}
                                  >Gloss</button>
                                </div>
                                <span className="text-[10px] text-[#9fb3c8] w-8 text-right">{region.percentage}%</span>
                              </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                </>
              )}

              </div>
            )}
          </div>
        )}

        {/* Download Buttons */}
        <div className="px-4 py-3 space-y-2">
          <Button
            onClick={() => onDownload('standard', 'pdf', extractedColors.map(c => ({
              ...c,
              spotWhiteName,
              spotGlossName,
              spotFluorY: false,
              spotFluorM: false,
              spotFluorG: false,
              spotFluorOrange: false,
            })))}
            disabled={isProcessing || !canDownload}
            className="w-full h-11 bg-[#0e7490] hover:bg-[#0891b2] text-white rounded-lg shadow-lg shadow-cyan-900/40 font-medium"
          >
            {isProcessing ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                Processing...
              </>
            ) : (
              <>
                <Download className="w-5 h-5 mr-2" />
                Download PDF
              </>
            )}
          </Button>
        </div>
      </div>

      <Dialog
        open={!!transparentFillNotice}
        onOpenChange={(open) => { if (!open) setTransparentFillNotice(null); }}
      >
        <DialogContent className="bg-[#3a6aa0] border-white/10 text-[#e8eef6] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[#e8eef6]">These print on white vinyl</DialogTitle>
            <DialogDescription className="text-[#9fb3c8] text-sm leading-relaxed">
              Transparent is only a preview aid so you can see your artwork more clearly.
              Spot UV stickers are white vinyl, not clear. Anything that looks see-through
              here will print as white.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-col gap-2 sm:space-x-0">
            <Button
              onClick={keepWhiteFill}
              className="w-full bg-[#0e7490] hover:bg-[#0891b2] text-white"
            >
              Use white fill
            </Button>
            <Button
              variant="ghost"
              onClick={acceptTransparentPreview}
              className="w-full text-[#9fb3c8] hover:text-[#e8eef6] hover:bg-white/10"
            >
              I understand — preview as transparent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm Dialog */}
      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent className="bg-white border-gray-200">
          <DialogHeader>
            <DialogTitle className="text-gray-900">Confirm Send</DialogTitle>
            <DialogDescription className="text-gray-500">
              Send your design to {customerEmail}?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowConfirmDialog(false)}>Cancel</Button>
            <Button onClick={confirmAndSend} className="bg-emerald-600 hover:bg-emerald-700 text-white">Send</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
