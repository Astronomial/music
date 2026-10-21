import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,normalizeTrack,recordEvent} from '../src/core/model.mjs';
import {rankTracks,moodRecommendations} from '../src/core/recommender.mjs';
import {collectYouTubeCandidates} from '../src/core/catalog.mjs';
import {moodFitness,moodSeedQueries,MOOD_MIXES} from '../src/core/mood-mixes.mjs';
import {portableLibrary,applyPortable,mergePortable} from '../src/core/sync.mjs';
import {buildContextualModel,contextFeatures,predictContext,validContext} from '../src/core/contextual-learning.mjs';
import {genresOf} from '../src/core/genre-evidence.mjs';
const now=1800000000000;
const song=(n,extra={})=>normalizeTrack({id:'yt_'+String(n).padStart(11,'0'),videoId:String(n).padStart(11,'0'),source:'youtube',title:'Песня '+n,artist:'Артист '+n,artistId:'artist'+n,genre:'Pop',duration:200,...extra});
const library=(tracks,likes=tracks)=>({...initialState(),tracks:Object.fromEntries(tracks.map(t=>[t.id,t])),likes:likes.map(t=>t.id),settings:{...initialState().settings,discovery:0,artistDiversity:0,repeatCooldown:0}});

test('the complete favourite library rotates without replacement, independent of score, genre frequency and log truncation',()=>{
 const tracks=Array.from({length:160},(_,i)=>song(i,{artist:i<130?'Один исполнитель':'Другой '+i,artistId:i<130?'one':'id'+i,genre:i>=150?'Jazz':'Pop'}));
 let s=library(tracks);const drawn=[];
 for(let i=0;i<tracks.length;i++){
  const at=now+i*1000,item=rankTracks(tracks,s,{limit:1,now:at,seed:91})[0];assert.ok(item);assert.ok(item.known);assert.ok(!drawn.includes(item.track.id),'Repeated before every eligible favourite was drawn');drawn.push(item.track.id);
  s=recordEvent(s,item.track.id,'play',{},at);
  s.events=[]; // persisted rotation survives the bounded event log and a restart
  s=JSON.parse(JSON.stringify(s));
 }
 assert.equal(new Set(drawn).size,160);assert.ok(drawn.some(id=>Number(id.slice(3))>=150));
 assert.notDeepEqual(drawn,tracks.map(t=>t.id));
 assert.equal(rankTracks(tracks,s,{limit:1,now:now+999000,seed:91})[0].track.id,drawn[0]);
});
test('blocked/disliked/recent favourites are never forced into a familiar quota; an unsaved completion is discovery',()=>{
 const [a,b,c]=[song(1),song(2),song(3)];let s=library([a,b,c],[a,b]);s.dislikes=[a.id];s.hidden=[b.id];s.events=[{trackId:c.id,type:'listen',at:now,seconds:190,ratio:.95}];
 const result=rankTracks([a,b,c],s,{limit:3,now});assert.equal(result.length,1);assert.equal(result[0].track.id,c.id);assert.equal(result[0].known,false);
 s.hidden=[];s.settings.repeatCooldown=2;s.events.push({trackId:b.id,type:'play',at:now});assert.ok(!rankTracks([a,b,c],s,{now}).some(r=>r.known));
});
test('a new recording by an actually listened artist is discovered even outside the old 45-anchor window',()=>{
 const tracks=Array.from({length:170},(_,i)=>song(i));const s=library(tracks,tracks.slice(0,150));s.settings.discovery=1;
 s.events=[{trackId:tracks[169].id,type:'listen',at:now,seconds:180,ratio:.9}];
 const fresh=song(500,{artist:tracks[169].artist,artistId:tracks[169].artistId,genre:''});
 const result=rankTracks([fresh],s,{now});assert.equal(result[0]?.track.id,fresh.id);assert.equal(result[0].known,false);
});
test('rotation and both learner versions survive approved cross-device merge without erasing old training',()=>{
 const a=song(1),b=song(2);let s=recordEvent(library([a,b]),a.id,'play',{},now);s.events=[];
 const doc=portableLibrary(s),other=portableLibrary(recordEvent(library([a,b]),b.id,'play',{},now+1000));
 const merged=mergePortable(doc,doc,other),restored=applyPortable(initialState(),merged);
 assert.equal(restored.familiarPlays[a.id],now);assert.equal(restored.familiarPlays[b.id],now+1000);
 assert.ok(validContext({version:2,features:[1,.5,.5,0,0,1,0,.8,0,1]}));
 assert.ok(validContext({version:3,features:contextFeatures({taste:.5,genre:1,mood:.9,sound:.6})}));
});
test('every mood shelf targets 25 verified recordings and an expanded pool continues the same mood after exhaustion',()=>{
 for(const mix of MOOD_MIXES){
  const tracks=Array.from({length:60},(_,i)=>song(i,{mood:mix.id,tags:mix.id==='focus'?['instrumental','calm']:[]}));let s=library(tracks,tracks.slice(0,3));s.settings.discovery=.7;
  const wrong=song(100,{mood:mix.id==='energetic'?'calm':'energetic'});s.tracks[wrong.id]=wrong;
  const all=[...tracks,wrong],shelf=moodRecommendations(all,s,{now}).find(m=>m.id===mix.id);
  assert.equal(shelf.items.length,25,mix.id);assert.ok(shelf.items.every(r=>moodFitness(r.track)[mix.id]>0));
  const consumed=new Set(shelf.items.map(r=>r.track.id));
  const more=rankTracks(all,s,{context:mix.context,now,limit:25,exclude:[...consumed]});assert.equal(more.length,25,mix.id);assert.ok(more.every(r=>!consumed.has(r.track.id)&&moodFitness(r.track)[mix.id]>0));
 }
});
test('sparse mood discovery rotates exact recordings and requests radio neighbours without labelling search hits',async()=>{
 const seed=song(1,{artist:'Моя Мишель',title:'Химия'}),s=library([seed]);
 const q0=moodSeedQueries('bright',{artists:[seed.artist],genres:['Pop'],offset:0,limit:3}),q1=moodSeedQueries('bright',{artists:[seed.artist],genres:['Pop'],offset:3,limit:3});
 assert.ok(q0.some(q=>q.includes(seed.artist)));assert.equal(new Set([...q0,...q1]).size,6);
 const calls=[];const result=await collectYouTubeCandidates(s,async(route,params)=>{calls.push({route,...params});return [song(900,{title:'Ничего не известно',artist:'Другой',genre:'',mood:''})];},{context:MOOD_MIXES.find(m=>m.id==='bright').context});
 assert.ok(calls.filter(c=>q0.includes(c.query)).length>=3);assert.ok(result.every(t=>moodFitness(t).bright===0));
 // Tempo/danceability alone cannot establish positive lyrical valence.
 assert.equal(moodFitness(song(10,{artist:'Винтаж',title:'Ева'})).bright,0);
 assert.ok(genresOf(song(20,{artist:'Моя Мишель',title:'Химия',genre:''})).values.includes('Pop'));
 assert.deepEqual(genresOf(song(21,{artist:'Моя Мишель',title:'Химия (hardstyle remix)',genre:''})).values,[]);
});
test('the expanded learner separates musical facets and retains the ten-feature historical model',()=>{
 let s=initialState();
 const input=genre=>contextFeatures({taste:.6,nearby:.6,genre,mood:genre,artist:0,sound:.8});
 s.events=Array.from({length:40},(_,i)=>({trackId:'song'+i,type:i%2?'skip':'listen',at:now-i*1000,seconds:i%2?8:190,ratio:i%2?.04:.95,recommendation:{version:3,features:input(i%2?0:1)}}));
 const model=buildContextualModel(s,now);assert.equal(model.samples,40);assert.ok(predictContext(model,input(1)).mean>predictContext(model,input(0)).mean+.25);
 s.events=[{trackId:'old',type:'listen',at:now,seconds:190,ratio:.95,recommendation:{version:2,features:input(1).slice(0,10)}}];assert.equal(buildContextualModel(s,now).samples,1);
});
test('concentration admits verified quiet instrumentals under its explicit context and preserves strict genre exclusions',()=>{
 const favourite=song(500),tracks=Array.from({length:30},(_,i)=>song(i,{genre:'Classical',mood:'focus',tags:['calm','instrumental']}));const s=library([favourite,...tracks],[favourite]);
 assert.equal(rankTracks(tracks,s,{now}).length,0);
 const context=MOOD_MIXES.find(m=>m.id==='focus').context;
 assert.equal(rankTracks(tracks,s,{now,context,limit:25}).length,25);
 s.settings.genreMode='strict';s.settings.genres=['Pop'];assert.equal(rankTracks(tracks,s,{now,context}).length,0);
});
test('an imported recording is familiar, while recently completed artists get their own discovery route',async()=>{
 const likes=Array.from({length:180},(_,i)=>song(i)),imported=song(800),heard=song(900);const s=library([...likes,imported,heard],likes);s.settings.discovery=1;
 s.playlists=[{id:'import',name:'Из Яндекса',trackIds:[imported.id]}];
 const at=Date.now();s.events=[{trackId:heard.id,type:'listen',at:at-1000,seconds:190,ratio:.95}];
 assert.equal(rankTracks([imported],s,{now:at})[0].known,true);
 const calls=[];await collectYouTubeCandidates(s,async(route,params)=>{calls.push({route,...params});return [];});
 assert.ok(calls.some(c=>c.route==='/related/'+heard.videoId));assert.ok(calls.some(c=>c.query?.includes(heard.artist)));
});
test('likes and playlist recordings share a complete rotation even when discovery has no new candidates',()=>{
 const tracks=Array.from({length:70},(_,i)=>song(i)),s=library(tracks,tracks.slice(0,20));s.playlists=[{id:'saved',name:'Перенос',trackIds:tracks.slice(20).map(t=>t.id)}];s.settings.discovery=.7;
 let current=s;const seen=new Set();
 for(let i=0;i<70;i++){
  const at=now+i*1000,item=rankTracks(tracks,current,{limit:1,now:at})[0];assert.ok(item.known);assert.ok(!seen.has(item.track.id));seen.add(item.track.id);current=recordEvent(current,item.track.id,'play',{},at);current.events=[];
 }
 assert.equal(seen.size,70);
});
