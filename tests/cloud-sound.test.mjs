import test from 'node:test';import assert from 'node:assert/strict';
import {initialState,normalizeTrack} from '../src/core/model.mjs';
import {portableLibrary,applyPortable,mergeSet} from '../src/core/sync.mjs';
import {emptyCloudDocument,captureCloudChanges,mergeCloudDocuments,materializeCloud,validateCloudDocument,publishCloudDocument} from '../src/core/cloud-sync.mjs';
import {analyzePCM,soundSimilarity,validateSoundProfile} from '../src/core/sound-profile.mjs';
import {rankTracks,buildProfile,selectRetrievalAnchors} from '../src/core/recommender.mjs';
import {GoogleDriveLibrary,boundedJSON} from '../src/core/google-drive.mjs';
const now=Date.now(),id='abcdefghijk',other='lmnopqrstuv';
function library(){const s=initialState();s.tracks.yt_abcdefghijk=normalizeTrack({id:'yt_'+id,videoId:id,source:'youtube',title:'Музыка',artist:'Автор',artwork:'https://i.ytimg.com/vi/'+id+'/hqdefault.jpg'});return portableLibrary(s);}
const actor1='device-desktop',actor2='device-iphone';
test('offline concurrent edits, deletion tombstones and reversible likes/dislikes converge',()=>{
  const p=library();p.likedIDs=[id];p.playlists=[{id:'mix',name:'Тест',trackIDs:[id]}];
  let a=captureCloudChanges(emptyCloudDocument(actor1),p),b=mergeCloudDocuments(emptyCloudDocument(actor2),a);const base=materializeCloud(a);
  const pc=structuredClone(base),phone=structuredClone(base);pc.likedIDs=[];pc.dislikedIDs=[id];phone.playlists[0].trackIDs.push(other);
  a=captureCloudChanges(a,pc,base,now);b=captureCloudChanges(b,phone,base,now+1);
  const ab=mergeCloudDocuments(a,b),ba=mergeCloudDocuments(b,a);assert.deepEqual(materializeCloud(ab),materializeCloud(ba));assert.deepEqual(materializeCloud(ab).likedIDs,[]);assert.deepEqual(materializeCloud(ab).dislikedIDs,[id]);assert.deepEqual(materializeCloud(ab).playlists[0].trackIDs,[id,other]);
  const after=materializeCloud(ab),restored=structuredClone(after);restored.dislikedIDs=[];restored.likedIDs=[id];restored.playlists=[];
  const edited=captureCloudChanges(ab,restored,after,now+2);assert.deepEqual(materializeCloud(mergeCloudDocuments(edited,b)).dislikedIDs,[]);assert.equal(materializeCloud(mergeCloudDocuments(edited,b)).playlists.length,0);
  assert.deepEqual(mergeCloudDocuments(ab,ab),ab);
});
test('a second device imports unique local entries without overwriting account settings on first login',()=>{
  const p=library();p.settings.discovery=.9;let a=publishCloudDocument(captureCloudChanges(emptyCloudDocument(actor1),p));const first=captureCloudChanges(emptyCloudDocument(actor2),library());assert.equal(materializeCloud(mergeCloudDocuments(first,a)).settings.discovery,.9);
  assert.deepEqual(mergeSet([],['a'],['a']),[]);assert.throws(()=>validateCloudDocument({...a,actor:'x'}));
  const bad=structuredClone(a);Object.values(bad.records)[0].stamp.time=now+2*86400000;assert.throws(()=>validateCloudDocument(bad));
});
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
test('Drive writes only its own device file and uses private appDataFolder',async()=>{
  const calls=[],drive=new GoogleDriveLibrary(async(url,options)=>{calls.push({url,options});return Response.json(url.includes('files?')&&options.method!=='POST'?{files:[]}:{id:'file-id-123'});});
  const doc=emptyCloudDocument(actor1);await drive.upload(doc,[]);assert.ok(calls[0].options.body.includes('appDataFolder'));await drive.upload(doc,[{id:'own-file',appProperties:{actor:actor1}},{id:'foreign-file',appProperties:{actor:actor2}}]);assert.ok(calls[1].url.includes('own-file'));assert.equal(calls[1].options.method,'PATCH');
  await assert.rejects(boundedJSON(new Response('1234567890'),4));
});
