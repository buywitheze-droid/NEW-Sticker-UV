import type { QRRepairDraft } from "./qr-repair-types";

/** Map both edges together so adjacent source regions stay adjacent in print pixels. */
export function scaleQRRepairDrafts(
  drafts: QRRepairDraft[],
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): QRRepairDraft[] {
  if (![sourceWidth, sourceHeight, targetWidth, targetHeight].every(n => Number.isFinite(n) && n > 0)) {
    throw new Error("QR artwork dimensions are invalid.");
  }
  return drafts.map(draft => {
    const r = draft.region;
    if (![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
        r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 ||
        r.x + r.width > sourceWidth || r.y + r.height > sourceHeight) {
      throw new Error("The QR region is outside the artwork.");
    }
    const x = Math.round(r.x * targetWidth / sourceWidth);
    const y = Math.round(r.y * targetHeight / sourceHeight);
    const right = Math.min(targetWidth, Math.round((r.x + r.width) * targetWidth / sourceWidth));
    const bottom = Math.min(targetHeight, Math.round((r.y + r.height) * targetHeight / sourceHeight));
    if (right <= x || bottom <= y) throw new Error("The QR region is too small at the output size.");
    return { ...draft, region: { x, y, width: right - x, height: bottom - y }, options: { ...draft.options } };
  });
}