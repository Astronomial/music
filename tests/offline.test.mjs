import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {OfflineLibrary}=require('../electron/offline.cjs');
const {Store}=require('../electron/storage.cjs');
function wav(){const b=Buffer.alloc(8044);b.write('RIFF',0);b.writeUInt32LE(8036,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(8000,40);return b;}
test('offline file survives restart and supports seeking and suffix ranges without any network',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forma-offline-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const library=new OfflineLibrary(dir);await library.init();const bytes=wav(),messages=[];
  await library.download({id:'TrackA',title:'local',downloadable:true},async()=>new Response(bytes,{headers:{'content-length':String(bytes.length)}}),p=>messages.push(p));
  assert.ok(messages.at(-1).done);assert.equal(library.list().TrackA.mime,'audio/wav');
  const restarted=new OfflineLibrary(dir);await restarted.init();
  const partial=await restarted.respond('TrackA','bytes=10-31');assert.equal(partial.status,206);assert.equal((await partial.arrayBuffer()).byteLength,22);
  assert.equal(partial.headers.get('content-range'),`bytes 10-31/${bytes.length}`);
  assert.equal((await (await restarted.respond('TrackA','bytes=-10')).arrayBuffer()).byteLength,10);
  assert.equal((await restarted.respond('TrackA','bytes=90000-')).status,416);
  assert.equal((await restarted.respond('../escape')).status,404);
  assert.equal((await restarted.respond('TrackA')).headers.get('content-type'),'audio/wav');
  await restarted.remove('TrackA');assert.deepEqual(restarted.list(),{});
});
test('restricted, corrupt and incomplete downloads cannot enter the offline library',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forma-offline-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const library=new OfflineLibrary(dir);await library.init();
  await assert.rejects(library.download({id:'A',downloadable:false},()=>{throw Error('must not fetch');}),/разрешил/);
  await assert.rejects(library.download({id:'A',downloadable:true},async()=>new Response('<html>error</html>')),/аудиотреком/);
  await assert.rejects(library.download({id:'A',downloadable:true},async()=>new Response(wav(),{headers:{'content-length':'99999'}})),/полным/);
  assert.deepEqual(library.list(),{});assert.equal((await fs.readdir(dir)).filter(x=>x.endsWith('.part')).length,0);
  assert.throws(()=>library.file('../../outside'));
});
test('interrupted transfers are canceled and partial files cleaned up',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forma-offline-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const library=new OfflineLibrary(dir);await library.init();
  const promise=library.download({id:'Cancel',downloadable:true},async signal=>{library.cancel('Cancel');signal.throwIfAborted();});
  await assert.rejects(promise,/отменена/);assert.equal(library.active.size,0);assert.deepEqual(library.list(),{});
});
test('concurrent transfers reserve space and cannot exceed the shared storage quota',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forma-quota-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const library=new OfflineLibrary(dir);await library.init();
  library.manifest.Seed={bytes:10*1024**3-12000};
  const result=await Promise.allSettled(['First','Second'].map(id=>library.download({id,downloadable:true},async()=>new Response(wav()))));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.ok(Object.values(library.list()).reduce((s,d)=>s+d.bytes,0)<=10*1024**3);
  assert.equal(library.reserved.size,0);
});
test('serialized atomic state saves recover the last backup after corruption',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forma-state-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=new Store(dir);
  await Promise.all([store.write('library.json',{version:1,value:1}),store.write('library.json',{version:1,value:2})]);
  assert.equal((await store.read('library.json')).value,2);
  await fs.writeFile(path.join(dir,'library.json'),'corrupt');assert.equal((await store.read('library.json')).value,1);
});
