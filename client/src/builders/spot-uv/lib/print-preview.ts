/**
 * Print vs preview helpers for the Spot UV builder.
 * Preview stays capped at 4000; print work reads `exportBlob` / vector source.
 */

import {
  applyEditAtPrintResolution,
  applyEditToPreviewSource,
  type CanvasPixelEdit,
} from "@/lib/print-source-edit";
import { encodeCanvasToPng } from "@/lib/png-encoder";
import type { ImageInfo as NestImageInfo } from "./types";
import { hasVectorPrintSource, createVectorPrintSourceResolver } from "./vector-print-source";
import type { ImageInfo } from "./types";

export const SPOT_UV_PREVIEW_MAX_EDGE = 4000;

export function asNestImageInfo(info: ImageInfo): NestImageInfo {
  return info as unknown as NestImageInfo;
}

export function drawCappedPreview(
  image: HTMLImageElement,
  box: { x: number; y: number; width: number; height: number } | null | undefined,
  maxEdge: number = SPOT_UV_PREVIEW_MAX_EDGE,
): HTMLCanvasElement {
  const srcW = box?.width ?? (image.naturalWidth || image.width);
  const srcH = box?.height ?? (image.naturalHeight || image.height);
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH, 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(srcW * scale));
  canvas.height = Math.max(1, Math.round(srcH * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (box) {
    ctx.drawImage(image, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

export async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not decode image.")); };
    img.src = url;
  });
}

export async function canvasToPngImage(canvas: HTMLCanvasElement): Promise<HTMLImageElement> {
  return blobToImage(await encodeCanvasToPng(canvas));
}

/**
 * Runs an edit against the print source when one exists, otherwise the preview.
 * Preview is recapped at 4000; `exportBlob` becomes the edited print pixels.
 */
export async function commitSpotUvEdit(
  info: ImageInfo,
  widthInches: number,
  heightInches: number,
  edit: CanvasPixelEdit,
): Promise<ImageInfo | null> {
  const nest = asNestImageInfo(info);
  let edited = await applyEditAtPrintResolution(nest, widthInches, heightInches, edit);
  if (!edited) {
    edited = await applyEditToPreviewSource(nest, SPOT_UV_PREVIEW_MAX_EDGE, edit);
  }
  if (!edited) return null;
  const previewW = edited.previewImage.naturalWidth || edited.previewImage.width;
  const previewH = edited.previewImage.naturalHeight || edited.previewImage.height;
  return {
    ...info,
    image: edited.previewImage,
    file: edited.printSourceFile,
    exportBlob: edited.exportBlob,
    exportCrop: undefined,
    exportPixelWidth: edited.sourceWidth,
    exportPixelHeight: edited.sourceHeight,
    svgSource: undefined,
    originalPdfData: undefined,
    vectorInkBox: undefined,
    dpi: edited.dpi,
    originalWidth: previewW,
    originalHeight: previewH,
  };
}

/** Scanline flood-fill erase. `nx`/`ny` are 0–1 within the canvas. */
export function eraseConnectedColorOnCanvas(
  canvas: HTMLCanvasElement,
  nx: number,
  ny: number,
  tolerance01: number,
): boolean {
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return false;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;

  const maxDiff = Math.round(tolerance01 * 255);
  const px = Math.min(Math.max(0, Math.round(nx * w)), w - 1);
  const py = Math.min(Math.max(0, Math.round(ny * h)), h - 1);
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const start = (py * w + px) * 4;
  if (data[start + 3] < 10) return false;

  const sr = data[start];
  const sg = data[start + 1];
  const sb = data[start + 2];
  const matches = (pos: number): boolean => {
    const idx = pos << 2;
    if (data[idx + 3] < 10) return false;
    const dr = data[idx] - sr;
    const dg = data[idx + 1] - sg;
    const db = data[idx + 2] - sb;
    return (dr < 0 ? -dr : dr) <= maxDiff
      && (dg < 0 ? -dg : dg) <= maxDiff
      && (db < 0 ? -db : db) <= maxDiff;
  };

  let stack = new Int32Array(1024);
  let sp = 0;
  const push = (pos: number) => {
    if (sp === stack.length) {
      const grown = new Int32Array(stack.length * 2);
      grown.set(stack);
      stack = grown;
    }
    stack[sp++] = pos;
  };
  const seedRow = (rowStart: number, from: number, to: number) => {
    let x = from;
    while (x <= to) {
      if (!matches(rowStart + x)) { x++; continue; }
      push(rowStart + x);
      while (x <= to && matches(rowStart + x)) x++;
    }
  };

  push(py * w + px);
  while (sp > 0) {
    const pos = stack[--sp];
    const y = (pos / w) | 0;
    const rowStart = y * w;
    if (!matches(pos)) continue;
    let left = pos - rowStart;
    while (left > 0 && matches(rowStart + left - 1)) left--;
    let right = pos - rowStart;
    while (right < w - 1 && matches(rowStart + right + 1)) right++;
    for (let x = left; x <= right; x++) data[((rowStart + x) << 2) + 3] = 0;
    if (y > 0) seedRow(rowStart - w, left, right);
    if (y < h - 1) seedRow(rowStart + w, left, right);
  }
  ctx.putImageData(imageData, 0, 0);
  return true;
}

/**
 * Decode print pixels at placement size. Vectors re-rasterise; rasters
 * decode `exportBlob` (with crop). Falls back to the preview image.
 */
export async function resolveSpotUvPrintImage(
  info: ImageInfo,
  widthInches: number,
  heightInches: number,
): Promise<HTMLImageElement> {
  const wantW = Math.max(1, Math.round(widthInches * 300));
  const wantH = Math.max(1, Math.round(heightInches * 300));

  if (info.exportBlob) {
    try {
      const crop = info.exportCrop;
      const orient: ImageBitmapOptions = { imageOrientation: "from-image" };
      const bmp = crop
        ? await createImageBitmap(info.exportBlob, crop.x, crop.y, crop.width, crop.height, orient)
        : await createImageBitmap(info.exportBlob, orient);
      const srcW = bmp.width;
      const srcH = bmp.height;
      const outW = Math.min(wantW, srcW);
      const outH = Math.min(wantH, srcH);
      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bmp.close();
        return info.image;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bmp, 0, 0, srcW, srcH, 0, 0, outW, outH);
      bmp.close();
      return await canvasToPngImage(canvas);
    } catch (err) {
      console.warn("[spot-uv] exportBlob decode failed, using preview", err);
    }
  }

  if (hasVectorPrintSource(info)) {
    try {
      const blob = await createVectorPrintSourceResolver().resolve(info, wantW, wantH);
      if (blob) return await blobToImage(blob);
    } catch (err) {
      console.warn("[spot-uv] vector print source failed, using preview", err);
    }
  }

  return info.image;
}
