import test from 'node:test';
import assert from 'node:assert/strict';
import {readHostedScreenshot} from '../dist/server/hosted-session.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=','base64');
const origin={sessionId:'original-session',turnId:'original-turn'};
const item={id:'original-browser-item',turn_id:origin.turnId,type:'computer_use_call',status:'completed',output:{image_url:`data:image/png;base64,${png.toString('base64')}`}};
test('captures real live screenshot bytes with original provenance; metadata-only history cannot replace them',()=>{
 const captured=readHostedScreenshot(item,origin,1000);assert.deepEqual(Buffer.from(captured.data),png);
 assert.equal(captured.itemId,item.id);assert.equal(captured.turnId,origin.turnId);
 assert.equal(readHostedScreenshot({...item,output:null},origin,1000),null);
});
test('rejects cross-turn images, remote URLs, malformed data and oversized screenshots',()=>{
 assert.throws(()=>readHostedScreenshot({...item,turn_id:'other'},origin,1000),/SCOPE/);
 for(const image_url of ['https://example.com/private.png','data:image/png;base64,YmFk'])
  assert.throws(()=>readHostedScreenshot({...item,output:{image_url}},origin,1000),/INVALID/);
 assert.throws(()=>readHostedScreenshot(item,origin,8),/INVALID/);
});
