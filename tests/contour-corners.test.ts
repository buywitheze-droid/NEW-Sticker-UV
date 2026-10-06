import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoothContourCorners } from '../client/src/lib/contour-corners';
import { strokeSettingsSchema } from '../shared/design-document';
import '../vps/src/canvas-shim';

const square = [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];
test('Sharp leaves the offset path unchanged; Balanced protects deliberate corners', () => {
  assert.deepEqual(smoothContourCorners(square,'sharp',300),square);
  assert.deepEqual(smoothContourCorners(square,'balanced',300),square);
  const round = smoothContourCorners(square,'rounded',300);
  assert.equal(round.length,32);
  assert.ok(round.every(p => p.x>=0 && p.x<=100 && p.y>=0 && p.y<=100));
  assert.ok(!round.some(p => p.x===0 && p.y===0));
});
test('Balanced smooths gradual curves less than Rounded', () => {
  const circle=Array.from({length:100},(_,i)=>({x:100*Math.cos(i*Math.PI/50),y:100*Math.sin(i*Math.PI/50)}));
  const radius=(p:{x:number,y:number})=>Math.hypot(p.x,p.y);
  const balanced=smoothContourCorners(circle,'balanced',300);
  const rounded=smoothContourCorners(circle,'rounded',300);
  assert.equal(balanced.length,200);
  assert.ok(radius(balanced[0])>radius(rounded[0]));
});
test('all corner styles survive saved-design validation',()=>{
  for(const cornerMode of ['sharp','balanced','rounded']) {
    const settings={width:0.14,color:'#ff00ff',enabled:true,alphaThreshold:1,backgroundColor:'#ffffff',useCustomBackground:false,cornerMode,autoBridging:false,autoBridgingThreshold:0};
    assert.equal(strokeSettingsSchema.parse(JSON.parse(JSON.stringify(settings))).cornerMode,cornerMode);
  }
});
test('both tracing cores honor explicit styles without changing input margin',async()=>{
  const { ImageData }=await import('@napi-rs/canvas');
  const data=new Uint8ClampedArray(100*80*4);
  for(let y=12;y<68;y++) for(let x=12;x<88;x++) if(x<45||y>32) {
    const i=(y*100+x)*4; data[i]=200; data[i+3]=255;
  }
  for(const tree of ['lib','builders/spot-uv/lib']) {
    const {processContour}=await import(`../client/src/${tree}/contour-trace-core.ts`);
    const paths=[];
    for(const cornerMode of ['sharp','balanced','rounded']) {
      const settings={width:0.07,color:'#ff00ff',enabled:true,alphaThreshold:1,backgroundColor:'#ffffff',useCustomBackground:false,autoBridging:false,autoBridgingThreshold:0,cornerMode};
      const result=processContour(new ImageData(data,100,80),settings,100,false);
      assert.equal(settings.width,0.07);
      assert.ok(result.contourData.pathPoints.length>3);
      paths.push(result.contourData.pathPoints);
    }
    assert.notDeepEqual(paths[0],paths[1]);
    assert.notDeepEqual(paths[1],paths[2]);
  }
});
