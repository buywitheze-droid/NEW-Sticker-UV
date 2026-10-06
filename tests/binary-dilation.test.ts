import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dilateDisk } from '../client/src/lib/binary-dilation';

function reference(mask: Uint8Array, w: number, h: number, r: number) {
  const out = new Uint8Array((w + 2*r) * (h + 2*r));
  for (let y=0;y<h;y++) for(let x=0;x<w;x++) if(mask[y*w+x]===1)
    for(let dy=-r;dy<=r;dy++) for(let dx=-r;dx<=r;dx++)
      if(dx*dx+dy*dy<=r*r) out[(y+r+dy)*(w+2*r)+x+r+dx]=1;
  return out;
}
test('fast disk dilation exactly matches circular stamping for empty, full, edge and scattered masks', () => {
  for (const [w,h] of [[1,1],[11,7],[3,19]]) {
    for (let seed=0;seed<12;seed++) {
      const mask=Uint8Array.from({length:w*h},(_,i)=>seed===0?0:seed===1?1:((i*13+seed*17)%23<seed?1:0));
      for (const r of [0,1,2,5,20]) assert.deepEqual(dilateDisk(mask,w,h,r),reference(mask,w,h,r));
    }
  }
});
test('print-resolution dense mask with a large offset completes within worker budget', () => {
  const start=performance.now();
  const result=dilateDisk(new Uint8Array(3600*2800).fill(1),3600,2800,184);
  assert.equal(result[184*(3600+368)+184],1);
  assert.equal(result[0],0);
  assert.ok(performance.now()-start<10000,'large-radius dilation exceeded 10 seconds');
});
