import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { readFile, mkdir } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
const canvas=createCanvas(300,200),ctx=canvas.getContext('2d');
ctx.fillStyle='#ff8800';ctx.fillRect(30,30,220,140);
const fixtures=[
  'attached_assets/HootzDecalFinal_1791307163714.png',
  {name:'simple.png',mimeType:'image/png',buffer:canvas.toBuffer('image/png')},
];
try {
  for (const [index,fixture] of fixtures.entries()) {
    const page=await browser.newPage({acceptDownloads:true});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`https://${process.env.REPLIT_DEV_DOMAIN}`);
    await page.locator('input[type=file]').first().setInputFiles(fixture);
    await page.getByRole('button',{name:'Outline Type',exact:true}).waitFor();
    const contour=page.getByRole('button',{name:'Contour',exact:true});
    if(!await contour.isVisible()) await page.getByRole('button',{name:'Outline Type',exact:true}).click();
    await contour.click();
    const margin=page.getByRole('combobox',{name:'Contour Margin',exact:true});
    // Select a formerly forbidden small margin before detection settles.
    for(const label of ['Small — 0.02″','Medium — 0.04″','Zero Hero — 0″','Large — 0.07″','Extra Large — 0.14″','Huge — 0.25″']) {
      await margin.click();
      assert.equal(await page.getByRole('option').count(),6);
      await page.getByRole('option',{name:label,exact:true}).click();
      await page.waitForTimeout(600);
      await page.waitForFunction(()=>![...document.querySelectorAll('p')].some(p=>p.textContent?.includes('Processing...')),null,{timeout:60000});
      assert.equal(await margin.innerText(),label,'detection must not change the selected margin');
      const downloadEvent=page.waitForEvent('download',{timeout:60000});
      await page.getByRole('button',{name:'Download PDF',exact:true}).first().click();
      const download=await downloadEvent;
      const pdf=await PDFDocument.load(await readFile(await download.path()));
      assert.ok(pdf.getPageCount()>0);
      assert.equal(await margin.innerText(),label);
      console.log('passed',index===0?'Hootz composite':'simple',label);
    }
    await margin.click();
    await mkdir('tests/artifacts',{recursive:true});
    await page.screenshot({path:`tests/artifacts/all-margins-${index}.png`});
    assert.deepEqual(errors,[]);
    await page.close();
  }
} finally {await browser.close();}
