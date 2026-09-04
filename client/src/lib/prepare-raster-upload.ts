/**
 * Local raster import for AnyContour (no /api/prepare-raster-upload).
 * Copies file bytes so export does not depend on the original disk path.
 */

export interface SourceCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreparedRaster {
  previewImage: HTMLImageElement;
  previewFile: File;
  sourceBlob: Blob;
  sourceCrop: SourceCrop;
  sourceWidth: number;
  sourceHeight: number;
  dpi: number;
  sourceMegapixels: number;
  binaryAlpha: boolean;
  hasTransparency: boolean;
}

export type RejectReason = "too_many_pixels" | "file_too_large" | "unreadable_dimensions";

const MAX_SOURCE_MEGAPIXELS = 200;
const MAX_SOURCE_FILE_BYTES = 80 * 1024 * 1024;

export async function ownUploadedBytes(file: File): Promise<Blob> {
  const bytes = await file.arrayBuffer();
  return new Blob([bytes], { type: file.type || "application/octet-stream" });
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image"));
    };
    img.src = url;
  });
}

export function describeBudgetRejection(
  reason: RejectReason,
  megapixels: number,
  fileSize?: number,
): { sizeLabel: string; maxLabel: string } {
  if (reason === "file_too_large") {
    return {
      sizeLabel: `${((fileSize ?? 0) / (1024 * 1024)).toFixed(1)} MB`,
      maxLabel: `${Math.round(MAX_SOURCE_FILE_BYTES / (1024 * 1024))} MB`,
    };
  }
  if (reason === "too_many_pixels") {
    return {
      sizeLabel: `${megapixels.toFixed(1)} MP`,
      maxLabel: `${MAX_SOURCE_MEGAPIXELS} MP`,
    };
  }
  return { sizeLabel: "unknown", maxLabel: `${MAX_SOURCE_MEGAPIXELS} MP` };
}

export async function importRasterForEditor(
  file: File,
  handlers: {
    onPrepared: (prepared: PreparedRaster) => void | Promise<void>;
    onInline: (file: File, image: HTMLImageElement) => void | Promise<void>;
    onReject: (reason: RejectReason, megapixels: number) => void;
    onPrepareError?: (error: unknown) => void;
  },
): Promise<void> {
  if (file.size > MAX_SOURCE_FILE_BYTES) {
    handlers.onReject("file_too_large", 0);
    return;
  }

  try {
    const sourceBlob = await ownUploadedBytes(file);
    const image = await loadImageFromBlob(sourceBlob);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const megapixels = (width * height) / 1_000_000;
    if (megapixels > MAX_SOURCE_MEGAPIXELS) {
      handlers.onReject("too_many_pixels", megapixels);
      return;
    }
    await handlers.onPrepared({
      previewImage: image,
      previewFile: file,
      sourceBlob,
      sourceCrop: { x: 0, y: 0, width, height },
      sourceWidth: width,
      sourceHeight: height,
      dpi: 300,
      sourceMegapixels: megapixels,
      binaryAlpha: false,
      hasTransparency: false,
    });
  } catch (err) {
    handlers.onPrepareError?.(err);
    throw err;
  }
}
