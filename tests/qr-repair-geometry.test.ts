import { test } from "node:test";
import assert from "node:assert/strict";
import { scaleQRRepairDrafts } from "../client/src/builders/spot-uv/lib/qr-repair-geometry";
import type { QRRepairDraft } from "../client/src/builders/spot-uv/lib/qr-repair-types";

const draft: QRRepairDraft = {
  id: "qr",
  region: { x: 113, y: 57, width: 201, height: 201 },
  originalPayload: "https://example.com",
  options: { payload: "https://example.com", dark: "#123456", light: "#ffffff",
    errorCorrectionLevel: "H", quietZone: 4, preserveLogo: false, logoScale: 0.18,
    logoRegion: { x: 0.2, y: 0.15, width: 0.3, height: 0.2 } },
};

test("QR print mapping rounds edges without changing source settings or payload", () => {
  const before = JSON.stringify(draft);
  const [mapped] = scaleQRRepairDrafts([draft], 1000, 700, 900, 630);
  assert.deepEqual(mapped.region, { x: 102, y: 51, width: 181, height: 181 });
  assert.equal(mapped.originalPayload, draft.originalPayload);
  assert.deepEqual(mapped.options.logoRegion, draft.options.logoRegion);
  assert.equal(JSON.stringify(draft), before);
});

test("adjacent QR regions do not overlap after non-integer print scaling", () => {
  const second = { ...draft, id: "second", region: { ...draft.region, x: 314 } };
  const [a, b] = scaleQRRepairDrafts([draft, second], 1000, 700, 873, 611);
  assert.equal(a.region.x + a.region.width, b.region.x);
});

test("QR print mapping rejects out-of-image and vanishing regions", () => {
  assert.throws(() => scaleQRRepairDrafts([draft], 100, 100, 90, 90), /outside/);
  assert.throws(() => scaleQRRepairDrafts([draft], 1000, 700, 1, 1), /small/);
  assert.throws(() => scaleQRRepairDrafts([draft], 0, 700, 900, 630), /invalid/);
});