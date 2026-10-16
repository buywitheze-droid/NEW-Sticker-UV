import { PDFDocument } from "pdf-lib";
import { cutContourMetadata } from "@/lib/pdf-name";
import { encodeCanvasToPng } from "@/lib/png-encoder";
import { resolveSpotUvPrintImage } from "./print-preview";
import type { ImageInfo, ResizeSettings } from "./types";
import type { ImportedVectorOverlay } from "./imported-overlay";
import type { SpotColorInput } from "./contour-outline";
import type { SpotPixelMapData } from "./spot-color-vectors";
import { addSpotColorVectorsToPDF } from "./spot-color-vectors";
import {
  customCutOverlays,
  customSpotOverlays,
  emitImportedSpotOverlays,
  emitOverlayOnPage,
  filterTracedSpotColors,
  overlayExportSubject,
  overlayPageUnion,
} from "./overlay-export";

export async function downloadImportedOverlayPDF(opts: {
  image: HTMLImageElement;
  imageInfo?: ImageInfo;
  resizeSettings: Pick<ResizeSettings, "widthInches" | "heightInches">;
  overlays: ImportedVectorOverlay[];
  filename: string;
  backgroundColor?: string;
  singleArtboard?: boolean;
  cutContourLabel?: string;
  spotColors?: SpotColorInput[];
  spotPixelMap?: SpotPixelMapData;
}): Promise<void> {
  const print = {
    widthInches: opts.resizeSettings.widthInches,
    heightInches: opts.resizeSettings.heightInches,
  };
  const visible = (opts.overlays ?? []).filter((overlay) => overlay.visible);
  const page = overlayPageUnion(print, visible, 0.05);
  const widthPts = page.widthInches * 72;
  const heightPts = page.heightInches * 72;

  const pdfDoc = await PDFDocument.create();
  const pdfPage = pdfDoc.addPage([widthPts, heightPts]);

  const fill = opts.backgroundColor
    && opts.backgroundColor !== "transparent"
    && opts.backgroundColor !== "holographic"
    ? opts.backgroundColor
    : null;
  if (fill) {
    const { rgb } = await import("pdf-lib");
    const hex = fill.replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    pdfPage.drawRectangle({
      x: 0,
      y: 0,
      width: widthPts,
      height: heightPts,
      color: rgb(
        Number.isFinite(r) ? r : 1,
        Number.isFinite(g) ? g : 1,
        Number.isFinite(b) ? b : 1,
      ),
    });
  }

  const printImage = opts.imageInfo
    ? await resolveSpotUvPrintImage(opts.imageInfo, print.widthInches, print.heightInches)
    : opts.image;
  const canvas = document.createElement("canvas");
  canvas.width = printImage.width;
  canvas.height = printImage.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to create print canvas");
  ctx.drawImage(printImage, 0, 0);
  const png = await pdfDoc.embedPng(new Uint8Array(await (await encodeCanvasToPng(canvas)).arrayBuffer()));
  pdfPage.drawImage(png, {
    x: page.imageOffsetX * 72,
    y: (page.heightInches - page.imageOffsetY - print.heightInches) * 72,
    width: print.widthInches * 72,
    height: print.heightInches * 72,
  });

  const cuts = customCutOverlays(visible);
  for (const cut of cuts) {
    emitOverlayOnPage(
      pdfDoc,
      pdfPage,
      { ...cut, label: cut.label || opts.cutContourLabel || "CutContour" },
      print,
      page.heightInches,
      page.imageOffsetX,
      page.imageOffsetY,
      "stroke",
    );
  }

  emitImportedSpotOverlays(
    pdfDoc,
    pdfPage,
    visible,
    print,
    page.heightInches,
    page.imageOffsetX,
    page.imageOffsetY,
    !!opts.singleArtboard,
    widthPts,
    heightPts,
  );

  const traced = filterTracedSpotColors(opts.spotColors, visible);
  if (traced && traced.length > 0) {
    await addSpotColorVectorsToPDF(
      pdfDoc,
      pdfPage,
      printImage,
      traced,
      print.widthInches,
      print.heightInches,
      page.heightInches,
      page.imageOffsetX,
      page.imageOffsetY,
      !!opts.singleArtboard,
      widthPts,
      heightPts,
      opts.spotPixelMap,
    );
  }

  const whiteName = customSpotOverlays(visible).find((overlay) => overlay.role === "spotWhite")?.label
    || traced?.find((color) => color.spotWhite)?.spotWhiteName
    || "RDG_WHITE";
  const glossName = customSpotOverlays(visible).find((overlay) => overlay.role === "spotGloss")?.label
    || traced?.find((color) => color.spotGloss)?.spotGlossName
    || "RDG_GLOSS";
  const cutLabels = cuts.map((cut) => cut.label || opts.cutContourLabel || "CutContour");
  const cutLabel = cutLabels[0] || opts.cutContourLabel || "CutContour";
  pdfDoc.setTitle("Sticker with uploaded cutline and spot vectors");
  pdfDoc.setSubject(overlayExportSubject(cutLabel, whiteName, glossName, !!opts.singleArtboard));
  pdfDoc.setKeywords([
    ...cutLabels,
    whiteName,
    glossName,
    "spot color",
    "cutting",
    "vector",
    cutContourMetadata(cutLabels.length ? cutLabels : [cutLabel]),
  ]);

  const bytes = await pdfDoc.save();
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = opts.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
