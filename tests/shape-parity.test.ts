import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { createServer } from "vite";
import "../vps/src/canvas-shim.ts";

const pdfBlobs = new Map<string, Blob>();
let lastDownload: Blob | undefined;
let nextUrl = 0;
Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  value: (blob: Blob) => {
    const url = `blob:shape-test-${nextUrl++}`;
    pdfBlobs.set(url, blob);
    return url;
  },
});
Object.defineProperty(URL, "revokeObjectURL", {
  configurable: true,
  value: (url: string) => { pdfBlobs.delete(url); },
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { createElement: (tag: string) => {
    if (tag === "canvas") return createCanvas(1, 1);
    if (tag === "a") return { href: "", download: "", click() {
      lastDownload = pdfBlobs.get(this.href);
    } };
    throw new Error(`Unexpected element ${tag}`);
  }, body: { appendChild() {}, removeChild() {} } },
});

const vite = await createServer({
  configFile: "./vite.config.ts",
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
});
test.after(async () => { await vite.close(); });
const modules = await Promise.all([
  vite.ssrLoadModule("/src/lib/shape-outline.ts"),
  vite.ssrLoadModule("/src/builders/spot-uv/lib/shape-outline.ts"),
]);
const gangs = await Promise.all([
  vite.ssrLoadModule("/src/lib/gang-sheet.ts"),
  vite.ssrLoadModule("/src/builders/spot-uv/lib/gang-sheet.ts"),
]);

const shapes = ["circle", "oval", "square", "rectangle", "rounded-square", "rounded-rectangle"];
const resize = { widthInches: 1.4, heightInches: 0.8 };
const settings = (type: string) => ({
  enabled: true, type, offset: 0.15, fillColor: "#ffffff",
  strokeEnabled: false, strokeColor: "#000000", strokeWidth: 1,
  bleedEnabled: true, bleedColor: "#ff0000", cornerRadius: 0.3,
  shapeWidthOverride: 2.2, shapeHeightOverride: 1.6,
  imageScale: 1.35, imageOffsetX: 0.16, imageOffsetY: -0.08, rotation: 27,
});
const artwork = createCanvas(80, 60);
const artCtx = artwork.getContext("2d");
artCtx.fillStyle = "#0011ee";
artCtx.fillRect(0, 0, 80, 60);

function content(pdf: PDFDocument) {
  const page = pdf.getPage(0);
  const entries = page.node.Contents();
  assert.ok(entries);
  return (entries instanceof PDFArray ? entries.asArray() : [entries]).map(ref => {
    const stream = pdf.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) return "";
    const raw = stream.getContents();
    return (stream.dict.get(PDFName.of("Filter"))?.toString() === "/FlateDecode"
      ? inflateSync(raw) : Buffer.from(raw)).toString("latin1");
  }).join("\n");
}

for (const module of modules) {
  test('negative shape margins shrink cut dimensions safely and survive PDF export', async () => {
    for (const type of shapes) {
      const shape = { ...settings(type), rotation: 0, offset: -0.15,
        shapeWidthOverride: 0, shapeHeightOverride: 0 };
      const zero = module.calculateShapeDimensions(resize.widthInches, resize.heightInches, type, 0);
      const dims = module.resolveShapeDimensions(shape, resize);
      assert.ok(dims.widthInches < zero.widthInches && dims.heightInches < zero.heightInches);
      const minimum = module.getMinimumShapeOffset(resize.widthInches, resize.heightInches, type);
      const smallest = module.calculateShapeDimensions(resize.widthInches, resize.heightInches, type, minimum - 10);
      assert.ok(smallest.widthInches >= 0.049 && smallest.heightInches >= 0.049);
      const data = await module.generateShapePDFBase64(artwork, shape, resize);
      const pdf = await PDFDocument.load(Buffer.from(data, 'base64'));
      assert.ok(Math.abs(pdf.getPage(0).getWidth() / 72 - dims.widthInches - 0.2) < 1e-6);
      assert.ok(Math.abs(pdf.getPage(0).getHeight() / 72 - dims.heightInches - 0.2) < 1e-6);
    }
  });
  for (const type of shapes) {
    test(`${module === modules[0] ? "active" : "builder"} ${type}: resolved cut geometry, raster, PDF and base64 agree`, async () => {
      const shape = settings(type);
      const dims = module.resolveShapeDimensions(shape, resize);
      assert.deepEqual(dims, { widthInches: 2.2, heightInches: 1.6 });
      const points = module.generateShapePathPointsInches(shape, resize);
      assert.ok(Math.abs(points.widthInches - 2.4) < 1e-9);
      assert.ok(Math.abs(points.heightInches - 1.8) < 1e-9);
      assert.ok(Math.abs(points.imageOffsetX - ((2.4 - resize.widthInches * 1.35) / 2 + 0.16)) < 1e-9);
      assert.ok(Math.abs(points.imageOffsetY - ((1.8 - resize.heightInches * 1.35) / 2 - 0.08)) < 1e-9);
      assert.ok(points.pathPoints.length >= 4);

      const raster = createCanvas(440, 320);
      const ctx = raster.getContext("2d");
      ctx.translate(220, 160);
      ctx.rotate(shape.rotation * Math.PI / 180);
      ctx.translate(-220, -160);
      module.traceShapeCanvasPath(ctx, type, 0, 0, 440, 320, 60);
      ctx.fillStyle = "#ff0000";
      ctx.fill();
      ctx.clip();
      ctx.drawImage(artwork, 80, 55, 280, 210);
      const alpha = ctx.getImageData(220, 160, 1, 1).data[3];
      assert.equal(alpha, 255);
      if (["circle", "oval", "rounded-square", "rounded-rectangle"].includes(type)) {
        assert.equal(ctx.getImageData(0, 0, 1, 1).data[3], 0);
      }

      const base64 = await module.generateShapePDFBase64(artwork, shape, resize, "Custom Cut");
      const pdf = await PDFDocument.load(Buffer.from(base64, "base64"));
      assert.ok(Math.abs(pdf.getPage(0).getWidth() - 2.4 * 72) < 1e-9);
      assert.ok(Math.abs(pdf.getPage(0).getHeight() - 1.8 * 72) < 1e-9);
      const ops = content(pdf);
      assert.match(ops, /\/Custom#20Cut CS 1 SCN/);
      assert.match(ops, /\bDo\b/);
      assert.match(ops, /cm/);
      if (type.startsWith("rounded")) assert.match(ops, / c\n/);
      for (const singleArtboard of [true, false]) {
        lastDownload = undefined;
        await module.downloadShapePDF(artwork, shape, resize, `${type}.pdf`,
          undefined, singleArtboard, "Custom Cut");
        assert.ok(lastDownload);
        const downloaded = await PDFDocument.load(await lastDownload.arrayBuffer());
        assert.equal(downloaded.getPage(0).getWidth(), pdf.getPage(0).getWidth());
        assert.equal(downloaded.getPage(0).getHeight(), pdf.getPage(0).getHeight());
        assert.equal(content(downloaded), ops);
      }
    });
  }
}

for (let m = 0; m < modules.length; m++) {
  test(`${m === 0 ? "active" : "builder"} gang PDF places scaled, offset shapes at both item rotations`, async () => {
    for (const type of shapes) {
      for (const margin of [0.15, -0.2]) {
      const shape = { ...settings(type), offset: margin,
        ...(margin < 0 ? { shapeWidthOverride: 0, shapeHeightOverride: 0 } : {}) };
      const contour = modules[m].generateShapePathPointsInches(shape, resize);
      const item = {
        id: `shape-${type}`, imageElement: artwork, thumbnail: "", quantity: 1,
        shapeSettings: shape, resizeSettings: resize, cutContourLabel: "My Cut",
        contourData: { ...contour, backgroundColor: "#ffffff", minPathX: 0, minPathY: 0, effectiveDPI: 300 },
        strokeSettings: { enabled: false, width: 0, color: "#000000" },
      };
      const placement = { itemId: item.id, instanceIndex: 0, x: 3, y: 2,
        width: contour.widthInches, height: contour.heightInches };
      for (const rotated of [false, true]) {
        for (const singleArtboard of [false, true]) {
        const copies = [placement, { ...placement, instanceIndex: 1, x: 0.2, y: 0.2 }];
        const blob = await gangs[m].downloadGangSheetPDF([item],
          { sheetWidth: 8, sheetHeight: 8, gap: 0, edgePadding: 0 },
          copies.map(copy => ({ ...copy, rotated })), singleArtboard);
        const pdf = await PDFDocument.load(await blob.arrayBuffer());
        const ops = content(pdf);
        assert.match(ops, /\/My#20Cut CS 1 SCN/);
        const imageW = resize.widthInches * shape.imageScale;
        const imageH = resize.heightInches * shape.imageScale;
        const expectedX = (placement.x + (rotated ? contour.imageOffsetY : contour.imageOffsetX)) * 72;
        const expectedTop = rotated
          ? placement.y + contour.widthInches - contour.imageOffsetX - imageW
          : placement.y + contour.imageOffsetY;
        const expectedY = (8 - expectedTop - (rotated ? imageW : imageH)) * 72;
        // The PDF image CTM must agree with the contour's quarter-turn affine,
        // including an asymmetric image offset (not just the centered case).
        const imageMatrices = [...ops.matchAll(/([\d.-]+) 0 0 ([\d.-]+) ([\d.-]+) ([\d.-]+) cm\n\/Img_/g)];
        {
          assert.ok(imageMatrices.some(match =>
            Math.abs(Number(match[1]) - (rotated ? imageH : imageW) * 72) < 1e-6 &&
            Math.abs(Number(match[2]) - (rotated ? imageW : imageH) * 72) < 1e-6 &&
            Math.abs(Number(match[3]) - expectedX) < 1e-6 &&
            Math.abs(Number(match[4]) - expectedY) < 1e-6),
          `${type} rotated=${rotated}: image CTM does not match the cut geometry`);
        }
        assert.equal((ops.match(/W n/g) || []).length, 2, `${type}: each copy must clip artwork`);
        assert.equal((ops.match(/\/My#20Cut CS 1 SCN/g) || []).length, 2, `${type}: each copy needs a cut path`);
        for (const copy of copies) {
          const expected = contour.pathPoints.map((p: { x: number; y: number }, i: number) => {
            const x = copy.x + (rotated ? p.y : p.x);
            const y = 8 - copy.y - (rotated ? contour.widthInches - p.x : p.y);
            return `${(x * 72).toFixed(4)} ${(y * 72).toFixed(4)} ${i === 0 ? 'm' : 'l'}`;
          }).join('\n');
          assert.ok(ops.includes(expected), `${type} ${margin} rotated=${rotated}: copy cut vertices changed`);
        }
        if (m === 1) {
          const rect = gangs[m].getGangSheetImageRectInches(item, { ...placement, rotated });
          assert.ok(Math.abs(rect.x * 72 - expectedX) < 1e-6);
          assert.ok(Math.abs(rect.y - expectedTop) < 1e-6);
        }
        }
      }
      }
    }
  });
}