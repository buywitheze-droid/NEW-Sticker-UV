const MAX_UPSCALE_EDGE = 8000;

export function resolveUpscaleScale(
  width: number,
  height: number,
  preferred: 2 | 4,
): 2 | 4 | null {
  const edge = Math.max(width, height);
  if (!(edge > 0)) return null;
  if (edge * preferred <= MAX_UPSCALE_EDGE) return preferred;
  if (preferred === 4 && edge * 2 <= MAX_UPSCALE_EDGE) return 2;
  return null;
}

function scaleRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  scale: number,
): { width: number; height: number; rgba: Uint8ClampedArray } {
  const src = document.createElement("canvas");
  src.width = width;
  src.height = height;
  const srcCtx = src.getContext("2d", { willReadFrequently: true });
  if (!srcCtx) throw new Error("Could not read pixels to upscale.");
  srcCtx.putImageData(new ImageData(data, width, height), 0, 0);

  const outW = Math.round(width * scale);
  const outH = Math.round(height * scale);
  const dest = document.createElement("canvas");
  dest.width = outW;
  dest.height = outH;
  const destCtx = dest.getContext("2d", { willReadFrequently: true });
  if (!destCtx) throw new Error("Could not write upscaled pixels.");
  destCtx.imageSmoothingEnabled = true;
  destCtx.imageSmoothingQuality = "high";
  destCtx.drawImage(src, 0, 0, outW, outH);
  const result = destCtx.getImageData(0, 0, outW, outH);
  return { width: outW, height: outH, rgba: result.data };
}

export function getUpscaleManager() {
  return {
    async upscale(
      data: Uint8ClampedArray,
      width: number,
      height: number,
      scale: 2 | 4,
      onProgress?: (progress: { completed: number; total: number }) => void,
    ) {
      onProgress?.({ completed: 0, total: 1 });
      const result = scaleRgba(data, width, height, scale);
      onProgress?.({ completed: 1, total: 1 });
      return result;
    },
  };
}
