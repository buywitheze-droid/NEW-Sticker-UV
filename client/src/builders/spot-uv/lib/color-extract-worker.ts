import { extractColorsFromImageData } from './color-extractor';

interface ColorExtractRequest {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  maxColors: number;
}

function imageDataFromBuffer(buffer: ArrayBuffer, width: number, height: number): ImageData {
  const expected = width * height * 4;
  const src = new Uint8ClampedArray(buffer);
  const pixels = new Uint8ClampedArray(expected);
  pixels.set(src.subarray(0, Math.min(src.length, expected)));
  return new ImageData(pixels, width, height);
}

self.onmessage = (e: MessageEvent<ColorExtractRequest>) => {
  const { buffer, width, height, maxColors } = e.data;
  const imageData = imageDataFromBuffer(buffer, width, height);
  const result = extractColorsFromImageData(imageData, maxColors);
  (self as DedicatedWorkerGlobalScope).postMessage(
    {
      colors: result.colors,
      pixelMap: result.pixelMap,
      width: result.width,
      height: result.height,
    },
    [result.pixelMap.buffer],
  );
};
