import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1280,height:900},acceptDownloads:true});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  await page.locator('input[type=file]').first().setInputFiles('attached_assets/HootzDecalFinal_1791307163714.png');
  await page.getByRole('button',{name:'Outline Type',exact:true}).waitFor();
  const contour=page.getByRole('button',{name:'Contour',exact:true});
  if(!await contour.isVisible()) await page.getByRole('button',{name:'Outline Type',exact:true}).click();
  await contour.click();
  const select=page.getByTestId('select-corner-style');
  assert.match(await select.innerText(),/Balanced/);
  const frames=[];
  for(const style of ['balanced','sharp','rounded']) {
    if(style!=='balanced') {
      await select.click();
      await page.getByTestId(`corner-style-${style}`).click();
    }
    // Wait for debounce to begin before checking for a finished trace.
    await page.waitForTimeout(600);
    await page.waitForFunction(()=>![...document.querySelectorAll('p')].some(p=>p.textContent?.includes('Processing...')),null,{timeout:60000});
    await page.waitForFunction(()=>[...document.querySelectorAll('canvas')].some(c=>{
      if(!c.getClientRects().length||c.width<100)return false;
      const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let n=0;for(let i=0;i<d.length;i+=4)if(d[i]>185&&d[i+1]<85&&d[i+2]>185&&d[i+3]>150)n++;
      return n>100;
    }),null,{timeout:60000});
    frames.push(await page.locator('canvas').evaluateAll(cs=>cs.filter(c=>c.getClientRects().length).map(c=>c.toDataURL()).join('')));
    for(const name of ['Download PDF','Single Artboard Download']) {
      const pending=page.waitForEvent('download',{timeout:60000});
      await page.getByRole('button',{name,exact:true}).first().click();
      const download=await pending;
      const pdf=await PDFDocument.load(await readFile(await download.path()));
      assert.ok(pdf.getPageCount()>0);
      assert.match(pdf.getSubject(),/CutContour/);
    }
    console.log('passed',style);
  }
  assert.notEqual(frames[0],frames[1],'Balanced and Sharp must render different contours');
  assert.notEqual(frames[1],frames[2],'Sharp and Rounded must render different contours');
  await mkdir('tests/artifacts',{recursive:true});
  await page.screenshot({path:'tests/artifacts/corner-styles-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await select.scrollIntoViewIfNeeded();
  await page.screenshot({path:'tests/artifacts/corner-styles-mobile.png'});
  assert.deepEqual(errors,[]);
} finally {await browser.close();}
