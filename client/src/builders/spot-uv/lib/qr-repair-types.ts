export type QRRepairSource = HTMLImageElement | HTMLCanvasElement;
export type QRRepairRegion = { x: number; y: number; width: number; height: number };
export type QRErrorCorrection = "L" | "M" | "Q" | "H";

export interface QRRepairOptions {
  payload: string;
  dark: string;
  light: string;
  errorCorrectionLevel: QRErrorCorrection;
  quietZone: number;
  preserveLogo: boolean;
  /** Center-logo crop as a fraction of the shorter source-region dimension. */
  logoScale: number;
}

export interface QRRepairDraft {
  id: string;
  region: QRRepairRegion;
  options: QRRepairOptions;
  /** Original decoded content; undefined for manually identified regions. */
  originalPayload?: string;
}

export interface QRRepairResult {
  draft: QRRepairDraft;
  canvas: HTMLCanvasElement;
  verified: boolean;
  decodedPayload: string | null;
  contrastRatio: number;
  moduleCount: number;
  pixelsPerModule: number;
  warnings: string[];
}