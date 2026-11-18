import test from 'node:test';import assert from 'node:assert/strict';
import {tileTelemetry,reorderTile} from './telemetryTiles.js';
test('cards fill phone, DeX and desktop rectangles without holes, overlap or overflow',()=>{
  for(const [w,h] of [[390,650],[844,340],[1366,650],[1920,940]])for(const count of [1,3,8,17]){
    const cards=tileTelemetry(Array.from({length:count},(_,i)=>({id:String(i),weight:i%3+1})),w,h);
    assert.ok(Math.abs(cards.reduce((n,c)=>n+c.width*c.height,0)-w*h)<.001);
    for(const c of cards){assert.ok(c.x>=0&&c.y>=0&&c.x+c.width<=w+.001&&c.y+c.height<=h+.001);for(const other of cards)if(c!==other)assert.ok(c.x+c.width<=other.x+.001||other.x+other.width<=c.x+.001||c.y+c.height<=other.y+.001||other.y+other.height<=c.y+.001);}
  }
});
test('resizing shares a fixed area with neighbors, and every occupied card can be reordered',()=>{
  const list=[{id:'a',weight:1},{id:'b',weight:1},{id:'c',weight:1}];
  const before=tileTelemetry(list,1000,600),after=tileTelemetry([{id:'a',widthWeight:1.3,heightWeight:1.3},...list.slice(1)],1000,600);
  assert.ok(after[0].width*after[0].height>before[0].width*before[0].height);assert.ok(after[1].width*after[1].height<before[1].width*before[1].height);
  assert.deepEqual(reorderTile(list,'a','c').map(c=>c.id),['b','c','a']);
});
test('default numerical cards are compact while actual plots receive wide panels',()=>{
  const cards=tileTelemetry([...Array.from({length:6},(_,i)=>({id:`metric:${i}`,kind:'metric'})),{id:'phase',weight:2},{id:'threshold',weight:1.5},{id:'civet',weight:2}],1280,720);
  assert.ok(cards[0].height<=150);assert.ok(cards.find(c=>c.id==='threshold').width>cards[0].width*2);
});
