import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateSemanticProfile,semanticSimilarity} from '../src/core/semantic-audio.mjs';
const base=process.env.FORMA_URL||'http://127.0.0.1:4179';
const name=fs.readdirSync('dist/assets').find(s=>/^sound-worker-.*\.js$/.test(s));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const page=await browser.newPage();await page.goto(base);
 const result=await page.evaluate(async workerURL=>{
  const worker=new Worker(workerURL,{type:'module'}),times=[],profiles=[];
  try{
   for(let pass=0;pass<2;pass++){
    const pcm=Float32Array.from({length:16000*9},(_,i)=>.15*Math.sin(2*Math.PI*440*i/16000));
    const at=performance.now();
    const value=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('SEMANTIC_TIMEOUT')),60000);worker.onmessage=e=>{clearTimeout(timer);resolve(e.data);};worker.onerror=e=>{clearTimeout(timer);reject(new Error(e.message));};worker.postMessage({pcm},[pcm.buffer]);});
    if(value.semanticError)throw new Error(value.semanticError);
    profiles.push(value.profile);times.push(performance.now()-at);
   }
   return {profiles,times};
  }finally{worker.terminate();}
 },base+'/assets/'+name);
 for(const p of result.profiles)assert.ok(validateSemanticProfile(p?.semantic),'the actual packaged model must produce a valid deep profile');
 assert.ok(semanticSimilarity(result.profiles[0].semantic,result.profiles[1].semantic)>.9999);
 assert.ok(result.times.every(t=>t<30000));
 fs.writeFileSync(process.env.FORMA_SEMANTIC_GOLDEN||path.join(os.tmpdir(),'forma-semantic-native-golden.json'),JSON.stringify(result.profiles[0].semantic,null,2)+'\n');
 console.log(JSON.stringify({result:'PASS',actualONNX:true,patches:3,dimensions:1280,model:result.profiles[0].semantic.model,coldMilliseconds:result.times[0],warmMilliseconds:result.times[1]}));
}finally{await browser.close();}
