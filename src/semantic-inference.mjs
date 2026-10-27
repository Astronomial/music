import * as ort from 'onnxruntime-web/wasm';
import wasm from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import mjs from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import modelUrl from '../build/music-model/discogs-effnet-bsdynamic-1.onnx?url';
import {effnetPatches} from './core/effnet-mel.mjs';
import {packSemantic} from './core/semantic-audio.mjs';
const digest='a280825b334797cf677939db8cd5762c0392aedd0ca6415dbc1cd083f045e43c';
let session;
async function load(){
 ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;ort.env.wasm.wasmPaths={wasm,mjs};
 const response=await fetch(modelUrl);if(!response.ok)throw new Error('SEMANTIC_MODEL_MISSING');
 const bytes=await response.arrayBuffer();
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
 if(hash!==digest)throw new Error('SEMANTIC_MODEL_CHECKSUM');
 return ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
}
export async function analyzeSemantic(pcm){
 const patches=effnetPatches(pcm);if(!patches)return null;
 session??=load().catch(error=>{session=null;throw error;});
 const engine=await session;
 if(engine.inputNames.length!==1)throw new Error('SEMANTIC_INPUT_SCHEMA');
 const result=await engine.run({[engine.inputNames[0]]:new ort.Tensor('float32',patches.data,[patches.count,128,96])});
 // The pinned ONNX export renames the original TensorFlow endpoints. Validate
 // tensor shapes rather than relying on names in the companion TF manifest.
 const values=Object.values(result);
 const vectors=values.find(t=>t.dims.length===2&&t.dims[0]===patches.count&&t.dims[1]===1280)?.data;
 const scores=values.find(t=>t.dims.length===2&&t.dims[0]===patches.count&&t.dims[1]===400)?.data;
 if(vectors?.length!==patches.count*1280||scores?.length!==patches.count*400)throw new Error('SEMANTIC_OUTPUT_SHAPE');
 const average=(values,size)=>Array.from({length:size},(_,i)=>{let sum=0;for(let patch=0;patch<patches.count;patch++)sum+=values[patch*size+i];return sum/patches.count;});
 return packSemantic(average(vectors,1280),average(scores,400),Math.min(30,pcm.length/16000));
}
