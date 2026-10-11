import test from 'node:test';import assert from 'node:assert/strict';
import {initialState,normalizeTrack} from '../src/core/model.mjs';
import {portableLibrary,applyPortable,mergeSet} from '../src/core/sync.mjs';
import {analyzePCM,soundSimilarity,validateSoundProfile} from '../src/core/sound-profile.mjs';
import {rankTracks,buildProfile,selectRetrievalAnchors} from '../src/core/recommender.mjs';
const now=Date.now(),id='abcdefghijk',other='lmnopqrstuv';
function library(){const s=initialState();s.tracks.yt_abcdefghijk=normalizeTrack({id:'yt_'+id,videoId:id,source:'youtube',title:'Музыка',artist:'Автор',artwork:'https://i.ytimg.com/vi/'+id+'/hqdefault.jpg'});return portableLibrary(s);}
function pcm(freq,beat=false){return Float32Array.from({length:16000*12},(_,i)=>Math.sin(2*Math.PI*freq*i/16000)*.3*(beat?(.1+Math.exp(-((i/16000)%0.5)*15)):1));}
const warm=analyzePCM(pcm(220,true)),bright=analyzePCM(pcm(3500,true));
test('real PCM analysis separates timbre, detects rhythm, rejects silence and invalid profiles',()=>{
  assert.ok(warm&&bright);assert.ok(warm.tempoConfidence>.3);assert.ok([60,120].some(bpm=>Math.abs(warm.tempo-bpm)<5));assert.ok(soundSimilarity(warm,warm)>.99);assert.ok(soundSimilarity(warm,bright)<.6);assert.equal(analyzePCM(new Float32Array(16000*12)),null);assert.equal(validateSoundProfile({...warm,bands:[NaN]}),null);
});
test('sound similarity influences unknown artists; dislikes override saves, context and diversity quotas',()=>{
  const s=initialState();s.settings.genres=[];s.settings.artistDiversity=1;const track=(name,profile)=>({...normalizeTrack({id:name,title:name,artist:name,source:'youtube',videoId:name}),soundProfile:profile});
  s.tracks={seed:track('seed',warm),near:track('near',warm),far:track('far',bright)};s.likes=['seed'];
  assert.equal(rankTracks([s.tracks.far,s.tracks.near],s,{now,limit:1})[0].track.id,'near');
  s.dislikes=['near'];s.playlists=[{id:'mix',trackIds:['near']}];s.likes.push('near');
  assert.ok(buildProfile(s,now).weights.get('near')<0);assert.equal(rankTracks([s.tracks.near,s.tracks.far],s,{now,limit:1})[0].track.id,'far');assert.equal(selectRetrievalAnchors(s,{limit:3,now}).some(a=>a.id==='near'),false);
  assert.equal(rankTracks([s.tracks.near],s,{now,limit:1})[0].track.id,'near');
});
test('portable round trip keeps actual audio features and explicit feedback, excludes secrets/audio',()=>{
  const s=initialState();const t=normalizeTrack({id:'yt_'+id,source:'youtube',videoId:id,title:'Трек',artist:'Автор'});t.soundProfile=warm;s.tracks[t.id]=t;s.dislikes=[t.id];s.settings.apiKey='PRIVATE';s.events=[{trackId:t.id,type:'dislike',at:now,seconds:0,ratio:0}];
  const portable=portableLibrary(s),restored=applyPortable(initialState(),portable);assert.deepEqual(restored.dislikes,[t.id]);assert.deepEqual(restored.tracks[t.id].soundProfile,warm);assert.equal(portable.events[0].kind,'dislike');assert.ok(!JSON.stringify(portable).includes('PRIVATE'));
});
test('background audio acquisition selects AAC, limits size and rejects arbitrary hosts',async()=>{
  const {SoundAudio}=await import('../electron/sound-audio.cjs');
  const create=()=>({getBasicInfo:async()=>({streaming_data:{adaptive_formats:[{has_audio:true,has_video:false,mime_type:'audio/mp4',url:'https://r1.googlevideo.com/file',bitrate:96000,content_length:8}]}})});
  const audio=new SoundAudio(async url=>{assert.ok(String(url).startsWith('https://r1.googlevideo.com/'));return new Response(new Uint8Array([1,2,3]));},create);assert.deepEqual([...await audio.load(id)],[1,2,3]);
  const huge=new SoundAudio(async()=>new Response('',{headers:{'content-length':String(7*1024*1024)}}),create);await assert.rejects(huge.load(id),/лимит/);
  const evil=new SoundAudio(async()=>{throw new Error('Must not fetch');},()=>({getBasicInfo:async()=>({streaming_data:{adaptive_formats:[{has_audio:true,mime_type:'audio/mp4',url:'https://evil.invalid/stream',bitrate:1}]}})}));await assert.rejects(evil.load(id),/Недопустимый/);
});

