import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await mkdir("/tmp/desktop-layout", { recursive: true });
try {
  await page.goto(process.env.TEST_BASE_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`);
  await page.locator('input[type="file"]').first().setInputFiles("tests/fixtures/overlays/Boba-UV.png");
  await page.getByTestId("designer-controls").waitFor({ timeout: 30000 });
  const shape = page.getByRole("button", { name: "Shape", exact: true });
  if (!await shape.isVisible()) {
    await page.getByRole("button", { name: "Outline Type", exact: true }).click();
  }
  await shape.click();
  if (!await page.getByRole("slider", { name: "Shape Margin", exact: true }).isVisible()) await shape.click();
  await page.getByRole("slider", { name: "Shape Margin", exact: true }).waitFor();
  await page.waitForTimeout(2500);
  for (const width of [1920, 2560, 1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1080 });
    await page.waitForTimeout(500);
    const metrics = await page.evaluate(() => {
      const rect = id => {
        const r = document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, right: r.right };
      };
      return {
        workspace: rect("designer-workspace"),
        controls: rect("designer-controls"),
        artboard: rect("designer-artboard"),
        columns: getComputedStyle(document.querySelector(".designer-control-groups")).gridTemplateColumns,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    assert.ok(metrics.overflow <= 1, `${width}: horizontal overflow ${metrics.overflow}`);
    assert.ok(metrics.workspace.width >= width - 100, `${width}: workspace not full width`);
    if (width >= 1024) {
      assert.ok(metrics.controls.width >= 339 && metrics.controls.width <= 400, `${width}: controls should be readable without dominating`);
      assert.ok(metrics.artboard.x >= metrics.controls.right, `${width}: columns overlap`);
      assert.ok(metrics.artboard.width >= 500, `${width}: artboard too small`);
    }
    if (width < 500) assert.ok(metrics.artboard.y > metrics.controls.y);
    await page.screenshot({ path: `/tmp/desktop-layout/${width}.png` });
    console.log(width, metrics);
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByRole("button", { name: "Zoom Out", exact: true }).click();
  assert.equal(await page.locator(".designer-zoom-toolbar").getByText("75%", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "Reset zoom", exact: true }).click();
  assert.equal(await page.locator(".designer-zoom-toolbar").getByText("100%", { exact: true }).count(), 1);
  // The displayed cut stays comfortably inside the preview, not edge-to-edge.
  const inset = await page.locator(".designer-preview-frame canvas").first().evaluate(canvas => {
    const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      if (data[i] > 200 && data[i+1] < 100 && data[i+2] > 180 && data[i+3] > 100) {
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    return { found: right >= 0, margin: Math.min(left, top, canvas.width-right, canvas.height-bottom) / Math.min(canvas.width, canvas.height) };
  });
  assert.ok(inset.found && inset.margin >= 0.09, `cut lacks pasteboard space: ${JSON.stringify(inset)}`);
  await page.getByRole("button", { name: "Add to Gang Sheet", exact: true }).click();
  await page.getByRole("button", { name: /View Gangsheet/ }).click();
  await page.getByRole("region", { name: "Gang sheet layers" }).waitFor();
  assert.equal(await page.getByTestId("designer-controls").isVisible(), false);
  assert.ok(await page.getByTestId("designer-artboard").isVisible());
  assert.deepEqual(errors, []);
  console.log("Responsive designer and gang sheet layout passed");
} finally {
  await browser.close();
}
