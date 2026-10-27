import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {startStaticServer}=createRequire(import.meta.url)('../electron/static.cjs');
test('native UI origin serves pinned model, WASM and module bytes with correct MIME while retaining its allowlist',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'forma-neural-assets-'));
 const files=[['model.onnx','application/octet-stream'],['runtime.wasm','application/wasm'],['runtime.mjs','text/javascript; charset=utf-8']];
 for(const [name] of files)await writeFile(path.join(root,name),Buffer.from([0,97,115,109]));
 await writeFile(path.join(root,'secret.json'),'{}');
 const {server,url}=await startStaticServer(root);
 try{
  for(const [name,mime] of files){const response=await fetch(new URL(name,url));assert.equal(response.status,200,name);assert.equal(response.headers.get('content-type'),mime);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),new Uint8Array([0,97,115,109]));}
  assert.equal((await fetch(new URL('secret.json',url))).status,404);
  assert.equal((await fetch(new URL('model.onnx',url),{method:'POST'})).status,405);
 }finally{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
