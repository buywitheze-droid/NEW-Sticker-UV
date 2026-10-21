import { useEffect, useLayoutEffect, useRef, forwardRef, useImperativeHandle, useState, useCallback } from "react";
import { ZoomIn, ZoomOut, RotateCcw, ImageIcon, Loader2, Scan, Link, Unlink, Undo2, Redo2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import SizeInput from "@/components/image-editor/size-input";

import { ImageInfo, StrokeSettings, ResizeSettings, ShapeSettings, type LockedContour, type SegmentationData } from "./image-editor";
import { SpotPreviewData } from "./controls-section";
import { CadCutBounds } from "./lib/cadcut-bounds";
import { processContourInWorker, type DetectedAlgorithm, type DetectedShapeInfo } from "./lib/contour-worker-manager";
import { resolveShapeDimensions, traceShapeCanvasPath } from "./lib/shape-outline";
import { cropImageToContent, getImageBounds } from "./lib/image-crop";
import { convertPolygonToCurves, gaussianSmoothContour } from "./lib/clipper-path";
import { drawVectorQRsOnCanvas2D } from "./lib/qr";
import { drawGangSheetPreview } from "./lib/gang-sheet-preview";
import { gangSheetPreviewResolution } from "./lib/gang-sheet-preview-resolution";
import type { GangSheetItem, GangSheetSettings, PackResult } from "./lib/gang-sheet";
import { createSpotOverlayCanvas as buildSpotOverlayCanvas, overlayCacheKey } from "./lib/spot-overlay";
import { defaultOverlayPreviewStyle, overlayById, overlayByRole, overlayInkBox } from "./lib/imported-overlay";
import { overlayPolylinesForPreview, alignedOverlayPaths } from "./lib/overlay-export";
import { applyOverlayUserNudge, applyOverlayUserScale } from "./lib/overlay-align";

export interface GangSheetCanvasView {
  items: GangSheetItem[];
  settings: GangSheetSettings;
  packResult: PackResult;
}

// Display-only fit inset, in backing-canvas pixels (already DPR-scaled).
// 100% means this padded fit, not physical print size or source-pixel size.
// All render branches use the same inset; their recorded image rectangles
// remain the source of truth for pointer maps, spot paint, and overlays.
const previewFitInset = (width: number, height: number) => Math.min(width, height) * 0.12;

interface PreviewSectionProps {
  isEnhancing?: boolean;
  onPreviewStatus?: (image: HTMLImageElement, status: 'processing' | 'ready' | 'error', error?: Error) => void;
  imageInfo: ImageInfo | null;
  strokeSettings: StrokeSettings;
  resizeSettings: ResizeSettings;
  shapeSettings: ShapeSettings;
  cadCutBounds?: CadCutBounds | null;
  spotPreviewData?: SpotPreviewData;
  showCutLineInfo?: boolean;
  onDetectedAlgorithm?: (algo: DetectedAlgorithm) => void;
  detectedShapeType?: 'circle' | 'oval' | 'square' | 'rectangle' | null;
  detectedShapeInfo?: DetectedShapeInfo | null;
  detectedAlgorithm?: DetectedAlgorithm;
  onStrokeChange?: (settings: Partial<StrokeSettings>) => void;
  lockedContour?: LockedContour | null;
  segmentationData?: SegmentationData;
  onSpotColorClick?: (colorIndex: number, regionId: number | null) => void;
  spotPaintMode?: 'white' | 'gloss' | 'both' | 'clear' | null;
  magicWandMode?: boolean;
  onMagicWandPick?: (imageX: number, imageY: number) => void;
  onOverlayAlignmentChange?: (id: string, patch: Partial<import("./lib/imported-overlay").ImportedVectorOverlay["alignment"]>) => void;
  selectedOverlayId?: string | null;
  onOverlaySelect?: (id: string) => void;
  fileName?: string;
  onResizeChange?: (settings: Partial<ResizeSettings>) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  // Admin's read-only "View" — hides the size controls/undo-redo/background swatches above the canvas.
  readOnly?: boolean;
  /** When set, the existing preview canvas shows the packed gangsheet instead of the current design. */
  gangSheetView?: GangSheetCanvasView | null;
}

const PreviewSection = forwardRef<HTMLCanvasElement, PreviewSectionProps>(
  ({ imageInfo, strokeSettings, resizeSettings, shapeSettings, cadCutBounds, spotPreviewData, showCutLineInfo, onDetectedAlgorithm, detectedShapeType, detectedShapeInfo, detectedAlgorithm, onStrokeChange, lockedContour, segmentationData, onSpotColorClick, spotPaintMode, magicWandMode, onMagicWandPick, onOverlayAlignmentChange, selectedOverlayId, onOverlaySelect, fileName, onResizeChange, onUndo, onRedo, canUndo, canRedo, readOnly, gangSheetView, isEnhancing, onPreviewStatus }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const frameRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(1);
    const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
    const zoomRef = useRef(1);
    const [backgroundColor, setBackgroundColor] = useState("#1e3a5f");
    const lastImageRef = useRef<string | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [processingProgress, setProcessingProgress] = useState(0);
    const contourCacheRef = useRef<{key: string; canvas: HTMLCanvasElement; downsampleScale: number; imageCanvasX: number; imageCanvasY: number} | null>(null);
    const processingIdRef = useRef(0);
    const [showHighlight, setShowHighlight] = useState(false);
    const lastSettingsRef = useRef<string>('');
    const contourDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastImageRenderRef = useRef<{x: number; y: number; width: number; height: number} | null>(null);
    const overlayDragRef = useRef<{
      id: string;
      mode: "move" | "scale";
      startClientX: number;
      startClientY: number;
      startAlign: import("./lib/imported-overlay").ImportedVectorOverlay["alignment"];
      startBox: { minX: number; minY: number; width: number; height: number };
      print: { widthInches: number; heightInches: number };
    } | null>(null);
    const [overlayCursor, setOverlayCursor] = useState<string | null>(null);
    const [previewDims, setPreviewDims] = useState({ width: 360, height: 360 });
    const spotPulseRef = useRef(1);
    const spotAnimFrameRef = useRef<number | null>(null);
    const renderRef = useRef<(() => void) | null>(null);
    
    const renderRafRef = useRef<number | null>(null);
    const spotOverlayCacheRef = useRef<{key: string; canvas: HTMLCanvasElement} | null>(null);
    const segmentOverlayCacheRef = useRef<{key: string; canvas: HTMLCanvasElement} | null>(null);
    const segmentMaskImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const croppedImageCacheRef = useRef<{src: string; canvas: HTMLCanvasElement | HTMLImageElement} | null>(null);
    const previewImageCacheRef = useRef<{src: string; w: number; h: number; canvas: HTMLCanvasElement} | null>(null);
    const holographicCacheRef = useRef<{contourKey: string; canvas: HTMLCanvasElement} | null>(null);
    const contourTransformRef = useRef<{x: number; y: number; width: number; height: number; canvasW: number; canvasH: number} | null>(null);
    const lastCanvasDimsRef = useRef<{width: number; height: number}>({width: 0, height: 0});
    
    // Resize animation state
    const prevResizeDimsRef = useRef<{w: number; h: number} | null>(null);
    const resizeAnimRafRef = useRef<number | null>(null);
    const resizeAnimTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [resizeAnimState, setResizeAnimState] = useState<{scale: number; opacity: number; transitioning: boolean} | null>(null);
    
    // Drag-to-pan state
    const [isDragging, setIsDragging] = useState(false);
    const dragStartRef = useRef<{x: number; y: number; scrollLeft: number; scrollTop: number} | null>(null);
    const mouseDownPosRef = useRef<{x: number; y: number} | null>(null);
    
    // Select-to-zoom state
    const [selectZoomMode, setSelectZoomMode] = useState(false);
    const [selectionRect, setSelectionRect] = useState<{x: number; y: number; w: number; h: number} | null>(null);
    const selectionStartRef = useRef<{x: number; y: number} | null>(null);
    const isSelectingRef = useRef(false);
    const pendingViewRef = useRef<{ contentX: number; contentY: number; offsetX: number; offsetY: number } | null>(null);

    const clampZoom = useCallback((value: number) => Math.min(5, Math.max(0.25, value)), []);

    const zoomTo = useCallback((nextZoom: number, anchor?: { clientX: number; clientY: number }) => {
      const vp = containerRef.current;
      const z = clampZoom(nextZoom);
      const prevLayout = Math.max(zoomRef.current, 1);
      if (vp) {
        let offsetX = vp.clientWidth / 2;
        let offsetY = vp.clientHeight / 2;
        if (anchor) {
          const rect = vp.getBoundingClientRect();
          offsetX = anchor.clientX - rect.left;
          offsetY = anchor.clientY - rect.top;
        }
        pendingViewRef.current = {
          contentX: (vp.scrollLeft + offsetX) / prevLayout,
          contentY: (vp.scrollTop + offsetY) / prevLayout,
          offsetX,
          offsetY,
        };
      }
      zoomRef.current = z;
      setZoom(z);
    }, [clampZoom]);

    useLayoutEffect(() => {
      const vp = containerRef.current;
      if (!vp) return;
      if (zoom <= 1) {
        vp.scrollLeft = 0;
        vp.scrollTop = 0;
        pendingViewRef.current = null;
        return;
      }
      const pending = pendingViewRef.current;
      pendingViewRef.current = null;
      if (!pending) return;
      const layoutZ = Math.max(zoom, 1);
      vp.scrollLeft = pending.contentX * layoutZ - pending.offsetX;
      vp.scrollTop = pending.contentY * layoutZ - pending.offsetY;
    }, [zoom]);

    const applySelectionZoom = useCallback((selX: number, selY: number, selW: number, selH: number) => {
      const vp = containerRef.current;
      if (!vp || selW < 20 || selH < 20) return;
      const viewW = vp.clientWidth;
      const viewH = vp.clientHeight;
      if (viewW === 0 || viewH === 0) return;

      const layoutZ = Math.max(zoomRef.current, 1);
      const contentX = (selX + vp.scrollLeft) / layoutZ;
      const contentY = (selY + vp.scrollTop) / layoutZ;
      const contentW = selW / layoutZ;
      const contentH = selH / layoutZ;
      const nextZoom = clampZoom(Math.min(viewW / contentW, viewH / contentH));
      pendingViewRef.current = {
        contentX: contentX + contentW / 2,
        contentY: contentY + contentH / 2,
        offsetX: viewW / 2,
        offsetY: viewH / 2,
      };
      zoomRef.current = nextZoom;
      setZoom(nextZoom);
    }, [clampZoom]);

    const visibleOverlays = (imageInfo?.importedOverlays ?? []).filter((overlay) => overlay.visible);
    const editableOverlay = overlayById(visibleOverlays, selectedOverlayId)
      ?? visibleOverlays.find((overlay) => overlay.role === "cutline")
      ?? visibleOverlays[0];

    const overlayScreenBox = (overlay = editableOverlay) => {
      const imgRect = lastImageRenderRef.current;
      if (!overlay || !imgRect) return null;
      const print = { widthInches: resizeSettings.widthInches, heightInches: resizeSettings.heightInches };
      const box = overlayInkBox(alignedOverlayPaths(overlay, print));
      if (!box) return null;
      return {
        overlay,
        print,
        box,
        imgRect,
        x: imgRect.x + (box.minX / print.widthInches) * imgRect.width,
        y: imgRect.y + (box.minY / print.heightInches) * imgRect.height,
        w: (box.width / print.widthInches) * imgRect.width,
        h: (box.height / print.heightInches) * imgRect.height,
      };
    };

    const hitOverlayHandle = (canvasX: number, canvasY: number) => {
      const handle = 10;
      const pad = 8;
      const selected = overlayScreenBox(editableOverlay);
      if (selected) {
        const corners = [
          { x: selected.x, y: selected.y },
          { x: selected.x + selected.w, y: selected.y },
          { x: selected.x + selected.w, y: selected.y + selected.h },
          { x: selected.x, y: selected.y + selected.h },
        ];
        for (const corner of corners) {
          if (Math.abs(canvasX - corner.x) <= handle && Math.abs(canvasY - corner.y) <= handle) {
            return { kind: "scale" as const, screen: selected };
          }
        }
      }
      const hits = visibleOverlays
        .map((overlay) => overlayScreenBox(overlay))
        .filter((screen): screen is NonNullable<typeof screen> => !!screen)
        .filter((screen) => (
          canvasX >= screen.x - pad && canvasX <= screen.x + screen.w + pad
          && canvasY >= screen.y - pad && canvasY <= screen.y + screen.h + pad
        ))
        .sort((a, b) => (a.w * a.h) - (b.w * b.h));
      if (hits[0]) return { kind: "move" as const, screen: hits[0] };
      return null;
    };

    const clientToCanvas = (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left) * (canvas.width / rect.width),
        y: (clientY - rect.top) * (canvas.height / rect.height),
      };
    };

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      
      if (selectZoomMode && frameRef.current) {
        const rect = frameRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        selectionStartRef.current = { x, y };
        isSelectingRef.current = true;
        setSelectionRect({ x, y, w: 0, h: 0 });
        return;
      }

      if (!readOnly && !magicWandMode && !spotPaintMode && onOverlayAlignmentChange) {
        const pt = clientToCanvas(e.clientX, e.clientY);
        const hit = pt ? hitOverlayHandle(pt.x, pt.y) : null;
        if (hit) {
          onOverlaySelect?.(hit.screen.overlay.id);
          if (hit.screen.overlay.alignment.locked) {
            setOverlayCursor(null);
            return;
          }
          overlayDragRef.current = {
            id: hit.screen.overlay.id,
            mode: hit.kind,
            startClientX: e.clientX,
            startClientY: e.clientY,
            startAlign: { ...hit.screen.overlay.alignment },
            startBox: hit.screen.box,
            print: hit.screen.print,
          };
          setOverlayCursor(hit.kind === "scale" ? "nwse-resize" : "move");
          return;
        }
      }
      
      setIsDragging(true);
      const vp = containerRef.current;
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        scrollLeft: vp?.scrollLeft ?? 0,
        scrollTop: vp?.scrollTop ?? 0,
      };
      mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
    }, [selectZoomMode, readOnly, magicWandMode, spotPaintMode, onOverlayAlignmentChange, editableOverlay, resizeSettings.widthInches, resizeSettings.heightInches]);
    
    const handleMouseMove = useCallback((e: React.MouseEvent) => {
      if (isSelectingRef.current && selectionStartRef.current && frameRef.current) {
        const rect = frameRef.current.getBoundingClientRect();
        const curX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const curY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
        const sx = selectionStartRef.current.x;
        const sy = selectionStartRef.current.y;
        setSelectionRect({
          x: Math.min(sx, curX),
          y: Math.min(sy, curY),
          w: Math.abs(curX - sx),
          h: Math.abs(curY - sy),
        });
        return;
      }

      const overlayDrag = overlayDragRef.current;
      const dragOverlay = overlayDrag ? overlayById(visibleOverlays, overlayDrag.id) : undefined;
      if (overlayDrag && onOverlayAlignmentChange && dragOverlay && !dragOverlay.alignment.locked) {
        const imgRect = lastImageRenderRef.current;
        if (!imgRect || imgRect.width <= 0 || imgRect.height <= 0) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const dxPx = (e.clientX - overlayDrag.startClientX) * (canvas.width / rect.width);
        const dyPx = (e.clientY - overlayDrag.startClientY) * (canvas.height / rect.height);
        const startOverlay = { ...dragOverlay, alignment: overlayDrag.startAlign };
        if (overlayDrag.mode === "move") {
          const dxIn = (dxPx / imgRect.width) * overlayDrag.print.widthInches;
          const dyIn = (dyPx / imgRect.height) * overlayDrag.print.heightInches;
          onOverlayAlignmentChange(overlayDrag.id, applyOverlayUserNudge(startOverlay, overlayDrag.print, dxIn, dyIn));
        } else {
          const cx = overlayDrag.startBox.minX + overlayDrag.startBox.width / 2;
          const cy = overlayDrag.startBox.minY + overlayDrag.startBox.height / 2;
          const startCanvas = clientToCanvas(overlayDrag.startClientX, overlayDrag.startClientY);
          const nowCanvas = clientToCanvas(e.clientX, e.clientY);
          if (startCanvas && nowCanvas) {
            const boxCx = imgRect.x + (cx / overlayDrag.print.widthInches) * imgRect.width;
            const boxCy = imgRect.y + (cy / overlayDrag.print.heightInches) * imgRect.height;
            const startDist = Math.hypot(startCanvas.x - boxCx, startCanvas.y - boxCy);
            const nowDist = Math.hypot(nowCanvas.x - boxCx, nowCanvas.y - boxCy);
            if (startDist > 2) {
              onOverlayAlignmentChange(
                overlayDrag.id,
                applyOverlayUserScale(startOverlay, overlayDrag.print, overlayDrag.startAlign.scale * (nowDist / startDist)),
              );
            }
          }
        }
        return;
      }

      if (!overlayDragRef.current && !readOnly && onOverlayAlignmentChange) {
        const pt = clientToCanvas(e.clientX, e.clientY);
        const hit = pt ? hitOverlayHandle(pt.x, pt.y) : null;
        setOverlayCursor(hit ? (hit.kind === "scale" ? "nwse-resize" : "move") : null);
      }
      
      if (!isDragging || !dragStartRef.current || zoomRef.current <= 1) return;
      const vp = containerRef.current;
      if (!vp) return;
      vp.scrollLeft = dragStartRef.current.scrollLeft - (e.clientX - dragStartRef.current.x);
      vp.scrollTop = dragStartRef.current.scrollTop - (e.clientY - dragStartRef.current.y);
    }, [isDragging, onOverlayAlignmentChange, editableOverlay, readOnly, resizeSettings.widthInches, resizeSettings.heightInches]);
    
    const handleMouseUp = useCallback((e: React.MouseEvent) => {
      if (overlayDragRef.current) {
        overlayDragRef.current = null;
        setOverlayCursor(null);
        return;
      }
      if (isSelectingRef.current && selectionRect) {
        isSelectingRef.current = false;
        selectionStartRef.current = null;
        if (selectionRect.w >= 20 && selectionRect.h >= 20) {
          applySelectionZoom(selectionRect.x, selectionRect.y, selectionRect.w, selectionRect.h);
          setSelectZoomMode(false);
        }
        setSelectionRect(null);
        return;
      }
      
      const downPos = mouseDownPosRef.current;
      setIsDragging(false);
      dragStartRef.current = null;
      mouseDownPosRef.current = null;

      if (downPos) {
        const dx = e.clientX - downPos.x;
        const dy = e.clientY - downPos.y;
        const isClick = Math.abs(dx) < 4 && Math.abs(dy) < 4;

        if (isClick && magicWandMode && onMagicWandPick && imageInfo && canvasRef.current) {
          const canvas = canvasRef.current;
          const rect = canvas.getBoundingClientRect();
          const canvasX = (e.clientX - rect.left) * (canvas.width / rect.width);
          const canvasY = (e.clientY - rect.top) * (canvas.height / rect.height);
          const imgRect = lastImageRenderRef.current;
          if (imgRect && imgRect.width > 0 && imgRect.height > 0) {
            const imgX = (canvasX - imgRect.x) / imgRect.width * imageInfo.image.width;
            const imgY = (canvasY - imgRect.y) / imgRect.height * imageInfo.image.height;
            if (imgX >= 0 && imgX < imageInfo.image.width && imgY >= 0 && imgY < imageInfo.image.height) {
              onMagicWandPick(imgX, imgY);
            }
          }
          return;
        }

        if (isClick && onSpotColorClick && spotPreviewData?.pixelMap && imageInfo) {
          handleCanvasClick(e);
        }
      }
    }, [onSpotColorClick, spotPreviewData, imageInfo, selectionRect, applySelectionZoom, magicWandMode, onMagicWandPick]);
    
    const handleCanvasClick = useCallback((e: React.MouseEvent) => {
      if (!imageInfo || !spotPreviewData?.pixelMap || !onSpotColorClick || !canvasRef.current) return;

      const canvas = canvasRef.current;
      const rect = canvas.getBoundingClientRect();
      
      // Convert client coordinates to canvas coordinates
      const canvasX = (e.clientX - rect.left) * (canvas.width / rect.width);
      const canvasY = (e.clientY - rect.top) * (canvas.height / rect.height);

      // Determine where the image is drawn on the canvas using lastImageRenderRef
      const imgRect = lastImageRenderRef.current;
      if (!imgRect) return;

      const pixelMap = spotPreviewData.pixelMap;
      const mapW = spotPreviewData.mapWidth ?? imageInfo.image.width;
      const mapH = spotPreviewData.mapHeight ?? imageInfo.image.height;

      const mapX = Math.floor((canvasX - imgRect.x) / imgRect.width * mapW);
      const mapY = Math.floor((canvasY - imgRect.y) / imgRect.height * mapH);

      if (mapX < 0 || mapX >= mapW || mapY < 0 || mapY >= mapH) return;

      const pixelIndex = mapY * mapW + mapX;
      if (pixelIndex < 0 || pixelIndex >= pixelMap.length) return;

      const colorIndex = pixelMap[pixelIndex];
      if (colorIndex < 0) return;

      const color = spotPreviewData.colors[colorIndex];
      if (!color) return;

      let regionId: number | null = null;
      if (color.regionMap) {
        const rid = color.regionMap[pixelIndex];
        if (rid >= 0) regionId = rid;
      }

      onSpotColorClick(colorIndex, regionId);
    }, [imageInfo, spotPreviewData, onSpotColorClick]);

    const handleMouseLeave = useCallback(() => {
      if (overlayDragRef.current) {
        overlayDragRef.current = null;
        setOverlayCursor(null);
      }
      if (isSelectingRef.current) {
        isSelectingRef.current = false;
        selectionStartRef.current = null;
        setSelectionRect(null);
      }
      if (isDragging) {
        setIsDragging(false);
        dragStartRef.current = null;
      }
    }, [isDragging]);
    
    const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);

    const getTouchDist = (a: React.Touch, b: React.Touch) =>
      Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        pinchRef.current = { dist: getTouchDist(e.touches[0], e.touches[1]), zoom: zoomRef.current };
        setIsDragging(false);
        dragStartRef.current = null;
        return;
      }
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      setIsDragging(true);
      const vp = containerRef.current;
      dragStartRef.current = {
        x: t.clientX,
        y: t.clientY,
        scrollLeft: vp?.scrollLeft ?? 0,
        scrollTop: vp?.scrollTop ?? 0,
      };
    }, []);
    
    const handleTouchMove = useCallback((e: React.TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2 && pinchRef.current) {
        const newDist = getTouchDist(e.touches[0], e.touches[1]);
        const scale = newDist / pinchRef.current.dist;
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        zoomTo(pinchRef.current.zoom * scale, { clientX: midX, clientY: midY });
        return;
      }
      if (!isDragging || !dragStartRef.current || e.touches.length !== 1 || zoomRef.current <= 1) return;
      const t = e.touches[0];
      const vp = containerRef.current;
      if (!vp) return;
      vp.scrollLeft = dragStartRef.current.scrollLeft - (t.clientX - dragStartRef.current.x);
      vp.scrollTop = dragStartRef.current.scrollTop - (t.clientY - dragStartRef.current.y);
    }, [isDragging, zoomTo]);
    
    const handleTouchEnd = useCallback(() => {
      pinchRef.current = null;
      setIsDragging(false);
      dragStartRef.current = null;
    }, []);
    
    const resetView = useCallback(() => {
      zoomTo(1);
      setSelectZoomMode(false);
      setSelectionRect(null);
      isSelectingRef.current = false;
      selectionStartRef.current = null;
    }, [zoomTo]);
    
    useEffect(() => {
      if (!selectZoomMode) return;
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          setSelectZoomMode(false);
          setSelectionRect(null);
          isSelectingRef.current = false;
          selectionStartRef.current = null;
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectZoomMode]);
    
    const handleWheel = useCallback((e: React.WheelEvent) => {
      const zoomGesture = e.ctrlKey || e.metaKey || zoomRef.current <= 1;
      if (!zoomGesture) return;
      if (e.deltaY > 0 && zoomRef.current <= 1 && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomTo(
        e.deltaY < 0 ? zoomRef.current + 0.15 : zoomRef.current - 0.15,
        { clientX: e.clientX, clientY: e.clientY },
      );
    }, [zoomTo]);
    
    useEffect(() => { zoomRef.current = zoom; }, [zoom]);

    useEffect(() => {
      if (!imageInfo) {
        lastImageRef.current = null;
        spotOverlayCacheRef.current = null;
        segmentOverlayCacheRef.current = null;
        croppedImageCacheRef.current = null;
        previewImageCacheRef.current = null;
        holographicCacheRef.current = null;
        return;
      }
      
      const imageKey = `${imageInfo.image.src}-${imageInfo.image.width}-${imageInfo.image.height}`;
      if (lastImageRef.current === imageKey) return;
      
      // Detect if this is an enhanced version of the same image (same aspect ratio)
      // by checking if the previous image key exists and the file is the same
      const prevKey = lastImageRef.current;
      lastImageRef.current = imageKey;
      spotOverlayCacheRef.current = null;
      segmentOverlayCacheRef.current = null;
      croppedImageCacheRef.current = null;
      previewImageCacheRef.current = null;
      holographicCacheRef.current = null;
      
      // Skip zoom reset for enhancement (same file, different resolution)
      if (prevKey) {
        const prevParts = prevKey.split('-');
        const prevW = parseInt(prevParts[prevParts.length - 2]);
        const prevH = parseInt(prevParts[prevParts.length - 1]);
        if (!isNaN(prevW) && !isNaN(prevH) && prevW > 0 && prevH > 0) {
          const prevRatio = prevW / prevH;
          const newRatio = imageInfo.image.width / imageInfo.image.height;
          if (Math.abs(prevRatio - newRatio) < 0.01) return;
        }
      }
      
      setZoom(1);
      zoomRef.current = 1;
    }, [imageInfo]);

    useEffect(() => {
      if (!frameRef.current) return;
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const updateSize = () => {
        const frame = frameRef.current;
        if (!frame) return;
        const width = frame.clientWidth;
        const height = frame.clientHeight;
        setFrameSize((previous) => (
          previous.w === width && previous.h === height ? previous : { w: width, h: height }
        ));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const safeWidth = Math.max(220, Math.round(width * dpr));
        const safeHeight = Math.max(220, Math.round(height * dpr));
        setPreviewDims(previous =>
          previous.width === safeWidth && previous.height === safeHeight
            ? previous
            : { width: safeWidth, height: safeHeight }
        );
      };
      updateSize();
      const observer = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(updateSize, 150);
      });
      observer.observe(frameRef.current);
      return () => { observer.disconnect(); if (resizeTimer) clearTimeout(resizeTimer); };
    }, []);
    
    useImperativeHandle(ref, () => {
      const canvas = canvasRef.current!;
      (canvas as any).getContourCanvasInfo = () => {
        if (contourCacheRef.current?.canvas) {
          return {
            width: contourCacheRef.current.canvas.width,
            height: contourCacheRef.current.canvas.height,
            imageCanvasX: contourCacheRef.current.imageCanvasX,
            imageCanvasY: contourCacheRef.current.imageCanvasY,
            downsampleScale: contourCacheRef.current.downsampleScale,
          };
        }
        return null;
      };
      return canvas;
    }, []);

    const getCachedCroppedImage = (): HTMLCanvasElement | HTMLImageElement => {
      if (!imageInfo) return document.createElement('canvas');
      const src = imageInfo.image.src;
      if (croppedImageCacheRef.current?.src === src) {
        return croppedImageCacheRef.current.canvas;
      }
      const totalPx = imageInfo.image.width * imageInfo.image.height;
      const cropped = totalPx <= 4_000_000 ? cropImageToContent(imageInfo.image) : null;
      const result = cropped || imageInfo.image;
      croppedImageCacheRef.current = { src, canvas: result };
      return result;
    };

    const getPreviewImage = (): HTMLCanvasElement | HTMLImageElement => {
      if (!imageInfo) return document.createElement('canvas');
      const img = imageInfo.image;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const targetDim = Math.max(800, Math.round(Math.max(previewDims.width, previewDims.height) * zoom));
      if (w <= targetDim && h <= targetDim) return img;
      const src = img.src;
      const scale = Math.min(targetDim / w, targetDim / h);
      const pw = Math.round(w * scale);
      const ph = Math.round(h * scale);
      if (previewImageCacheRef.current?.src === src && previewImageCacheRef.current.w === pw && previewImageCacheRef.current.h === ph) {
        return previewImageCacheRef.current.canvas;
      }
      const c = document.createElement('canvas');
      c.width = pw;
      c.height = ph;
      const cx = c.getContext('2d');
      if (cx) {
        cx.imageSmoothingEnabled = true;
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(img, 0, 0, pw, ph);
      }
      previewImageCacheRef.current = { src, w: pw, h: ph, canvas: c };
      return c;
    };

    // Version bump forces cache invalidation when worker code changes
    const CONTOUR_CACHE_VERSION = 34;
    const generateContourCacheKey = useCallback(() => {
      if (!imageInfo) return '';
      const bboxKey = detectedShapeInfo ? `${detectedShapeInfo.boundingBox.x},${detectedShapeInfo.boundingBox.y},${detectedShapeInfo.boundingBox.width},${detectedShapeInfo.boundingBox.height}` : 'none';
      return `v${CONTOUR_CACHE_VERSION}-${imageInfo.image.src}-${imageInfo.originalWidth}x${imageInfo.originalHeight}-${strokeSettings.width}-${strokeSettings.color}-${strokeSettings.alphaThreshold}-${strokeSettings.backgroundColor}-${strokeSettings.useCustomBackground}-${strokeSettings.contourMode}-${strokeSettings.cornerMode}-${strokeSettings.autoBridging}-${strokeSettings.autoBridgingThreshold}-${strokeSettings.includeHoles}-${resizeSettings.widthInches}-${resizeSettings.heightInches}-${resizeSettings.maintainAspectRatio}-${resizeSettings.outputDPI}-shape:${detectedShapeType || 'none'}-bbox:${bboxKey}`;
    }, [imageInfo, strokeSettings.width, strokeSettings.color, strokeSettings.alphaThreshold, strokeSettings.backgroundColor, strokeSettings.useCustomBackground, strokeSettings.contourMode, strokeSettings.cornerMode, strokeSettings.autoBridging, strokeSettings.autoBridgingThreshold, strokeSettings.includeHoles, resizeSettings.widthInches, resizeSettings.heightInches, resizeSettings.maintainAspectRatio, resizeSettings.outputDPI, detectedShapeType, detectedShapeInfo]);

    const contourRequestKey = generateContourCacheKey();
    const contourPendingRef = useRef(false);
    const lastRenderedFileRef = useRef<File | null>(null);

    useEffect(() => {
      // Clear any pending debounce
      if (contourDebounceRef.current) {
        clearTimeout(contourDebounceRef.current);
        contourDebounceRef.current = null;
      }

      const hasCustomCut = !!overlayByRole(imageInfo?.importedOverlays, "cutline");
      if (!imageInfo || !strokeSettings.enabled || shapeSettings.enabled || hasCustomCut) {
        contourPendingRef.current = false;
        contourCacheRef.current = null;
        contourTransformRef.current = null;
        // CRITICAL: invalidate any in-flight worker run AND reset the
        // overlay state. Without these two lines, removing/swapping a
        // design while the previous trace is in flight leaves
        // `isProcessing=true` and the "Processing… 0%" overlay stuck on
        // top of the new image (or empty canvas) forever, because the
        // .then() handler on the in-flight promise will be discarded by
        // the bumped processingIdRef and never get to call
        // setIsProcessing(false).
        ++processingIdRef.current;
        setIsProcessing(false);
        setProcessingProgress(0);
        return;
      }

      const cacheKey = contourRequestKey;
      if (contourCacheRef.current?.key === cacheKey) return;

      contourCacheRef.current = null;
      contourTransformRef.current = null;
      contourPendingRef.current = true;
      onPreviewStatus?.(imageInfo.image, 'processing');
      setIsProcessing(true);
      setProcessingProgress(0);

      // Invalidate any in-flight processing results immediately so stale
      // worker responses (e.g. after image enhancement) are discarded.
      ++processingIdRef.current;

      // Debounce processing to avoid rapid re-renders during slider drags
      contourDebounceRef.current = setTimeout(() => {
        const currentId = ++processingIdRef.current;
        setIsProcessing(true);
        setProcessingProgress(1);

        // Match the export snapshot rather than the display-only .02" trace.
        processContourInWorker(
          imageInfo.image,
          strokeSettings,
          resizeSettings,
          (progress) => {
            if (processingIdRef.current === currentId) {
              setProcessingProgress(progress);
            }
          },
          detectedShapeType,
          detectedShapeInfo
        ).then((result) => {
          if (processingIdRef.current === currentId) {
            if (!result.contourData) throw new Error('Contour worker did not return export geometry');
            const display = document.createElement('canvas');
            display.width = result.canvas.width;
            display.height = result.canvas.height;
            const displayCtx = display.getContext('2d');
            if (!displayCtx) throw new Error('Could not draw the contour preview');
            displayCtx.drawImage(result.canvas, 0, 0);
            displayCtx.strokeStyle = '#FF00FF';
            displayCtx.lineWidth = 1.5;
            for (const path of result.contourData.allPreviewPathPoints?.length
              ? result.contourData.allPreviewPathPoints : [result.contourData.previewPathPoints]) {
              if (path.length < 3) continue;
              displayCtx.beginPath();
              displayCtx.moveTo(path[0].x, path[0].y);
              for (let i = 1; i < path.length; i++) displayCtx.lineTo(path[i].x, path[i].y);
              displayCtx.closePath();
              displayCtx.stroke();
            }
            contourCacheRef.current = { key: cacheKey, canvas: display, downsampleScale: result.downsampleScale, imageCanvasX: result.imageCanvasX, imageCanvasY: result.imageCanvasY };
            contourPendingRef.current = false;
            setIsProcessing(false);
            if (result.detectedAlgorithm && onDetectedAlgorithm) {
              onDetectedAlgorithm(result.detectedAlgorithm);
            }
          }
        }).catch((error) => {
          console.error('Contour processing error:', error);
          if (processingIdRef.current === currentId) {
            contourPendingRef.current = false;
            setIsProcessing(false);
            onPreviewStatus?.(imageInfo.image, 'error', error instanceof Error ? error : new Error(String(error)));
          }
        });
      }, 100); // 100ms debounce for smoother slider interaction
      
      return () => {
        ++processingIdRef.current;
        if (contourDebounceRef.current) {
          clearTimeout(contourDebounceRef.current);
        }
      };
    // Metadata-only image updates (e.g. QR detection) must not cancel and
    // restart the same trace. The key describes the actual contour inputs.
    }, [contourRequestKey, strokeSettings.enabled, shapeSettings.enabled]);

    // Smooth resize animation: detects dimension changes and animates the canvas
    useLayoutEffect(() => {
      if (!imageInfo) {
        prevResizeDimsRef.current = null;
        return;
      }

      const cur = { w: resizeSettings.widthInches, h: resizeSettings.heightInches };
      const prev = prevResizeDimsRef.current;
      prevResizeDimsRef.current = cur;

      if (!prev) return;
      if (prev.w === cur.w && prev.h === cur.h) return;

      // Scale ratio based on longest dimension change for natural visual scaling
      const oldMax = Math.max(prev.w, prev.h);
      const newMax = Math.max(cur.w, cur.h);
      const scaleRatio = oldMax / newMax;
      const startScale = Math.max(0.82, Math.min(1.18, scaleRatio));

      // Immediately set the "from" state (no CSS transition yet)
      setResizeAnimState({ scale: startScale, opacity: 0.55, transitioning: false });

      // After the browser paints the "from" state, enable the CSS transition to animate to the final state
      if (resizeAnimRafRef.current) cancelAnimationFrame(resizeAnimRafRef.current);
      resizeAnimRafRef.current = requestAnimationFrame(() => {
        resizeAnimRafRef.current = requestAnimationFrame(() => {
          setResizeAnimState({ scale: 1, opacity: 1, transitioning: true });
          resizeAnimRafRef.current = null;
        });
      });

      // Clear animation state after transition completes
      if (resizeAnimTimeoutRef.current) clearTimeout(resizeAnimTimeoutRef.current);
      resizeAnimTimeoutRef.current = setTimeout(() => {
        setResizeAnimState(null);
      }, 420);

      return () => {
        if (resizeAnimRafRef.current) {
          cancelAnimationFrame(resizeAnimRafRef.current);
          resizeAnimRafRef.current = null;
        }
        if (resizeAnimTimeoutRef.current) {
          clearTimeout(resizeAnimTimeoutRef.current);
          resizeAnimTimeoutRef.current = null;
        }
      };
    }, [resizeSettings.widthInches, resizeSettings.heightInches, imageInfo]);

    useEffect(() => {
      if (!gangSheetView) return;
      setZoom(1);
      zoomRef.current = 1;
    }, [!!gangSheetView, gangSheetView?.settings.sheetWidth, gangSheetView?.settings.sheetHeight]);

    useEffect(() => {
      if (!canvasRef.current) return;

      const doRender = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Keep the last complete frame during a pixel edit. The export cache
      // remains invalidated above; this preserves only the visible bitmap,
      // never stale geometry for downloads or gang-sheet placement.
      if (!gangSheetView && contourPendingRef.current && imageInfo &&
          (lastRenderedFileRef.current === imageInfo.file ||
            (isEnhancing && lastRenderedFileRef.current !== null))) return;
      lastRenderedFileRef.current = imageInfo?.file ?? null;

      const canvasWidth = previewDims.width;
      const canvasHeight = previewDims.height;
      const bitmap = gangSheetView
        ? gangSheetPreviewResolution(canvasWidth, canvasHeight, zoom)
        : { width: canvasWidth, height: canvasHeight };
      if (lastCanvasDimsRef.current.width !== bitmap.width || lastCanvasDimsRef.current.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        lastCanvasDimsRef.current = bitmap;
      } else {
        ctx.clearRect(0, 0, bitmap.width, bitmap.height);
      }

      if (gangSheetView) {
        const inset = previewFitInset(canvasWidth, canvasHeight);
        const availW = Math.max(40, canvasWidth - inset * 2);
        const availH = Math.max(40, canvasHeight - inset * 2);
        const aspect = gangSheetView.settings.sheetWidth / Math.max(0.01, gangSheetView.settings.sheetHeight);
        let displayWidth = availW;
        let displayHeight = displayWidth / aspect;
        if (displayHeight > availH) {
          displayHeight = availH;
          displayWidth = displayHeight * aspect;
        }
        displayWidth = Math.max(40, Math.floor(displayWidth));
        displayHeight = Math.max(40, Math.floor(displayHeight));
        const ox = (canvasWidth - displayWidth) / 2;
        const oy = (canvasHeight - displayHeight) / 2;
        ctx.save();
        ctx.scale(bitmap.width / canvasWidth, bitmap.height / canvasHeight);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.translate(ox, oy);
        drawGangSheetPreview(ctx, {
          items: gangSheetView.items,
          settings: gangSheetView.settings,
          packResult: gangSheetView.packResult,
          displayWidth,
          displayHeight,
        });
        ctx.restore();
        return;
      }

      if (!imageInfo) return;

      // Determine which background color to use:
      // - For PDFs with CutContour, use strokeSettings.backgroundColor
      // - For regular images, use local backgroundColor state
      const hasCustomCut = !!overlayByRole(imageInfo.importedOverlays, "cutline");
      const hasPdfCutContour = !hasCustomCut && imageInfo.isPDF && imageInfo.pdfCutContourInfo?.hasCutContour;
      const effectiveBackgroundColor = hasPdfCutContour 
        ? strokeSettings.backgroundColor 
        : backgroundColor;

      // For PDFs with CutContour, we need special rendering to clip background to the cut path
      if (hasPdfCutContour && imageInfo.pdfCutContourInfo) {
        const cutContourInfo = imageInfo.pdfCutContourInfo;
        const hasExtractedPaths = cutContourInfo.cutContourPoints && cutContourInfo.cutContourPoints.length > 0;
        const viewPadding = previewFitInset(canvas.width, canvas.height);
        const availableWidth = canvas.width - viewPadding * 2;
        const availableHeight = canvas.height - viewPadding * 2;
        
        // Get actual content bounds of the rendered PDF (removes empty space and white background)
        const contentBounds = getImageBounds(imageInfo.image);
        
        // Use content bounds for sizing, not full PDF page size
        const contentWidth = contentBounds.width;
        const contentHeight = contentBounds.height;
        const scaleX = availableWidth / contentWidth;
        const scaleY = availableHeight / contentHeight;
        const scale = Math.min(scaleX, scaleY);
        
        const scaledWidth = contentWidth * scale;
        const scaledHeight = contentHeight * scale;
        const offsetX = viewPadding + (availableWidth - scaledWidth) / 2;
        const offsetY = viewPadding + (availableHeight - scaledHeight) / 2;
        
        // Store content bounds offset for image drawing
        const contentOffsetX = contentBounds.x;
        const contentOffsetY = contentBounds.y;
        
        // Bleed offset based on content scale (0.10 inches at render DPI)
        const bleedInches = 0.10;
        const renderDPI = imageInfo.pdfCutContourInfo.pageWidth ? 
          (imageInfo.image.naturalWidth / (imageInfo.pdfCutContourInfo.pageWidth / 72 * 72)) : 300;
        const bleedPixelsAtRender = bleedInches * renderDPI;
        const bleedPixels = bleedPixelsAtRender * scale;
        
        // Create clipping path - use extracted paths if available, otherwise use image bounds
        ctx.save();
        ctx.beginPath();
        
        if (hasExtractedPaths) {
          // Use extracted CutContour paths with bleed expansion
          for (const path of cutContourInfo.cutContourPoints) {
            if (path.length < 2) continue;
            
            // Calculate centroid of path for offset direction
            let cx = 0, cy = 0;
            for (const pt of path) {
              cx += offsetX + pt.x * scale;
              cy += offsetY + pt.y * scale;
            }
            cx /= path.length;
            cy /= path.length;
            
            // Draw path with bleed expansion (offset away from centroid)
            const firstX = offsetX + path[0].x * scale;
            const firstY = offsetY + path[0].y * scale;
            const firstDist = Math.sqrt((firstX - cx) ** 2 + (firstY - cy) ** 2);
            const firstExpandX = firstDist > 0 ? (firstX - cx) / firstDist * bleedPixels : 0;
            const firstExpandY = firstDist > 0 ? (firstY - cy) / firstDist * bleedPixels : 0;
            
            ctx.moveTo(firstX + firstExpandX, firstY + firstExpandY);
            
            for (let i = 1; i < path.length; i++) {
              const px = offsetX + path[i].x * scale;
              const py = offsetY + path[i].y * scale;
              const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
              const expandX = dist > 0 ? (px - cx) / dist * bleedPixels : 0;
              const expandY = dist > 0 ? (py - cy) / dist * bleedPixels : 0;
              ctx.lineTo(px + expandX, py + expandY);
            }
            ctx.closePath();
          }
        } else {
          // Fallback: use image bounds with bleed for clipping
          const clipX = offsetX - bleedPixels;
          const clipY = offsetY - bleedPixels;
          const clipW = scaledWidth + bleedPixels * 2;
          const clipH = scaledHeight + bleedPixels * 2;
          ctx.rect(clipX, clipY, clipW, clipH);
          ctx.closePath();
          
          // Fill background color for the fallback rect area directly
          if (effectiveBackgroundColor !== "transparent") {
            if (effectiveBackgroundColor === "holographic") {
              const gradient = ctx.createLinearGradient(clipX, clipY, clipX + clipW, clipY + clipH);
              gradient.addColorStop(0, '#C8C8D0');
              gradient.addColorStop(0.17, '#E8B8B8');
              gradient.addColorStop(0.34, '#B8D8E8');
              gradient.addColorStop(0.51, '#E8D0F0');
              gradient.addColorStop(0.68, '#B0C8E0');
              gradient.addColorStop(0.85, '#C0B0D8');
              gradient.addColorStop(1, '#C8C8D0');
              ctx.fillStyle = gradient;
            } else {
              ctx.fillStyle = effectiveBackgroundColor;
            }
            ctx.fillRect(clipX, clipY, clipW, clipH);
          }
          
          // Clip and draw only the content portion of the image
          ctx.clip();
          ctx.drawImage(
            imageInfo.image,
            contentOffsetX, contentOffsetY, contentWidth, contentHeight,
            offsetX, offsetY, scaledWidth, scaledHeight
          );
          ctx.restore();
          
          // Draw image bounds as cut indicator
          ctx.save();
          ctx.strokeStyle = '#FF00FF';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.strokeRect(offsetX, offsetY, scaledWidth, scaledHeight);
          ctx.restore();
          return; // Early return for fallback case
        }
        
        // For extracted paths: fill the path, then clip for the image
        if (effectiveBackgroundColor !== "transparent") {
          if (effectiveBackgroundColor === "holographic") {
            const bounds = ctx.getTransform();
            const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
            gradient.addColorStop(0, '#C8C8D0');
            gradient.addColorStop(0.17, '#E8B8B8');
            gradient.addColorStop(0.34, '#B8D8E8');
            gradient.addColorStop(0.51, '#E8D0F0');
            gradient.addColorStop(0.68, '#B0C8E0');
            gradient.addColorStop(0.85, '#C0B0D8');
            gradient.addColorStop(1, '#C8C8D0');
            ctx.fillStyle = gradient;
          } else {
            ctx.fillStyle = effectiveBackgroundColor;
          }
          ctx.fill();
        }
        
        ctx.clip();
        
        // Draw only the content portion of the image inside the clipped region
        ctx.drawImage(
          imageInfo.image,
          contentOffsetX, contentOffsetY, contentWidth, contentHeight,
          offsetX, offsetY, scaledWidth, scaledHeight
        );
        lastImageRenderRef.current = { x: offsetX, y: offsetY, width: scaledWidth, height: scaledHeight };
        
        ctx.restore();
        
        // Draw the CutContour path indicator (magenta dashed line) with curve detection
        if (hasExtractedPaths) {
          ctx.save();
          ctx.strokeStyle = '#FF00FF';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          
          for (const path of cutContourInfo.cutContourPoints) {
            if (path.length < 2) continue;
            ctx.beginPath();
            
            // Smooth the contour first to reduce jagged edges from alpha tracing
            const smoothedPath = gaussianSmoothContour(path, 2);
            
            // Convert path to curves for smooth rendering (60+ point curves)
            const segments = convertPolygonToCurves(smoothedPath, 70);
            
            for (const seg of segments) {
              if (seg.type === 'move' && seg.point) {
                ctx.moveTo(offsetX + seg.point.x * scale, offsetY + seg.point.y * scale);
              } else if (seg.type === 'line' && seg.point) {
                ctx.lineTo(offsetX + seg.point.x * scale, offsetY + seg.point.y * scale);
              } else if (seg.type === 'curve' && seg.cp1 && seg.cp2 && seg.end) {
                ctx.bezierCurveTo(
                  offsetX + seg.cp1.x * scale, offsetY + seg.cp1.y * scale,
                  offsetX + seg.cp2.x * scale, offsetY + seg.cp2.y * scale,
                  offsetX + seg.end.x * scale, offsetY + seg.end.y * scale
                );
              }
            }
            
            ctx.closePath();
            ctx.stroke();
          }
          
          ctx.restore();
        } else {
          // Draw image bounds as cut indicator when no paths extracted
          ctx.save();
          ctx.strokeStyle = '#FF00FF';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.strokeRect(offsetX, offsetY, scaledWidth, scaledHeight);
          ctx.restore();
        }
      } else {
        if (shapeSettings.enabled) {
          drawShapePreview(ctx, canvas.width, canvas.height);
        } else if (effectiveBackgroundColor === "transparent") {
          drawImageWithResizePreview(ctx, canvas.width, canvas.height);
        } else {
          if (effectiveBackgroundColor === "holographic") {
            const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
            gradient.addColorStop(0, '#C8C8D0');
            gradient.addColorStop(0.17, '#E8B8B8');
            gradient.addColorStop(0.34, '#B8D8E8');
            gradient.addColorStop(0.51, '#E8D0F0');
            gradient.addColorStop(0.68, '#B0C8E0');
            gradient.addColorStop(0.85, '#C0B0D8');
            gradient.addColorStop(1, '#C8C8D0');
            ctx.fillStyle = gradient;
          } else {
            ctx.fillStyle = effectiveBackgroundColor;
          }
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          drawImageWithResizePreview(ctx, canvas.width, canvas.height);
        }

      }

      const overlays = imageInfo.importedOverlays?.filter((overlay) => overlay.visible) ?? [];
      const imgRect = lastImageRenderRef.current;
      if (overlays.length > 0 && imgRect && canvas) {
        const print = { widthInches: resizeSettings.widthInches, heightInches: resizeSettings.heightInches };
        for (const overlay of overlays) {
          const polylines = overlayPolylinesForPreview(overlay, print);
          ctx.save();
          ctx.beginPath();
          for (const path of polylines) {
            if (path.length < 2) continue;
            ctx.moveTo(
              imgRect.x + (path[0].x / print.widthInches) * imgRect.width,
              imgRect.y + (path[0].y / print.heightInches) * imgRect.height,
            );
            for (let i = 1; i < path.length; i++) {
              ctx.lineTo(
                imgRect.x + (path[i].x / print.widthInches) * imgRect.width,
                imgRect.y + (path[i].y / print.heightInches) * imgRect.height,
              );
            }
            ctx.closePath();
          }
          const style = overlay.previewStyle ?? defaultOverlayPreviewStyle(overlay.role);
          const hex = style.color.replace("#", "");
          const r = parseInt(hex.slice(0, 2), 16) || 0;
          const g = parseInt(hex.slice(2, 4), 16) || 0;
          const b = parseInt(hex.slice(4, 6), 16) || 0;
          ctx.globalAlpha = Math.min(1, Math.max(0.12, style.opacity));
          ctx.setLineDash(style.dashed ? [5, 4] : []);
          if (style.mode === "stroke" || overlay.role === "cutline") {
            ctx.strokeStyle = `rgb(${r},${g},${b})`;
            ctx.lineWidth = style.dashed ? 2.1 : 1.75;
            ctx.stroke();
          }
          if (style.mode === "fill") {
            ctx.fillStyle = `rgba(${r},${g},${b},1)`;
            ctx.fill("evenodd");
          }
          ctx.globalAlpha = 1;
          ctx.restore();
        }
        const active = overlayById(overlays, selectedOverlayId) ?? editableOverlay;
        if (active && !readOnly) {
          const box = overlayInkBox(alignedOverlayPaths(active, print));
          if (box) {
            const x = imgRect.x + (box.minX / print.widthInches) * imgRect.width;
            const y = imgRect.y + (box.minY / print.heightInches) * imgRect.height;
            const w = (box.width / print.widthInches) * imgRect.width;
            const h = (box.height / print.heightInches) * imgRect.height;
            const handleStroke = (active.previewStyle ?? defaultOverlayPreviewStyle(active.role)).color;
            ctx.save();
            ctx.strokeStyle = "rgba(255,255,255,0.7)";
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(x, y, w, h);
            ctx.setLineDash([]);
            ctx.fillStyle = "#ffffff";
            ctx.strokeStyle = handleStroke;
            for (const [hx, hy] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) {
              ctx.fillRect(hx - 4, hy - 4, 8, 8);
              ctx.strokeRect(hx - 4, hy - 4, 8, 8);
            }
            ctx.restore();
          }
        }
      }
      
      if (lockedContour && !hasCustomCut && lockedContour.previewPathPoints.length > 2 && canvas) {
        // Collect all path arrays to draw (multi-path for zero hero, single for normal)
        const pathArrays: Array<Array<{x: number; y: number}>> =
          lockedContour.allPreviewPathPoints && lockedContour.allPreviewPathPoints.length > 0
            ? lockedContour.allPreviewPathPoints
            : [lockedContour.previewPathPoints];

        // Compute transform parameters once
        let transformPts: (pts: Array<{x: number; y: number}>) => Array<{x: number; y: number}>;

        if (shapeSettings.enabled && imageInfo) {
          const shapeDims = resolveShapeDimensions(shapeSettings, resizeSettings);
          const viewPad = Math.max(4, Math.round(Math.min(canvas.width, canvas.height) * 0.03));
          const availW = canvas.width - (viewPad * 2);
          const availH = canvas.height - (viewPad * 2);
          const shapeAspect = shapeDims.widthInches / shapeDims.heightInches;
          let shapeW: number, shapeH: number;
          if (shapeAspect > (availW / availH)) {
            shapeW = availW;
            shapeH = availW / shapeAspect;
          } else {
            shapeH = availH;
            shapeW = availH * shapeAspect;
          }
          const shapeX = (canvas.width - shapeW) / 2;
          const shapeY = (canvas.height - shapeH) / 2;
          const ppi = Math.min(shapeW / shapeDims.widthInches, shapeH / shapeDims.heightInches);
          const imgW = resizeSettings.widthInches * ppi;
          const imgH = resizeSettings.heightInches * ppi;
          const imgX = shapeX + (shapeW - imgW) / 2;
          const imgY = shapeY + (shapeH - imgH) / 2;

          const icx = lockedContour.imageCanvasX;
          const icy = lockedContour.imageCanvasY;
          const icw = lockedContour.imageCanvasWidth;
          const ich = lockedContour.imageCanvasHeight;
          const sxScale = imgW / icw;
          const syScale = imgH / ich;
          
          transformPts = (pts) => pts.map(p => ({
            x: imgX + (p.x - icx) * sxScale,
            y: imgY + (p.y - icy) * syScale,
          }));
        } else if (contourTransformRef.current) {
          const ct = contourTransformRef.current;
          const sxScale = ct.width / lockedContour.contourCanvasWidth;
          const syScale = ct.height / lockedContour.contourCanvasHeight;
          transformPts = (pts) => pts.map(p => ({
            x: ct.x + p.x * sxScale,
            y: ct.y + p.y * syScale,
          }));
        } else {
          const availW = canvas.width;
          const availH = canvas.height;
          const lcAspect = lockedContour.contourCanvasWidth / lockedContour.contourCanvasHeight;
          let lcW: number, lcH: number;
          if (lcAspect > (availW / availH)) {
            lcW = availW;
            lcH = availW / lcAspect;
          } else {
            lcH = availH;
            lcW = availH * lcAspect;
          }
          const lcX = (canvas.width - lcW) / 2;
          const lcY = (canvas.height - lcH) / 2;
          const sxScale = lcW / lockedContour.contourCanvasWidth;
          const syScale = lcH / lockedContour.contourCanvasHeight;
          transformPts = (pts) => pts.map(p => ({
            x: lcX + p.x * sxScale,
            y: lcY + p.y * syScale,
          }));
        }

        // Draw each contour path
        for (const pathPts of pathArrays) {
          if (pathPts.length < 3) continue;
          const screenPts = transformPts(pathPts);
          if (screenPts.length > 2) {
            ctx.save();
            ctx.strokeStyle = '#3B82F6';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(screenPts[0].x, screenPts[0].y);
            for (let i = 1; i < screenPts.length; i++) {
              ctx.lineTo(screenPts[i].x, screenPts[i].y);
            }
            ctx.closePath();
            ctx.stroke();
            ctx.restore();
          }
        }
      }
      };
      renderRef.current = () => {
        doRender();
        if (imageInfo && !contourPendingRef.current) {
          onPreviewStatus?.(imageInfo.image, 'ready');
        }
      };
      if (renderRafRef.current) cancelAnimationFrame(renderRafRef.current);
      renderRafRef.current = requestAnimationFrame(() => {
        renderRafRef.current = null;
        renderRef.current?.();
      });
      return () => {
        if (renderRafRef.current) { cancelAnimationFrame(renderRafRef.current); renderRafRef.current = null; }
      };
    }, [imageInfo, imageInfo?.importedOverlays, strokeSettings, resizeSettings, shapeSettings, cadCutBounds, backgroundColor, isProcessing, spotPreviewData, previewDims.height, previewDims.width, lockedContour, segmentationData, gangSheetView, gangSheetView ? zoom : 1, isEnhancing, onPreviewStatus]);

    useEffect(() => {
      if (!spotPreviewData?.enabled) {
        spotPulseRef.current = 1;
        if (spotAnimFrameRef.current !== null) {
          cancelAnimationFrame(spotAnimFrameRef.current);
          spotAnimFrameRef.current = null;
        }
        return;
      }
      
      spotPulseRef.current = 1;
      if (spotAnimFrameRef.current !== null) {
        cancelAnimationFrame(spotAnimFrameRef.current);
        spotAnimFrameRef.current = null;
      }
      if (renderRef.current) renderRef.current();
    }, [spotPreviewData]);

    useEffect(() => {
      segmentOverlayCacheRef.current = null;
      if (segmentationData?.enabled && segmentationData.layers.length > 0) {
        for (const layer of segmentationData.layers) {
          if (!segmentMaskImagesRef.current.has(layer.id)) {
            const img = new Image();
            img.src = layer.maskDataUrl;
            img.onload = () => {
              if (renderRef.current) renderRef.current();
            };
            segmentMaskImagesRef.current.set(layer.id, img);
          }
        }
      }
      if (renderRef.current) renderRef.current();
    }, [segmentationData]);

    const createSpotOverlayCanvas = (source?: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement | null => {
      if (!imageInfo || !spotPreviewData?.enabled) return null;
      const colors = spotPreviewData.colors;
      const skipChannels = {
        white: !!overlayByRole(imageInfo.importedOverlays, "spotWhite"),
        gloss: !!overlayByRole(imageInfo.importedOverlays, "spotGloss"),
      };
      const cacheKey = overlayCacheKey(colors, skipChannels);
      if (spotOverlayCacheRef.current?.key === cacheKey) {
        return spotOverlayCacheRef.current.canvas;
      }
      const pixelMap = (spotPreviewData.pixelMap && spotPreviewData.mapWidth && spotPreviewData.mapHeight)
        ? { pixelMap: spotPreviewData.pixelMap, mapWidth: spotPreviewData.mapWidth, mapHeight: spotPreviewData.mapHeight }
        : undefined;
      const overlayCanvas = buildSpotOverlayCanvas(source || imageInfo.image, colors, pixelMap, skipChannels);
      if (!overlayCanvas) return null;
      spotOverlayCacheRef.current = { key: cacheKey, canvas: overlayCanvas };
      return overlayCanvas;
    };

    const createSegmentOverlayCanvas = (): HTMLCanvasElement | null => {
      if (!imageInfo || !segmentationData?.enabled || segmentationData.mode !== 'items') return null;

      const visibleLayers = segmentationData.layers.filter(l => l.visible);
      if (visibleLayers.length === 0) return null;

      const cacheKey = `seg-${visibleLayers.map(l => `${l.id}:${l.spotWhite}:${l.spotGloss}:${l.visible}`).join(',')}`;
      if (segmentOverlayCacheRef.current?.key === cacheKey) {
        return segmentOverlayCacheRef.current.canvas;
      }

      const w = imageInfo.image.width;
      const h = imageInfo.image.height;

      const overlayCanvas = document.createElement('canvas');
      overlayCanvas.width = w;
      overlayCanvas.height = h;
      const overlayCtx = overlayCanvas.getContext('2d');
      if (!overlayCtx) return null;

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = w;
      tempCanvas.height = h;
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) return null;

      for (const layer of visibleLayers) {
        if (!layer.spotWhite && !layer.spotGloss) continue;

        let maskImg = segmentMaskImagesRef.current.get(layer.id);
        if (!maskImg || maskImg.src !== layer.maskDataUrl) {
          maskImg = new Image();
          maskImg.src = layer.maskDataUrl;
          segmentMaskImagesRef.current.set(layer.id, maskImg);
        }

        if (!maskImg.complete || maskImg.naturalWidth === 0) continue;

        tempCtx.clearRect(0, 0, w, h);
        tempCtx.drawImage(maskImg, 0, 0, w, h);
        const maskData = tempCtx.getImageData(0, 0, w, h);
        const pixels = maskData.data;

        for (let i = 0; i < pixels.length; i += 4) {
          const brightness = pixels[i] + pixels[i + 1] + pixels[i + 2];
          if (brightness > 128 * 3 && pixels[i + 3] > 128) {
            if (layer.spotWhite) {
              pixels[i] = 255;
              pixels[i + 1] = 0;
              pixels[i + 2] = 255;
              pixels[i + 3] = 200;
            } else if (layer.spotGloss) {
              pixels[i] = 57;
              pixels[i + 1] = 255;
              pixels[i + 2] = 20;
              pixels[i + 3] = 200;
            }
          } else {
            pixels[i + 3] = 0;
          }
        }

        tempCtx.putImageData(maskData, 0, 0);
        overlayCtx.drawImage(tempCanvas, 0, 0);
      }

      segmentOverlayCacheRef.current = { key: cacheKey, canvas: overlayCanvas };
      return overlayCanvas;
    };

    useEffect(() => {
      if (!imageInfo) return;
      const settingsKey = `${strokeSettings.enabled}-${strokeSettings.width}-${shapeSettings.enabled}-${shapeSettings.type}-${resizeSettings.widthInches}`;
      if (lastSettingsRef.current && lastSettingsRef.current !== settingsKey) {
        setShowHighlight(true);
        const timer = setTimeout(() => setShowHighlight(false), 500);
        return () => clearTimeout(timer);
      }
      lastSettingsRef.current = settingsKey;
    }, [imageInfo, strokeSettings.enabled, strokeSettings.width, shapeSettings.enabled, shapeSettings.type, resizeSettings.widthInches]);

    // Overlay crisp vector QRs onto a canvas region so the preview matches
    // the exported PDF. Skipped silently when QR codes haven't been
    // detected, when the user hasn't opted in (`qrRerenderEnabled`), or
    // when the image rect is degenerate. Same source-aware appearance
    // pipeline as `drawVectorQRsOnPage` (PDF side) — module shape,
    // dark/light colours, and any centred-logo region are sampled from
    // the source raster and respected.
    const overlayQRsOnCanvasRect = (
      ctx: CanvasRenderingContext2D,
      sourceImage: HTMLImageElement | HTMLCanvasElement,
      imageRect: { x: number; y: number; width: number; height: number },
    ) => {
      if (!imageInfo?.qrCodes || imageInfo.qrCodes.length === 0) return;
      if (imageInfo.qrRerenderEnabled !== true) return;
      if (imageRect.width <= 0 || imageRect.height <= 0) return;
      const srcW = (sourceImage as HTMLImageElement).naturalWidth || sourceImage.width;
      const srcH = (sourceImage as HTMLImageElement).naturalHeight || sourceImage.height;
      if (srcW <= 0 || srcH <= 0) return;
      drawVectorQRsOnCanvas2D(
        ctx,
        imageInfo.qrCodes,
        imageRect,
        srcW,
        srcH,
        sourceImage,
        { errorCorrectionLevel: 'H' },
      );
    };

    const drawShapePreview = (ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number) => {
      if (!imageInfo) return;

      const shapeDims = resolveShapeDimensions(shapeSettings, resizeSettings);

      const bleedInches = 0.10;
      const shapeAspect = shapeDims.widthInches / shapeDims.heightInches;
      const viewPadding = previewFitInset(canvasWidth, canvasHeight);
      const availableWidth = canvasWidth - viewPadding * 2;
      const availableHeight = canvasHeight - viewPadding * 2;

      let shapeWidth: number, shapeHeight: number;
      if (shapeAspect > (availableWidth / availableHeight)) {
        shapeWidth = availableWidth;
        shapeHeight = availableWidth / shapeAspect;
      } else {
        shapeHeight = availableHeight;
        shapeWidth = availableHeight * shapeAspect;
      }

      const shapeX = (canvasWidth - shapeWidth) / 2;
      const shapeY = (canvasHeight - shapeHeight) / 2;
      const ppi = Math.min(shapeWidth / shapeDims.widthInches, shapeHeight / shapeDims.heightInches);
      const bleedPx = shapeSettings.bleedEnabled ? bleedInches * ppi : 0;
      const cornerRadiusPx = (shapeSettings.cornerRadius || 0.25) * ppi;
      const rotation = shapeSettings.rotation || 0;
      const centerX = shapeX + shapeWidth / 2;
      const centerY = shapeY + shapeHeight / 2;

      const sourceImage = getPreviewImage();
      const imgScale = shapeSettings.imageScale || 1;
      let imageWidth = resizeSettings.widthInches * ppi * imgScale;
      let imageHeight = resizeSettings.heightInches * ppi * imgScale;
      const imageX = shapeX + (shapeWidth - imageWidth) / 2 + (shapeSettings.imageOffsetX || 0) * ppi;
      const imageY = shapeY + (shapeHeight - imageHeight) / 2 + (shapeSettings.imageOffsetY || 0) * ppi;

      const buildPath = (ctx: CanvasRenderingContext2D, sw: number, sh: number, sx: number, sy: number, cr: number) => {
        traceShapeCanvasPath(ctx, shapeSettings.type, sx, sy, sw, sh, cr);
      };

      const applyRotation = () => {
        if (rotation !== 0) {
          ctx.translate(centerX, centerY);
          ctx.rotate(rotation * Math.PI / 180);
          ctx.translate(-centerX, -centerY);
        }
      };

      // Bleed fill
      if (shapeSettings.bleedEnabled) {
        ctx.save();
        applyRotation();
        ctx.fillStyle = shapeSettings.bleedColor || '#FFFFFF';
        buildPath(ctx, shapeWidth + bleedPx * 2, shapeHeight + bleedPx * 2, shapeX - bleedPx, shapeY - bleedPx, cornerRadiusPx);
        ctx.fill();
        ctx.restore();
      }

      // Inner fill
      ctx.save();
      applyRotation();
      if (shapeSettings.fillColor === 'holographic') {
        const gradient = ctx.createLinearGradient(shapeX, shapeY, shapeX + shapeWidth, shapeY + shapeHeight);
        gradient.addColorStop(0, '#C8C8D0'); gradient.addColorStop(0.17, '#E8B8B8');
        gradient.addColorStop(0.34, '#B8D8E8'); gradient.addColorStop(0.51, '#E8D0F0');
        gradient.addColorStop(0.68, '#B0C8E0'); gradient.addColorStop(0.85, '#C0B0D8');
        gradient.addColorStop(1, '#C8C8D0');
        ctx.fillStyle = gradient;
      } else {
        ctx.fillStyle = shapeSettings.fillColor;
      }
      buildPath(ctx, shapeWidth, shapeHeight, shapeX, shapeY, cornerRadiusPx);
      ctx.fill();
      ctx.restore();

      // Border/stroke (visible printed border)
      if (shapeSettings.strokeEnabled) {
        ctx.save();
        applyRotation();
        ctx.strokeStyle = shapeSettings.strokeColor || '#000000';
        ctx.lineWidth = (shapeSettings.strokeWidth || 1) * (ppi / 72);
        buildPath(ctx, shapeWidth, shapeHeight, shapeX, shapeY, cornerRadiusPx);
        ctx.stroke();
        ctx.restore();
      }

      // Clipped image
      ctx.save();
      applyRotation();
      buildPath(ctx, shapeWidth, shapeHeight, shapeX, shapeY, cornerRadiusPx);
      ctx.clip();
      ctx.drawImage(sourceImage, imageX, imageY, imageWidth, imageHeight);
      // Overlay crisp vector QRs *inside* the clip + rotation transform so
      // they follow the cropped/rotated raster. Matches the PDF export.
      // IMPORTANT: pass the original `imageInfo.image` (not the possibly-downscaled
      // `sourceImage` from getPreviewImage) — the QR bboxes are stored in original
      // image pixel coordinates, so the overlay needs the original natural dimensions
      // to compute the correct scale factor and sample the right pixel colours.
      overlayQRsOnCanvasRect(ctx, imageInfo.image, { x: imageX, y: imageY, width: imageWidth, height: imageHeight });
      lastImageRenderRef.current = { x: imageX, y: imageY, width: imageWidth, height: imageHeight };

      if (segmentationData?.mode === 'items') {
        const segOverlay = createSegmentOverlayCanvas();
        if (segOverlay) {
          ctx.save();
          ctx.globalAlpha = spotPulseRef.current;
          ctx.drawImage(segOverlay, imageX, imageY, imageWidth, imageHeight);
          ctx.restore();
        }
      } else {
        const spotOverlay = createSpotOverlayCanvas(sourceImage);
        if (spotOverlay) {
          ctx.save();
          ctx.globalAlpha = spotPulseRef.current;
          ctx.drawImage(spotOverlay, imageX, imageY, imageWidth, imageHeight);
          ctx.restore();
        }
      }
      ctx.restore();

      // The PDF strokes CutContour *after* drawing the artwork. Do the same
      // here: ink touching the die edge must not paint over the preview line.
      ctx.save();
      applyRotation();
      ctx.strokeStyle = '#FF00FF';
      ctx.lineWidth = 2;
      buildPath(ctx, shapeWidth, shapeHeight, shapeX, shapeY, cornerRadiusPx);
      ctx.stroke();
      ctx.restore();
    };

    const drawImageWithResizePreview = (ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number) => {
      if (!imageInfo) return;

      const viewPadding = previewFitInset(canvasWidth, canvasHeight);
      const availableWidth = canvasWidth - viewPadding * 2;
      const availableHeight = canvasHeight - viewPadding * 2;
      
      if (strokeSettings.enabled && contourCacheRef.current?.canvas && !isProcessing) {
        const contourCanvas = contourCacheRef.current.canvas;
        
        const contourAspectRatio = contourCanvas.width / contourCanvas.height;
        
        let contourWidth, contourHeight;
        if (contourAspectRatio > (availableWidth / availableHeight)) {
          contourWidth = availableWidth;
          contourHeight = availableWidth / contourAspectRatio;
        } else {
          contourHeight = availableHeight;
          contourWidth = availableHeight * contourAspectRatio;
        }
        
        const contourX = (canvasWidth - contourWidth) / 2;
        const contourY = (canvasHeight - contourHeight) / 2;
        
        contourTransformRef.current = {
          x: contourX, y: contourY,
          width: contourWidth, height: contourHeight,
          canvasW: contourCanvas.width, canvasH: contourCanvas.height
        };
        
        if (strokeSettings.backgroundColor === 'holographic') {
          const holoKey = `${contourCacheRef.current?.key || ''}-${contourCanvas.width}x${contourCanvas.height}`;
          let holoCanvas = holographicCacheRef.current?.contourKey === holoKey ? holographicCacheRef.current.canvas : null;
          
          if (!holoCanvas) {
            holoCanvas = document.createElement('canvas');
            holoCanvas.width = contourCanvas.width;
            holoCanvas.height = contourCanvas.height;
            const tempCtx = holoCanvas.getContext('2d')!;
            tempCtx.drawImage(contourCanvas, 0, 0);
            
            const imageData = tempCtx.getImageData(0, 0, holoCanvas.width, holoCanvas.height);
            const pixels = imageData.data;
            
            const gradientCanvas = document.createElement('canvas');
            gradientCanvas.width = holoCanvas.width;
            gradientCanvas.height = holoCanvas.height;
            const gradCtx = gradientCanvas.getContext('2d')!;
            const gradient = gradCtx.createLinearGradient(0, 0, gradientCanvas.width, gradientCanvas.height);
            gradient.addColorStop(0, '#C8C8D0');
            gradient.addColorStop(0.17, '#E8B8B8');
            gradient.addColorStop(0.34, '#B8D8E8');
            gradient.addColorStop(0.51, '#E8D0F0');
            gradient.addColorStop(0.68, '#B0C8E0');
            gradient.addColorStop(0.85, '#C0B0D8');
            gradient.addColorStop(1, '#C8C8D0');
            gradCtx.fillStyle = gradient;
            gradCtx.fillRect(0, 0, gradientCanvas.width, gradientCanvas.height);
            const gradientData = gradCtx.getImageData(0, 0, gradientCanvas.width, gradientCanvas.height);
            const gradPixels = gradientData.data;
            
            for (let i = 0; i < pixels.length; i += 4) {
              if (pixels[i + 3] > 200 && pixels[i] > 240 && pixels[i + 1] > 240 && pixels[i + 2] > 240) {
                pixels[i] = gradPixels[i];
                pixels[i + 1] = gradPixels[i + 1];
                pixels[i + 2] = gradPixels[i + 2];
              }
            }
            
            tempCtx.putImageData(imageData, 0, 0);
            holographicCacheRef.current = { contourKey: holoKey, canvas: holoCanvas };
          }
          
          ctx.drawImage(holoCanvas, contourX, contourY, contourWidth, contourHeight);
        } else {
          ctx.drawImage(contourCanvas, contourX, contourY, contourWidth, contourHeight);
        }

        {
          const dsScale = contourCacheRef.current?.downsampleScale ?? 1;
          const dsWidth = Math.round(imageInfo.image.width * dsScale);
          const dsHeight = Math.round(imageInfo.image.height * dsScale);
          const _imgX = contourCacheRef.current?.imageCanvasX ?? 0;
          const _imgY = contourCacheRef.current?.imageCanvasY ?? 0;
          const _scaleX = contourWidth / contourCanvas.width;
          const _scaleY = contourHeight / contourCanvas.height;
          const imageRectOnCanvas = {
            x: contourX + (_imgX * _scaleX),
            y: contourY + (_imgY * _scaleY),
            width: dsWidth * _scaleX,
            height: dsHeight * _scaleY,
          };
          lastImageRenderRef.current = imageRectOnCanvas;
          // Overlay crisp vector QRs *over* the worker's rasterised
          // contour preview at the same image rect so the on-screen QRs
          // match what the PDF export bakes in.
          overlayQRsOnCanvasRect(ctx, imageInfo.image, imageRectOnCanvas);
        }
        
        if (segmentationData?.mode === 'items') {
          const segOverlay = createSegmentOverlayCanvas();
          if (segOverlay) {
            const dsScale = contourCacheRef.current?.downsampleScale ?? 1;
            const dsWidth = Math.round(imageInfo.image.width * dsScale);
            const dsHeight = Math.round(imageInfo.image.height * dsScale);
            const imgX = contourCacheRef.current?.imageCanvasX ?? 0;
            const imgY = contourCacheRef.current?.imageCanvasY ?? 0;
            const scaleX = contourWidth / contourCanvas.width;
            const scaleY = contourHeight / contourCanvas.height;
            const segX = contourX + (imgX * scaleX);
            const segY = contourY + (imgY * scaleY);
            const segW = dsWidth * scaleX;
            const segH = dsHeight * scaleY;
            ctx.save();
            ctx.globalAlpha = spotPulseRef.current;
            ctx.drawImage(segOverlay, segX, segY, segW, segH);
            ctx.restore();
          }
        } else {
          const spotOverlay = createSpotOverlayCanvas();
          if (spotOverlay) {
            const dsScale = contourCacheRef.current?.downsampleScale ?? 1;
            const dsWidth = Math.round(imageInfo.image.width * dsScale);
            const dsHeight = Math.round(imageInfo.image.height * dsScale);
            const imgX = contourCacheRef.current?.imageCanvasX ?? 0;
            const imgY = contourCacheRef.current?.imageCanvasY ?? 0;
            const scaleX = contourWidth / contourCanvas.width;
            const scaleY = contourHeight / contourCanvas.height;
            const spotX = contourX + (imgX * scaleX);
            const spotY = contourY + (imgY * scaleY);
            const spotWidth = dsWidth * scaleX;
            const spotHeight = dsHeight * scaleY;
            ctx.save();
            ctx.globalAlpha = spotPulseRef.current;
            ctx.drawImage(spotOverlay, spotX, spotY, spotWidth, spotHeight);
            ctx.restore();
          }
        }
      } else {
        const aspectRatio = imageInfo.image.width / imageInfo.image.height;
        let displayWidth, displayHeight;
        if (aspectRatio > (availableWidth / availableHeight)) {
          displayWidth = availableWidth;
          displayHeight = availableWidth / aspectRatio;
        } else {
          displayHeight = availableHeight;
          displayWidth = availableHeight * aspectRatio;
        }
        
        const displayX = (canvasWidth - displayWidth) / 2;
        const displayY = (canvasHeight - displayHeight) / 2;
        
        const previewImg = getPreviewImage();
        ctx.drawImage(previewImg, displayX, displayY, displayWidth, displayHeight);
        // Crisp vector QR overlay matching PDF export. We use the live
        // `imageInfo.image` (not `previewImg`) for appearance sampling
        // because the QR bbox coords are in the source-image pixel space,
        // and `imageInfo.image` is the canonical source the QR detector
        // ran against.
        overlayQRsOnCanvasRect(ctx, imageInfo.image, { x: displayX, y: displayY, width: displayWidth, height: displayHeight });
        lastImageRenderRef.current = { x: displayX, y: displayY, width: displayWidth, height: displayHeight };

        if (segmentationData?.mode === 'items') {
          const segOverlay = createSegmentOverlayCanvas();
          if (segOverlay) {
            ctx.save();
            ctx.globalAlpha = spotPulseRef.current;
            ctx.drawImage(segOverlay, displayX, displayY, displayWidth, displayHeight);
            ctx.restore();
          }
        } else {
          const spotOverlay = createSpotOverlayCanvas();
          if (spotOverlay) {
            ctx.save();
            ctx.globalAlpha = spotPulseRef.current;
            ctx.drawImage(spotOverlay, displayX, displayY, displayWidth, displayHeight);
            ctx.restore();
          }
        }
      }
    };

    const effectiveBackground = (() => {
      const hasPdfCutContour = imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour;
      return hasPdfCutContour ? strokeSettings.backgroundColor : backgroundColor;
    })();
    const isTransparentBg = effectiveBackground === "transparent";

    return (
      <div className="designer-preview w-full min-w-0">
        <Card className="border-white/10 shadow-sm rounded-lg overflow-hidden" style={{ backgroundColor: "#3a6aa0" }}>
          <CardContent className="p-0">
            {/* Design info + preview background swatches — hidden in the admin read-only view. */}
            {!readOnly && <div className="mx-2 mt-2 mb-0 flex items-center gap-1.5 p-1.5 flex-wrap">
              {imageInfo && (
                <div className="flex flex-shrink-0 items-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-100 px-2 py-1">
                  <span className="text-[13px] font-bold leading-none tracking-tight text-cyan-900">Size</span>
                  <span className="text-[12px] font-bold leading-none text-cyan-900">W</span>
                  <SizeInput
                    value={resizeSettings.widthInches}
                    onCommit={(v) => onResizeChange?.({ widthInches: v })}
                    title="Width"
                    min={0.5}
                    max={50}
                    lang="en"
                  />
                  <span className="text-[12px] font-semibold text-cyan-900">"</span>
                  <button
                    type="button"
                    onClick={() => onResizeChange?.({ maintainAspectRatio: !resizeSettings.maintainAspectRatio })}
                    className={`flex h-6 w-6 items-center justify-center rounded ${resizeSettings.maintainAspectRatio ? 'bg-white text-cyan-600 shadow-sm' : 'text-cyan-700/70 hover:bg-white/70'}`}
                    title={resizeSettings.maintainAspectRatio ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                  >
                    {resizeSettings.maintainAspectRatio ? <Link size={14} /> : <Unlink size={14} />}
                  </button>
                  <span className="text-[12px] font-bold leading-none text-cyan-900">H</span>
                  <SizeInput
                    value={resizeSettings.heightInches}
                    onCommit={(v) => onResizeChange?.({ heightInches: v })}
                    title="Height"
                    min={0.5}
                    max={50}
                    lang="en"
                  />
                  <span className="text-[12px] font-semibold text-cyan-900">"</span>
                </div>
              )}
              <button
                onClick={onUndo}
                disabled={!canUndo}
                className="h-8 min-w-[68px] rounded-md border border-white/20 bg-[#244e7a] px-2.5 text-white hover:bg-[#2d5a8a] transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center gap-1.5"
                title="Undo"
              >
                <Undo2 className="w-4 h-4" />
                <span className="text-[13px] font-semibold">UNDO</span>
              </button>
              <button
                onClick={onRedo}
                disabled={!canRedo}
                className="w-8 h-8 rounded border border-gray-300 bg-white hover:bg-gray-100 text-gray-600 hover:text-gray-900 transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center shadow-sm"
                title="Redo"
              >
                <Redo2 className="w-4 h-4" />
              </button>
              {!(imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour) && (
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 ml-auto">
                  {[
                    { value: 'transparent', bg: 'transparent', label: 'Preview background only — stickers print on white vinyl' },
                    { value: '#1e3a5f', bg: '#1e3a5f', label: 'Navy' },
                    { value: '#ffffff', bg: '#ffffff', label: 'White' },
                    { value: '#f3f4f6', bg: '#f3f4f6', label: 'Light Gray' },
                    { value: '#9ca3af', bg: '#9ca3af', label: 'Gray' },
                    { value: '#1f2937', bg: '#1f2937', label: 'Dark Gray' },
                    { value: '#000000', bg: '#000000', label: 'Black' },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setBackgroundColor(opt.value)}
                      title={opt.label}
                      className={`w-6 h-6 rounded-full border-2 transition-all flex-shrink-0 ${
                        backgroundColor === opt.value
                          ? 'border-cyan-400 scale-110 shadow-sm'
                          : 'border-gray-200 hover:border-gray-300'
                      } ${opt.value === 'transparent' ? 'checkerboard' : ''}`}
                      style={opt.value !== 'transparent' ? { backgroundColor: opt.bg } : undefined}
                    />
                  ))}
                </div>
              )}
            </div>}

            <div className="flex min-w-0 flex-col items-start">
              <div className="flex w-full min-w-0">
                <div
                  ref={frameRef}
                  className={`designer-preview-frame relative w-full min-w-0 ${showHighlight ? 'ring-4 ring-indigo-400 ring-opacity-75 transition-shadow duration-300' : ''} ${magicWandMode ? 'ring-2 ring-fuchsia-400 ring-opacity-70' : ''}`}
                  style={{
                    width: '100%',
                    backgroundColor: isTransparentBg ? 'transparent' : effectiveBackground,
                  }}
                >
                <div
                  ref={containerRef}
                  onWheel={handleWheel}
                  className={`spot-uv-artboard-scroll absolute inset-0 ${isTransparentBg ? 'checkerboard' : ''}`}
                  style={{
                    overflow: zoom > 1 ? 'scroll' : 'hidden',
                    userSelect: 'none',
                  }}
                >
                  <div
                    ref={stageRef}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseLeave}
                    onTouchStart={handleTouchStart}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleTouchEnd}
                    className={`${selectZoomMode || magicWandMode || spotPaintMode ? 'cursor-crosshair' : overlayCursor ? '' : zoom > 1 ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'}`}
                    style={{
                      cursor: overlayCursor || undefined,
                      position: 'relative',
                      width: zoom <= 1 ? '100%' : `${Math.max(frameSize.w, 1) * zoom}px`,
                      height: zoom <= 1 ? '100%' : `${Math.max(frameSize.h, 1) * zoom}px`,
                      minWidth: '100%',
                      minHeight: '100%',
                      touchAction: 'none',
                    }}
                  >
                    <canvas
                      ref={canvasRef}
                      className="relative z-10 block"
                      style={{
                        width: '100%',
                        height: '100%',
                        transform: `scale(${Math.min(zoom, 1) * (resizeAnimState?.scale ?? 1)})`,
                        transformOrigin: 'center',
                        transition: resizeAnimState
                          ? (resizeAnimState.transitioning
                            ? 'transform 0.38s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease-out'
                            : 'none')
                          : (isDragging || isSelectingRef.current) ? 'none' : 'transform 0.3s ease-out',
                        opacity: resizeAnimState?.opacity ?? 1,
                      }}
                    />
                  </div>
                </div>
                
                {selectionRect && selectionRect.w > 0 && selectionRect.h > 0 && (
                  <div
                    className="absolute z-30 pointer-events-none"
                    style={{
                      left: selectionRect.x,
                      top: selectionRect.y,
                      width: selectionRect.w,
                      height: selectionRect.h,
                      border: '2px dashed rgba(99, 102, 241, 0.9)',
                      backgroundColor: 'rgba(99, 102, 241, 0.08)',
                      boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.15)',
                    }}
                  />
                )}
                
                {!imageInfo && !gangSheetView && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="text-center">
                      <ImageIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                      <p className="text-gray-500">Upload an image to see preview</p>
                    </div>
                  </div>
                )}
                
                {isProcessing && imageInfo && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30 z-20">
                    <div className="text-center">
                      <Loader2 className="w-8 h-8 text-white mx-auto mb-2 animate-spin" />
                      <p className="text-white text-sm">Processing... {processingProgress}%</p>
                    </div>
                  </div>
                )}
                </div>
                
              </div>
            </div>

            <div className="relative z-20 mx-2 my-2">
              <div
                className="designer-zoom-toolbar"
                style={{ touchAction: "manipulation" }}
              >
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => zoomTo(zoom - 0.25)}
                  disabled={zoom <= 0.25}
                  className="h-11 w-11 min-h-11 min-w-11 p-0 rounded-lg bg-white text-cyan-900 hover:bg-white/90 disabled:bg-white/60"
                  title="Zoom Out"
                  aria-label="Zoom Out"
                >
                  <ZoomOut className="h-4 w-4" />
                </Button>

                <span className="min-w-[3.25rem] rounded-lg bg-white px-2 py-2 text-center text-sm font-bold tabular-nums leading-none text-cyan-950">
                  {Math.round(zoom * 100)}%
                </span>

                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => zoomTo(zoom + 0.25)}
                  disabled={zoom >= 5}
                  className="h-11 w-11 min-h-11 min-w-11 p-0 rounded-lg bg-white text-cyan-900 hover:bg-white/90 disabled:bg-white/60"
                  title="Zoom In"
                  aria-label="Zoom In"
                >
                  <ZoomIn className="h-4 w-4" />
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setSelectZoomMode(prev => !prev)}
                  className={`h-11 min-h-11 min-w-11 px-3 rounded-lg text-sm font-semibold ${
                    selectZoomMode
                      ? "bg-indigo-600 text-white hover:bg-indigo-700"
                      : "bg-white text-cyan-900 hover:bg-white/90"
                  }`}
                  title="Select area to zoom into"
                  aria-label="Select Zoom"
                >
                  <Scan className="h-4 w-4" />
                  <span className="hidden sm:inline">Select</span>
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={resetView}
                  disabled={Math.abs(zoom - 1) < 0.01 && !selectZoomMode}
                  className="h-11 min-h-11 px-3 rounded-lg bg-[#0e7490] text-white hover:bg-[#0f766e] disabled:bg-white disabled:text-cyan-800/50"
                  title="Reset zoom to 100% (fit with pasteboard)"
                  aria-label="Reset zoom"
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset
                </Button>
              </div>
            </div>

          </CardContent>
        </Card>
      </div>
    );
  }
);

PreviewSection.displayName = 'PreviewSection';

export default PreviewSection;
