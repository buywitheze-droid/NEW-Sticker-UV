import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,args:["--no-sandbox"]});
const page = await browser.newPage();
const errors = [];
page.on("console", m => console.log(m.type(),m.text()));
page.on("pageerror", e => errors.push(e.message));
try {
await page.goto(`https://${process.env.REPLIT_DEV_DOMAIN}`);
await page.locator('input[type=file]').first().setInputFiles("attached_assets/HootzDecalFinal_1791307163714.png");
await page.getByRole("button",{name:"Outline Type",exact:true}).waitFor();
const contour = page.getByRole("button",{name:"Contour",exact:true});
if (!await contour.isVisible()) await page.getByRole("button",{name:"Outline Type",exact:true}).click();
await contour.click();
const start = Date.now();
await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some(canvas => {
  if (!canvas.getClientRects().length || canvas.width < 100) return false;
  const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  let magenta=0;
  for(let i=0;i<pixels.length;i+=4) if(pixels[i]>185 && pixels[i+1]<85 && pixels[i+2]>185 && pixels[i+3]>150) magenta++;
  return magenta>100;
}),{},{timeout:60000});
console.log("OUTLINE READY in",Date.now()-start,"ms");
const pending=page.waitForEvent("download",{timeout:60000});
await page.getByRole("button",{name:"Download PDF",exact:true}).first().click();
const download=await pending;
const pdf=await PDFDocument.load(await readFile(await download.path()));
assert.ok(pdf.getPageCount()>0);
console.log("PDF downloaded",pdf.getPage(0).getSize());
console.log("UI",await page.locator("body").innerText());
await page.screenshot({path:"/tmp/hootz.png"});
assert.deepEqual(errors, []);
} finally {
await browser.close();
}
