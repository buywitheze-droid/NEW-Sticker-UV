import ContourWorker from './contour-worker?worker';
import { workersHealthy } from './worker-health';
import { offloadHealthy, pauseOffloadAfterFailure } from './offload-health';
import { traceContourViaOffload } from './offload-client';

const MAX_PROCESSING_DIMENSION = 4000;
const MAX_PREVIEW_DIMENSION = 400;
const WORKER_TIMEOUT_MS = 45_000;

// Tighter cap for the main-thread fallback. The silhouette-mask /
// gap-bridge / morphology pipeline in `createSilhouetteContour` is O(W*H)
// and runs synchronously, so anything above ~1500 px on the longest side
// freezes the UI for many seconds (or minutes for 3000–4000 px inputs).
// For a preview cutpath, 1500 px is more than enough fidelity to trace
// the silhouette accurately.
const MAX_FALLBACK_DIMENSION = 1500;

function downsampleImage(
  image: HTMLImageElement,
  maxProcessingDimension = MAX_PROCESSING_DIMENSION,
): { canvas: HTMLCanvasElement; scale: number } {
  const maxDim = Math.max(image.width, image.height);
  
  if (maxDim <= maxProcessingDimension) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    return { canvas, scale: 1 };
  }
  
  const scale = maxProcessingDimension / maxDim;
  const newWidth = Math.round(image.width * scale);
  const newHeight = Math.round(image.height * scale);
  
  console.log(`[ContourWorker] Downsampling from ${image.width}x${image.height} to ${newWidth}x${newHeight} (scale: ${scale.toFixed(3)})`);
  
  const canvas = document.createElement('canvas');
  canvas.width = newWidth;
  canvas.height = newHeight;
  const ctx = canvas.getContext('2d')!;
  
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, newWidth, newHeight);
  
  return { canvas, scale };
}

export type DetectedAlgorithm = 'complex' | 'scattered';
export type ContourMode = 'smooth' | 'scattered';

// ─── Bezier-curve cut-path representation (Zero Hero only) ──────────────────
// Mirrors the shape declared inside the worker. Kept here because the
// download/PDF emit path lives in the main thread and consumes this data via
// `getCachedContourData()`.

export interface BezierLineSegment {
  type: 'line';
  to: { x: number; y: number };
}

export interface BezierCubicSegment {
  type: 'cubic';
  cp1: { x: number; y: number };
  cp2: { x: number; y: number };
  to: { x: number; y: number };
}

export type BezierSegment = BezierLineSegment | BezierCubicSegment;

export interface BezierPath {
  start: { x: number; y: number };
  segments: BezierSegment[];
  closed: true;
}

export interface ContourData {
  pathPoints: Array<{x: number; y: number}>;
  previewPathPoints: Array<{x: number; y: number}>;
  allPathPoints?: Array<Array<{x: number; y: number}>>;
  allPreviewPathPoints?: Array<Array<{x: number; y: number}>>;
  // Smooth-curve cut-path representation. When present (Zero Hero mode), the
  // PDF emitter prefers these over the polyline `allPathPoints` so curves
  // are rendered as cubic Beziers instead of polygonal chords.
  allBezierPaths?: BezierPath[];
  allBezierPathsPreview?: BezierPath[];
  widthInches: number;
  heightInches: number;
  imageOffsetX: number;
  imageOffsetY: number;
  backgroundColor: string;
  useEdgeBleed: boolean;
  effectiveDPI: number;
  minPathX: number;
  minPathY: number;
  bleedInches: number;
  holePathStartIndex?: number;
}

interface WorkerResponse {
  type: 'result' | 'error' | 'progress';
  imageData?: ImageData;
  imageCanvasX?: number;
  imageCanvasY?: number;
  error?: string;
  progress?: number;
  contourData?: ContourData;
  detectedAlgorithm?: DetectedAlgorithm;
}

interface WorkerResult {
  imageData: ImageData;
  imageCanvasX?: number;
  imageCanvasY?: number;
  contourData?: ContourData;
  detectedAlgorithm?: DetectedAlgorithm;
}

interface ResizeSettings {
  widthInches: number;
  heightInches: number;
  maintainAspectRatio: boolean;
  outputDPI: number;
}

export type DetectedShapeType = 'circle' | 'oval' | 'square' | 'rectangle' | null;

export interface DetectedShapeInfo {
  type: 'circle' | 'oval' | 'square' | 'rectangle';
  boundingBox: { x: number; y: number; width: number; height: number };
}

interface ProcessRequest {
  imageData: ImageData;
  strokeSettings: {
    width: number;
    color: string;
    enabled: boolean;
    alphaThreshold: number;
    backgroundColor: string;
    useCustomBackground: boolean;
    autoBridging: boolean;
    autoBridgingThreshold: number;
    contourMode?: ContourMode;
  };
  effectiveDPI: number;
  resizeSettings: ResizeSettings;
  previewMode?: boolean;
  detectedShapeType?: DetectedShapeType;
  detectedShapeInfo?: DetectedShapeInfo | null;
  generation: number;
}

type ProgressCallback = (progress: number) => void;

class ContourWorkerManager {
  private readonly displayOnly: boolean;
  private worker: Worker | null = null;
  private isProcessing = false;
  private workerTimeout: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private pendingRequest: {
    request: ProcessRequest;
    resolve: (result: WorkerResult) => void;
    reject: (error: Error) => void;
    onProgress?: ProgressCallback;
  } | null = null;
  private currentRequest: {
    generation: number;
    resolve: (result: WorkerResult) => void;
    reject: (error: Error) => void;
    onProgress?: ProgressCallback;
  } | null = null;
  
  private cachedContourData: ContourData | null = null;
  private lastProcessKey: string | null = null;
  private lastProcessResult: { canvas: HTMLCanvasElement; downsampleScale: number; imageCanvasX: number; imageCanvasY: number; contourData?: ContourData; detectedAlgorithm?: DetectedAlgorithm } | null = null;

  // Resolves once the health probe finishes. While pending, `process()`
  // routes through the fallback so we never block on a worker that may be
  // dead. After it resolves we either kept `worker !== null` (real
  // browser) or set it to null (Cursor preview / similar).
  private workerHealthReady: Promise<void>;

  constructor(displayOnly = false) {
    this.displayOnly = displayOnly;
    this.workerHealthReady = this.initWorker();
  }
  
  getCachedContourData(): ContourData | null {
    return this.cachedContourData;
  }
  
  clearCache() {
    this.cachedContourData = null;
    this.lastProcessKey = null;
    this.lastProcessResult = null;
  }

  private clearWorkerTimeout() {
    if (this.workerTimeout) {
      clearTimeout(this.workerTimeout);
      this.workerTimeout = null;
    }
  }

  /**
   * Reject anything in flight or queued without tearing the worker down.
   * Cheap counterpart to `recreateWorker()` — call when the design has
   * been swapped/removed and the previous trace is no longer relevant.
   * The worker may still be computing the old image, but its eventual
   * `result` message will hit `handleMessage` with `currentRequest === null`
   * and be ignored.
   */
  cancelInFlight(reason: string = 'Cancelled by caller') {
    // A process() call can be waiting for the worker-health probe without
    // having installed currentRequest yet. Bump the generation first so it
    // cannot resume and write a result after this cancellation.
    this.generation++;
    const hadActiveRequest = Boolean(this.currentRequest || this.pendingRequest || this.isProcessing);
    this.clearWorkerTimeout();
    if (this.currentRequest) {
      this.currentRequest.reject(new Error(reason));
      this.currentRequest = null;
    }
    if (this.pendingRequest) {
      this.pendingRequest.reject(new Error(reason));
      this.pendingRequest = null;
    }
    this.isProcessing = false;
    if (hadActiveRequest && this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.workerHealthReady = this.initWorker();
    }
  }

  private async initWorker(): Promise<void> {
    // Probe whether `new Worker(...)` is actually functional in this
    // environment before instantiating the contour worker. Embedded
    // browsers (notably Cursor IDE's Electron preview) silently swallow
    // postMessage in workers, which previously caused the contour pipeline
    // to hang forever. In real browsers the probe resolves in single-digit
    // ms and we get the full off-thread benefit.
    const healthy = await workersHealthy();
    if (!healthy) {
      console.warn('[ContourWorker] worker probe failed — staying on main-thread fallback');
      this.worker = null;
      return;
    }
    try {
      const worker = new ContourWorker();
      // Keep the worker instance in the handler closure. A terminated worker
      // can still have a queued message in some browsers; never let that
      // message be consumed by a newer request on a replacement worker.
      worker.onmessage = (event) => {
        if (this.worker === worker) {
          this.handleMessage(event);
        }
      };
      worker.onerror = (error) => {
        if (this.worker === worker) {
          this.handleError(error);
        }
      };
      this.worker = worker;
      console.log('[ContourWorker] worker thread active');
    } catch (error) {
      console.warn('[ContourWorker] construct threw — falling back to main thread:', error);
      this.worker = null;
    }
  }

  recreateWorker() {
    this.generation++;
    this.clearWorkerTimeout();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.currentRequest) {
      this.currentRequest.reject(new Error('Worker recreated due to code update'));
    }
    if (this.pendingRequest) {
      this.pendingRequest.reject(new Error('Worker recreated due to code update'));
    }
    this.isProcessing = false;
    this.pendingRequest = null;
    this.currentRequest = null;
    // Critical: invalidate the manager-level result cache too. Otherwise the
    // next process() call would short-circuit and return the previous
    // worker's result (computed with the old code), defeating the HMR update.
    this.clearCache();
    this.workerHealthReady = this.initWorker();
    console.log('[ContourWorker] Worker recreated for code update (cache cleared)');
  }

  private handleMessage(e: MessageEvent<WorkerResponse>) {
    const { type, imageData, imageCanvasX, imageCanvasY, error, progress, contourData, detectedAlgorithm } = e.data;

    if (
      type === 'progress' &&
      this.currentRequest &&
      this.currentRequest.generation === this.generation &&
      this.currentRequest.onProgress &&
      progress !== undefined
    ) {
      this.currentRequest.onProgress(progress);
      return;
    }

    if (type === 'result' && imageData && this.currentRequest) {
      if (this.currentRequest.generation !== this.generation) {
        this.currentRequest.reject(new Error('Contour processing cancelled'));
        this.finishProcessing();
        return;
      }
      if (contourData) {
        this.cachedContourData = contourData;
      }
      this.currentRequest.resolve({ imageData, imageCanvasX, imageCanvasY, contourData, detectedAlgorithm });
      this.finishProcessing();
    } else if (type === 'error' && this.currentRequest) {
      this.currentRequest.reject(new Error(error || 'Unknown worker error'));
      this.finishProcessing();
    }
  }

  private handleError(error: ErrorEvent) {
    console.error('Worker error:', error);
    this.clearWorkerTimeout();
    if (this.currentRequest) {
      this.currentRequest.reject(new Error('Worker crashed'));
    }
    if (this.pendingRequest) {
      this.pendingRequest.reject(new Error('Worker crashed'));
    }
    this.currentRequest = null;
    this.pendingRequest = null;
    this.isProcessing = false;
    this.worker?.terminate();
    this.worker = null;
    this.workerHealthReady = this.initWorker();
  }

  private finishProcessing() {
    this.clearWorkerTimeout();
    this.currentRequest = null;
    this.isProcessing = false;

    if (this.pendingRequest) {
      const { request, resolve, reject, onProgress } = this.pendingRequest;
      this.pendingRequest = null;
      this.processInWorker(request, onProgress).then(resolve).catch(reject);
    }
  }

  async process(
    image: HTMLImageElement,
    strokeSettings: {
      width: number;
      color: string;
      enabled: boolean;
      alphaThreshold: number;
      backgroundColor: string;
      useCustomBackground: boolean;
      autoBridging: boolean;
      autoBridgingThreshold: number;
      contourMode?: ContourMode;
      cornerMode?: string;
    },
    resizeSettings: ResizeSettings,
    onProgress?: ProgressCallback,
    detectedShapeType?: DetectedShapeType,
    detectedShapeInfo?: DetectedShapeInfo | null
  ): Promise<{ canvas: HTMLCanvasElement; downsampleScale: number; imageCanvasX: number; imageCanvasY: number; contourData?: ContourData; detectedAlgorithm?: DetectedAlgorithm }> {
    const generation = this.generation;
    const processKey = JSON.stringify([
      image.src, image.width, image.height, strokeSettings.width, strokeSettings.color,
      strokeSettings.enabled, strokeSettings.alphaThreshold, strokeSettings.backgroundColor,
      strokeSettings.useCustomBackground, strokeSettings.autoBridging,
      strokeSettings.autoBridgingThreshold, strokeSettings.contourMode, strokeSettings.cornerMode,
      (strokeSettings as any).includeHoles, resizeSettings.widthInches,
      resizeSettings.heightInches, resizeSettings.maintainAspectRatio, resizeSettings.outputDPI,
      detectedShapeType, detectedShapeInfo?.boundingBox,
    ]);
    if (this.lastProcessKey === processKey && this.lastProcessResult) {
      return this.lastProcessResult;
    }

    // Wait for the worker-health probe to settle so the first call after
    // page load doesn't race-fall-back to the main thread before the
    // worker has even had a chance to be constructed.
    await this.workerHealthReady;
    if (generation !== this.generation) {
      throw new Error('Contour processing cancelled');
    }

    if (!this.worker) {
      const fallback = await this.processFallback(
        image,
        strokeSettings,
        resizeSettings,
        onProgress,
        this.displayOnly ? MAX_PREVIEW_DIMENSION : MAX_FALLBACK_DIMENSION,
        detectedShapeType,
        detectedShapeInfo,
      );
      if (generation !== this.generation) {
        throw new Error('Contour processing cancelled');
      }
      const fallbackResult = fallback;
      this.cachedContourData = fallback.contourData;
      this.lastProcessKey = processKey;
      this.lastProcessResult = fallbackResult;
      return fallbackResult;
    }

    const { canvas, scale } = downsampleImage(
      image,
      this.displayOnly ? MAX_PREVIEW_DIMENSION : MAX_PROCESSING_DIMENSION,
    );
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const dpiFromWidth = canvas.width / resizeSettings.widthInches;
    const dpiFromHeight = canvas.height / resizeSettings.heightInches;
    const effectiveDPI = Math.min(dpiFromWidth, dpiFromHeight);
    
    const scaledShapeInfo = detectedShapeInfo && scale !== 1 ? {
      type: detectedShapeInfo.type,
      boundingBox: {
        x: Math.round(detectedShapeInfo.boundingBox.x * scale),
        y: Math.round(detectedShapeInfo.boundingBox.y * scale),
        width: Math.round(detectedShapeInfo.boundingBox.width * scale),
        height: Math.round(detectedShapeInfo.boundingBox.height * scale),
      }
    } : detectedShapeInfo;
    
    const request: ProcessRequest = {
      imageData,
      strokeSettings,
      effectiveDPI: effectiveDPI,
      resizeSettings: { ...resizeSettings, outputDPI: effectiveDPI },
      // Only the independent fast display preview uses the reduced mode.
      // The authoritative contour used for export has full PDF bleed.
      previewMode: this.displayOnly,
      detectedShapeType,
      detectedShapeInfo: scaledShapeInfo,
      generation,
    };

    const result = await this.processWithOffloadFallback(request, onProgress);
    if (generation !== this.generation) {
      throw new Error('Contour processing cancelled');
    }

    const resultCanvas = document.createElement('canvas');
    resultCanvas.width = result.imageData.width;
    resultCanvas.height = result.imageData.height;
    const resultCtx = resultCanvas.getContext('2d');
    if (!resultCtx) throw new Error('Could not get result canvas context');

    resultCtx.putImageData(result.imageData, 0, 0);

    const processResult = {
      canvas: resultCanvas,
      downsampleScale: scale,
      imageCanvasX: result.imageCanvasX ?? 0,
      imageCanvasY: result.imageCanvasY ?? 0,
      contourData: result.contourData,
      detectedAlgorithm: result.detectedAlgorithm
    };
    this.lastProcessKey = processKey;
    this.lastProcessResult = processResult;
    return processResult;
  }

  // VPS tier, above the existing worker/main-thread ladder — falls straight through to the worker on any offload failure, so a flaky/unconfigured VPS never blocks tracing.
  private async processWithOffloadFallback(request: ProcessRequest, onProgress?: ProgressCallback): Promise<WorkerResult> {
    if (this.displayOnly) {
      // Preview work is deliberately local. The preview is already capped to
      // the worker's 400px limit above, so a VPS health probe plus PNG
      // encode/upload roundtrip only adds latency and can race cancellation.
      return this.processInWorker(request, onProgress);
    }

    let reportedProgress = 0;
    const reportProgress = (progress: number) => {
      reportedProgress = Math.max(reportedProgress, progress);
      onProgress?.(reportedProgress);
    };
    reportProgress(2);
    if (await offloadHealthy()) {
      if (request.generation !== this.generation) {
        throw new Error('Contour processing cancelled');
      }
      try {
        reportProgress(8);
        const result = await traceContourViaOffload(request, reportProgress);
        if (request.generation !== this.generation) {
          throw new Error('Contour processing cancelled');
        }
        reportProgress(100);
        // Mirror handleWorkerMessage's cache write (line ~267) — getCachedContourData() is read
        // later by the download/gang-sheet paths, independently of this call's own return value.
        // Without this, a trace that ran via offload leaves that cache stale or null, and a
        // download can silently embed the wrong (or no) cut path.
        if (result.contourData) {
          this.cachedContourData = result.contourData;
        }
        return result;
      } catch (err) {
        if (request.generation !== this.generation) {
          throw err;
        }
        console.warn('[ContourWorkerManager] offload failed, falling back to worker:', err);
        pauseOffloadAfterFailure();
        reportProgress(10);
      }
    }
    const monotonicWorkerProgress = (progress: number) => reportProgress(Math.max(10, progress));
    return this.processInWorker(request, monotonicWorkerProgress);
  }

  private processInWorker(request: ProcessRequest, onProgress?: ProgressCallback): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      if (request.generation !== this.generation) {
        reject(new Error('Contour processing cancelled'));
        return;
      }

      if (this.isProcessing) {
        if (this.pendingRequest) {
          this.pendingRequest.reject(new Error('Superseded by a newer contour request'));
        }
        this.pendingRequest = { request, resolve, reject, onProgress };
        onProgress?.(1);
        return;
      }

      this.isProcessing = true;
      this.currentRequest = { generation: request.generation, resolve, reject, onProgress };
      onProgress?.(5);

      this.worker!.postMessage({
        type: 'process',
        imageData: request.imageData,
        strokeSettings: request.strokeSettings,
        effectiveDPI: request.effectiveDPI,
        previewMode: request.previewMode ?? true,
        detectedShapeType: request.detectedShapeType || null,
        detectedShapeBBox: request.detectedShapeInfo?.boundingBox || null
      }, [request.imageData.data.buffer]);

      this.workerTimeout = setTimeout(() => {
        if (!this.currentRequest || this.currentRequest.generation !== this.generation) return;
        const timeoutError = new Error('Contour worker timed out and was reset');
        this.currentRequest.reject(timeoutError);
        this.pendingRequest?.reject(timeoutError);
        this.currentRequest = null;
        this.pendingRequest = null;
        this.isProcessing = false;
        this.workerTimeout = null;
        this.worker?.terminate();
        this.worker = null;
        this.workerHealthReady = this.initWorker();
      }, WORKER_TIMEOUT_MS);
    });
  }

  private async processFallback(
    image: HTMLImageElement,
    strokeSettings: {
      width: number;
      color: string;
      enabled: boolean;
      alphaThreshold: number;
      backgroundColor: string;
      useCustomBackground: boolean;
      autoBridging: boolean;
      autoBridgingThreshold: number;
      contourMode?: ContourMode;
    },
    resizeSettings: ResizeSettings,
    onProgress?: ProgressCallback,
    maxDimension = MAX_FALLBACK_DIMENSION,
    detectedShapeType?: DetectedShapeType,
    detectedShapeInfo?: DetectedShapeInfo | null,
  ): Promise<{ canvas: HTMLCanvasElement; downsampleScale: number; imageCanvasX: number; imageCanvasY: number; contourData: ContourData; detectedAlgorithm: DetectedAlgorithm }> {
    const { canvas, scale } = downsampleImage(image, maxDimension);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get fallback canvas context');

    onProgress?.(0.05);
    // Yield once so React can paint the "Processing... 0%" state and any
    // recent state updates before we hog the main thread inside the
    // synchronous trace.
    await new Promise<void>((r) => setTimeout(r, 0));

    const { processContour } = await import('./contour-trace-core');
    onProgress?.(0.15);
    const dpi = Math.min(canvas.width / resizeSettings.widthInches, canvas.height / resizeSettings.heightInches);
    const bbox = detectedShapeInfo?.boundingBox;
    const scaledBBox = bbox ? {
      x: Math.round(bbox.x * scale), y: Math.round(bbox.y * scale),
      width: Math.round(bbox.width * scale), height: Math.round(bbox.height * scale),
    } : null;
    const result = processContour(ctx.getImageData(0, 0, canvas.width, canvas.height), strokeSettings, dpi, this.displayOnly, detectedShapeType, scaledBBox);
    const output = document.createElement('canvas');
    output.width = result.imageData.width;
    output.height = result.imageData.height;
    const outputCtx = output.getContext('2d');
    if (!outputCtx) throw new Error('Could not get fallback result canvas context');
    outputCtx.putImageData(result.imageData, 0, 0);
    onProgress?.(1);
    return { canvas: output, downsampleScale: scale, imageCanvasX: result.imageCanvasX,
      imageCanvasY: result.imageCanvasY, contourData: result.contourData, detectedAlgorithm: result.detectedAlgorithm };
  }

  terminate() {
    this.generation++;
    this.clearWorkerTimeout();
    this.currentRequest?.reject(new Error('Contour worker terminated'));
    this.pendingRequest?.reject(new Error('Contour worker terminated'));
    this.currentRequest = null;
    this.pendingRequest = null;
    this.isProcessing = false;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

let managerInstance: ContourWorkerManager | null = null;
let previewManagerInstance: ContourWorkerManager | null = null;

export function getContourWorkerManager(): ContourWorkerManager {
  if (!managerInstance) {
    managerInstance = new ContourWorkerManager();
  }
  return managerInstance;
}

export function getPreviewContourWorkerManager(): ContourWorkerManager {
  if (!previewManagerInstance) {
    previewManagerInstance = new ContourWorkerManager(true);
  }
  return previewManagerInstance;
}

export async function processContourInWorker(
  image: HTMLImageElement,
  strokeSettings: {
    width: number;
    color: string;
    enabled: boolean;
    alphaThreshold: number;
    backgroundColor: string;
    useCustomBackground: boolean;
    autoBridging: boolean;
    autoBridgingThreshold: number;
    contourMode?: ContourMode;
    cornerMode?: string;
  },
  resizeSettings: ResizeSettings,
  onProgress?: ProgressCallback,
  detectedShapeType?: DetectedShapeType,
  detectedShapeInfo?: DetectedShapeInfo | null
): Promise<{ canvas: HTMLCanvasElement; downsampleScale: number; imageCanvasX: number; imageCanvasY: number; contourData?: ContourData; detectedAlgorithm?: DetectedAlgorithm }> {
  const manager = getContourWorkerManager();
  return manager.process(image, strokeSettings, resizeSettings, onProgress, detectedShapeType, detectedShapeInfo);
}

export async function processPreviewContourInWorker(
  image: HTMLImageElement,
  strokeSettings: {
    width: number;
    color: string;
    enabled: boolean;
    alphaThreshold: number;
    backgroundColor: string;
    useCustomBackground: boolean;
    autoBridging: boolean;
    autoBridgingThreshold: number;
    contourMode?: ContourMode;
    cornerMode?: string;
  },
  resizeSettings: ResizeSettings,
  onProgress?: ProgressCallback,
  detectedShapeType?: DetectedShapeType,
  detectedShapeInfo?: DetectedShapeInfo | null
): Promise<{ canvas: HTMLCanvasElement; downsampleScale: number; imageCanvasX: number; imageCanvasY: number; contourData?: ContourData; detectedAlgorithm?: DetectedAlgorithm }> {
  const manager = getPreviewContourWorkerManager();
  return manager.process(image, strokeSettings, resizeSettings, onProgress, detectedShapeType, detectedShapeInfo);
}

if (import.meta.hot) {
  import.meta.hot.accept('./contour-worker', () => {
    if (managerInstance) {
      managerInstance.recreateWorker();
    }
    if (previewManagerInstance) {
      previewManagerInstance.recreateWorker();
    }
  });
}
