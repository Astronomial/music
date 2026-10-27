import test from 'node:test';
import assert from 'node:assert/strict';
import {packSemantic,validateSemanticProfile,semanticSimilarity,semanticGenres,SEMANTIC_MODEL_ID} from '../src/core/semantic-audio.mjs';
import {effnetPatches} from '../src/core/effnet-mel.mjs';
import styles from '../src/core/effnet-styles.json' with {type:'json'};
import {analyzePCM} from '../src/core/sound-profile.mjs';
import {initialState,normalizeTrack,mergeTracks} from '../src/core/model.mjs';

test('semantic vectors are bounded, model-versioned and quantized without losing neighbourhoods',()=>{
 const a=Array.from({length:1280},(_,i)=>Math.sin(i*.17)),b=a.map((x,i)=>x*.9+Math.cos(i*.43)*.1),c=a.map(x=>-x);
 const first=packSemantic(a,Array(400).fill(.01),12),near=packSemantic(b,Array(400).fill(.01),12),far=packSemantic(c,Array(400).fill(.01),12);
 assert.equal(first.model,SEMANTIC_MODEL_ID);assert.ok(first.vector.length<1800);assert.ok(validateSemanticProfile(first));
 assert.ok(semanticSimilarity(first,near)>.98);assert.ok(semanticSimilarity(first,far)<.01);
 assert.equal(validateSemanticProfile({...first,model:'wrong-model'}),null);
 assert.equal(validateSemanticProfile({...first,vector:'AA=='}),null);
 assert.equal(packSemantic(Array(1280).fill(0),Array(400).fill(0),12),null);
 assert.equal(packSemantic(a,Array(400).fill(NaN),12),null);
});
test('semantic style decisions abstain on ambiguity and distinguish children/chanson from rap',()=>{
 const vector=Array.from({length:1280},(_,i)=>Math.sin(i));
 const profile=(name,second='')=>{const scores=Array(400).fill(.01);scores[styles.indexOf(name)]=.9;if(second)scores[styles.indexOf(second)]=.85;return packSemantic(vector,scores,12);};
 assert.deepEqual(semanticGenres(profile("Children's---Nursery Rhymes")),["Children's Music"]);
 assert.deepEqual(semanticGenres(profile('Pop---Chanson')),['Chanson']);
 assert.deepEqual(semanticGenres(profile('Hip Hop---Gangsta')),['Hip-Hop/Rap']);
 assert.deepEqual(semanticGenres(profile('Pop---Chanson','Rock---Alternative Rock')),[]);
});
test('EffNet input uses bounded 128-by-96 patches of actual PCM and rejects invalid sampling',()=>{
 const pcm=Float32Array.from({length:16000*9},(_,i)=>.15*Math.sin(2*Math.PI*440*i/16000));
 const input=effnetPatches(pcm);assert.equal(input.count,3);assert.equal(input.data.length,3*128*96);
 assert.ok(input.data.every(Number.isFinite));assert.ok(input.data.some(x=>x>0));
 assert.equal(effnetPatches(pcm,8000),null);assert.equal(effnetPatches(pcm.subarray(0,1000)),null);
 const silence=effnetPatches(new Float32Array(16000*8));assert.ok(silence.data.every(x=>x===0));
});
test('a sparse old track cannot erase a completed semantic analysis',()=>{
 const pcm=Float32Array.from({length:16000*9},(_,i)=>.15*Math.sin(2*Math.PI*440*i/16000));
 const base=analyzePCM(pcm),semantic=packSemantic(Array.from({length:1280},(_,i)=>Math.sin(i)),Array(400).fill(.01),9);
 const original=normalizeTrack({id:'yt_00000000001',source:'youtube',videoId:'00000000001',title:'Audio',artist:'Artist',soundProfile:{...base,semantic}});
 let state=mergeTracks(initialState(),[original]);state=mergeTracks(state,[{...original,soundProfile:base}]);
 assert.deepEqual(state.tracks[original.id].soundProfile.semantic,semantic);
});
