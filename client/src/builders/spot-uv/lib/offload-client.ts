// VPS offload — encodes a trace request as base64 PNG, calls the VPS over HTTP, decodes the response back into the same shape processInWorker returns, so callers can't tell the difference.
import { offloadUrl } from './offload-health';
import { apiRequest } from '@/lib/queryClient';
import type { ContourMode, ContourData, DetectedAlgorithm, DetectedShapeType, DetectedShapeInfo } from './contour-worker-manager';

const REQUEST_TIMEOUT_MS = 60_000;
const CONTOUR_REQUEST_TIMEOUT_MS = 45_000;

interface OffloadWorkerResult {
  imageData: ImageData;
  imageCanvasX?: number;
  imageCanvasY?: number;
  contourData?: ContourData;
  detectedAlgorithm?: DetectedAlgorithm;
}

let cachedToken: { token: string; expiresAtMs: number } | null = null;

// Reused until 30s before expiry so a slow trace can't have its token expire mid-flight.
async function getOffloadToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAtMs - Date.now() > 30_000) return cachedToken.token;
  const res = await apiRequest('GET', '/api/offload/token');
  const data = await res.json();
  cachedToken = { token: data.token, expiresAtMs: data.expiresAtMs };
  return cachedToken.token;
}

function imageDataToPngBase64(imageData: ImageData): string {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(imageData, 0, 0);
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

function pngBase64ToImageData(base64: string, signal?: AbortSignal): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const handleAbort = () => {
      img.src = '';
      reject(new DOMException('Offload request timed out', 'AbortError'));
    };
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener('abort', handleAbort, { once: true });
    img.onload = () => {
      signal?.removeEventListener('abort', handleAbort);
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, img.width, img.height));
    };
    img.onerror = () => {
      signal?.removeEventListener('abort', handleAbort);
      reject(new Error('offload: failed to decode returned image'));
    };
    img.src = `data:image/png;base64,${base64}`;
  });
}

export async function traceContourViaOffload(request: {
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
  previewMode?: boolean;
  detectedShapeType?: DetectedShapeType;
  detectedShapeInfo?: DetectedShapeInfo | null;
}, onProgress?: (progress: number) => void): Promise<OffloadWorkerResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTOUR_REQUEST_TIMEOUT_MS);
  let progress = 8;
  const reportProgress = (nextProgress: number) => {
    progress = Math.max(progress, nextProgress);
    onProgress?.(progress);
  };
  const progressTimer = setInterval(() => {
    if (progress < 75) reportProgress(Math.min(75, progress + 3));
  }, 1500);
  try {
    reportProgress(10);
    const token = await Promise.race([
      getOffloadToken(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Offload request timed out', 'AbortError')),
          { once: true },
        );
      }),
    ]);
    if (controller.signal.aborted) throw new DOMException('Offload request timed out', 'AbortError');

    reportProgress(15);
    const imagePng = imageDataToPngBase64(request.imageData);
    if (controller.signal.aborted) throw new DOMException('Offload request timed out', 'AbortError');

    reportProgress(20);
    const res = await fetch(`${offloadUrl()}/trace-contour?includeRaster=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        imagePng,
        strokeSettings: request.strokeSettings,
        effectiveDPI: request.effectiveDPI,
        previewMode: request.previewMode,
        detectedShapeType: request.detectedShapeType,
        detectedShapeBBox: request.detectedShapeInfo?.boundingBox,
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`offload trace-contour failed: ${res.status}`);
    reportProgress(80);
    const data = await res.json();
    if (!data.imagePng) throw new Error('offload trace-contour: no raster in response');

    reportProgress(90);
    const imageData = await pngBase64ToImageData(data.imagePng, controller.signal);
    reportProgress(95);
    return {
      imageData,
      imageCanvasX: data.imageCanvasX,
      imageCanvasY: data.imageCanvasY,
      contourData: data.contourData,
      detectedAlgorithm: data.detectedAlgorithm,
    };
  } finally {
    clearTimeout(timer);
    clearInterval(progressTimer);
  }
}

function bufferToBase64(buffer: ArrayBufferLike): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export interface OffloadSpotColorRegion {
  name: string;
  paths: { x: number; y: number }[][];
  tintCMYK: [number, number, number, number];
}

export async function traceSpotColorsViaOffload(request: {
  imageData: ImageData;
  spotColors: unknown[];
  dpi: number;
  whiteInclusionMask?: Uint8Array;
  glossInclusionMask?: Uint8Array;
  fullAlphaMask?: Uint8Array;
  allTaggedWhite?: boolean;
  allTaggedGloss?: boolean;
  exactSelection?: boolean;
}): Promise<OffloadSpotColorRegion[]> {
  const token = await getOffloadToken();
  const imagePng = imageDataToPngBase64(request.imageData);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${offloadUrl()}/trace-spot-colors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        imagePng,
        spotColors: request.spotColors,
        dpi: request.dpi,
        whiteInclusionMask: request.whiteInclusionMask ? bufferToBase64(request.whiteInclusionMask.buffer) : undefined,
        glossInclusionMask: request.glossInclusionMask ? bufferToBase64(request.glossInclusionMask.buffer) : undefined,
        fullAlphaMask: request.fullAlphaMask ? bufferToBase64(request.fullAlphaMask.buffer) : undefined,
        allTaggedWhite: request.allTaggedWhite,
        allTaggedGloss: request.allTaggedGloss,
        exactSelection: request.exactSelection,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`offload trace-spot-colors failed: ${res.status}`);
  const data = await res.json();
  return data.regions ?? [];
}
