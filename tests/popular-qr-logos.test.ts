import assert from "node:assert/strict";
import test from "node:test";

import "../vps/src/canvas-shim.ts";
import { createCanvas } from "@napi-rs/canvas";
import {
  detectPopularQRLogo,
  POPULAR_QR_LOGOS,
  renderPopularQRLogo,
} from "../client/src/builders/spot-uv/lib/popular-qr-logos";

function installDocumentShim(): void {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement(tagName: string) {
        if (tagName === "canvas") return createCanvas(1, 1);
        throw new Error(`Unsupported test element: ${tagName}`);
      },
    },
  });
}

installDocumentShim();

const qrRegion = { x: 16, y: 16, width: 224, height: 224 };

function blankSource() {
  return createCanvas(256, 256) as unknown as HTMLCanvasElement;
}

test("exposes the four curated assets and renders fitted badges", () => {
  assert.deepEqual(
    POPULAR_QR_LOGOS.map((logo) => logo.id),
    ["instagram", "facebook", "whatsapp", "youtube"],
  );
  const canvas = blankSource();
  const context = canvas.getContext("2d");
  renderPopularQRLogo(context as unknown as CanvasRenderingContext2D, "instagram", {
    x: 40, y: 60, width: 100, height: 60,
  });
  const pixels = context.getImageData(40, 60, 100, 60).data;
  assert.ok([...pixels].some((value, index) => index % 4 === 3 && value > 0));
  assert.deepEqual([...context.getImageData(0, 0, 1, 1).data], [0, 0, 0, 0]);
});

test("matches exact center and modestly degraded corner badges", async () => {
  const center = blankSource();
  renderPopularQRLogo(
    center.getContext("2d") as unknown as CanvasRenderingContext2D,
    "instagram",
    { x: 88, y: 88, width: 80, height: 80 },
  );
  const centerMatch = await detectPopularQRLogo(center, qrRegion);
  assert.equal(centerMatch.status, "matched");
  if (centerMatch.status === "matched") {
    assert.equal(centerMatch.brand, "instagram");
    assert.ok(centerMatch.confidence >= 0.8);
    assert.ok(centerMatch.region.x >= 0);
    assert.ok(centerMatch.region.y >= 0);
    assert.ok(centerMatch.region.x + centerMatch.region.width <= 1);
    assert.ok(centerMatch.region.y + centerMatch.region.height <= 1);
  }

  const corner = blankSource();
  const cornerContext = corner.getContext("2d");
  renderPopularQRLogo(
    cornerContext as unknown as CanvasRenderingContext2D,
    "youtube",
    { x: 20, y: 20, width: 66, height: 66 },
  );
  cornerContext.globalAlpha = 0.9;
  cornerContext.fillStyle = "#ffffff";
  cornerContext.fillRect(20, 20, 66, 3);
  cornerContext.globalAlpha = 1;
  const cornerMatch = await detectPopularQRLogo(corner, qrRegion);
  assert.equal(cornerMatch.status, "matched");
  if (cornerMatch.status === "matched") assert.equal(cornerMatch.brand, "youtube");
});

test("recognizes each supported brand with normalized source-relative bounds", async () => {
  for (const logo of POPULAR_QR_LOGOS) {
    const source = blankSource();
    renderPopularQRLogo(source.getContext("2d") as unknown as CanvasRenderingContext2D,
      logo.id, { x: 88, y: 88, width: 80, height: 80 });
    const match = await detectPopularQRLogo(source, qrRegion);
    assert.equal(match.status, "matched", `${logo.id} was not recognized`);
    if (match.status !== "matched") continue;
    assert.equal(match.brand, logo.id);
    // White padding is indistinguishable from the source background. The
    // detector may tighten that padding (not the glyph), especially YouTube.
    assert.ok(match.region.x >= 0 && match.region.y >= 0 &&
      match.region.x + match.region.width <= 1 &&
      match.region.y + match.region.height <= 1);
    assert.ok(Math.abs(match.region.x + match.region.width / 2 - 0.5) <= 4 / 224);
    assert.ok(Math.abs(match.region.y + match.region.height / 2 - 0.5) <= 4 / 224);
    const rgb = [1, 3, 5].map((offset) => parseInt(logo.color.slice(offset, offset + 2), 16));
    const pixels = source.getContext("2d")!.getImageData(0, 0, 256, 256).data;
    const left = 16 + match.region.x * 224;
    const top = 16 + match.region.y * 224;
    const right = left + match.region.width * 224;
    const bottom = top + match.region.height * 224;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] < 240 || !rgb.every((value, channel) => Math.abs(pixels[offset + channel] - value) < 15)) continue;
      const x = (offset / 4) % 256;
      const y = Math.floor(offset / 4 / 256);
      assert.ok(x >= left - 1 && x < right + 1 && y >= top - 1 && y < bottom + 1,
        `${logo.id} detected region clipped its visible glyph`);
    }
    if (logo.id !== "youtube") {
      for (const [field, expected] of Object.entries({ x: 72 / 224, y: 72 / 224, width: 80 / 224, height: 80 / 224 })) {
        assert.ok(Math.abs(match.region[field as keyof typeof match.region] - expected) <= 2 / 224,
          `${logo.id} returned incorrect normalized ${field}`);
      }
    }
  }
});

test("rejects plain QR-like pixels, blank art, and a mismatched template", async () => {
  const plain = blankSource();
  const plainContext = plain.getContext("2d");
  for (let y = qrRegion.y; y < qrRegion.y + qrRegion.height; y += 8) {
    for (let x = qrRegion.x; x < qrRegion.x + qrRegion.width; x += 8) {
      if ((x / 8 + y / 8) % 3 === 0) {
        plainContext.fillStyle = "#000000";
        plainContext.fillRect(x, y, 8, 8);
      }
    }
  }
  const plainMatch = await detectPopularQRLogo(plain, qrRegion);
  assert.equal(plainMatch.status, "none");

  const colouredArt = blankSource();
  const artContext = colouredArt.getContext("2d");
  artContext.fillStyle = "#E4405F";
  artContext.fillRect(86, 86, 84, 84);
  const artMatch = await detectPopularQRLogo(colouredArt, qrRegion);
  assert.notEqual(artMatch.status, "matched");

  const mismatched = blankSource();
  renderPopularQRLogo(
    mismatched.getContext("2d") as unknown as CanvasRenderingContext2D,
    "facebook",
    { x: 88, y: 88, width: 80, height: 80 },
  );
  const mismatchResult = await detectPopularQRLogo(mismatched, qrRegion, {
    x: 72 / 224, y: 72 / 224, width: 80 / 224, height: 80 / 224,
  });
  assert.equal(mismatchResult.status, "matched");
  if (mismatchResult.status === "matched") assert.equal(mismatchResult.brand, "facebook");
});

test("returns an explicit uncertain result for invalid bounds", async () => {
  const canvas = blankSource();
  const invalid = await detectPopularQRLogo(canvas, {
    x: -1, y: 0, width: 32, height: 32,
  });
  assert.equal(invalid.status, "uncertain");
  const invalidSelection = await detectPopularQRLogo(canvas, qrRegion, {
    x: 0.9, y: 0, width: 0.2, height: 0.1,
  });
  assert.equal(invalidSelection.status, "uncertain");
});
