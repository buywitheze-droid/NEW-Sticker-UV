// previewDims already includes device pixel ratio. Keep logical geometry
// unchanged and increase only the display bitmap, never print/export sources.
export function gangSheetPreviewResolution(width: number, height: number, zoom: number) {
  const quality = Math.max(2, Math.min(5, zoom));
  const scale = Math.min(
    quality,
    8192 / Math.max(width, height),
    Math.sqrt(16_000_000 / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}