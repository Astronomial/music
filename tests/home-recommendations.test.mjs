import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,normalizeTrack} from '../src/core/model.mjs';
import {rankTracks,moodRecommendations} from '../src/core/recommender.mjs';
import {languageEvidence} from '../src/core/discovery-policy.mjs';
const now=1800000000000;
function catalogue(){
 const s=initialState();s.settings={...s.settings,genres:['Pop'],repeatCooldown:0,languagePreference:'ru',artistDiversity:.8};
 const tracks=Array.from({length:62},(_,i)=>normalizeTrack({id:'yt_'+String(i).padStart(11,'0'),videoId:String(i).padStart(11,'0'),source:'youtube',title:i<30?'Song '+i:'Песня '+i,artist:'Artist '+i,artistId:'artist'+i,genre:i<30?'Pop':'',discoveryGenres:i>=30?['Pop']:[],discoveryMoods:['calm','bright','melancholic','energetic','focus','night'],duration:200}));
 s.tracks=Object.fromEntries(tracks.map(t=>[t.id,t]));s.likes=[tracks[0].id,tracks[30].id];return {s,tracks};
}
test('home and all mood shelves keep mostly Russian taste-supported tracks even with stronger English metadata',()=>{
 const {s,tracks}=catalogue();
 for(const result of [rankTracks(tracks,s,{now,limit:12}),...moodRecommendations(tracks,s,{now,limit:12}).map(m=>m.items)]){
  assert.equal(result.length,12); const ru=result.filter(r=>languageEvidence(r.track,'ru').fit>=.6).length;
  assert.ok(ru>=8,`Only ${ru}/12 Russian recommendations`); assert.ok(result.slice(0,6).filter(r=>languageEvidence(r.track,'ru').fit>=.6).length>=4,'Windows home shows the first six recommendations'); assert.equal(new Set(result.map(r=>r.track.artist)).size,12);
 }
});
test('Russian preference does not admit unrelated or explicitly excluded songs to fill language slots',()=>{
 const {s,tracks}=catalogue();s.settings.genreMode='strict';s.hidden=[tracks[31].id];s.settings.blockedArtists=[tracks[32].artist];
 const jazz=Array.from({length:20},(_,i)=>normalizeTrack({id:'unrelated'+i,title:'Чужой джаз '+i,artist:'Jazz '+i,genre:'Jazz',duration:200}));
 const result=rankTracks([...tracks,...jazz],s,{now,limit:20});assert.ok(result.every(r=>!r.track.id.startsWith('unrelated')&&!s.hidden.includes(r.track.id)&&r.track.artist!==tracks[32].artist));
});

// Retrieval uses the real library, not an unrelated fixed mood genre catalogue.
import {collectYouTubeCandidates} from '../src/core/catalog.mjs';
import {tasteGenres} from '../src/core/discovery-search.mjs';
test('retrieval searches favourite YouTube artists and learned genres in Russian for every mood',async()=>{
 const {s,tracks}=catalogue();s.settings.genres=[];s.likes=[tracks[30].id];tracks[30].genre='Rock';tracks[30].artist='Любимый артист';
 const calls=[];await collectYouTubeCandidates(s,async(route,params)=>{calls.push({route,...params});return [];});
 assert.ok(calls.some(c=>c.query?.includes('Любимый артист')));
 for(const word of ['спокойная','радостная','грустная','энергичная','концентрации','ночная'])assert.ok(calls.some(c=>c.query?.includes(word)&&c.query.includes('рок')&&c.query.includes('русская музыка')),word);
 assert.ok(!calls.some(c=>c.query?.includes('House')),'Unrelated default genres should not dictate home mood discovery');
 const strict={...s.settings,genreMode:'strict',genres:['Pop'],excludedGenres:['Rock']};assert.deepEqual(tasteGenres([tracks[30]],strict),['Pop']);
});

test('home and every mood change with library taste even without explicit genre settings',()=>{
 const tracks=Array.from({length:60},(_,i)=>normalizeTrack({id:'yt_'+String(i).padStart(11,'0'),videoId:String(i).padStart(11,'0'),source:'youtube',title:'Песня '+i,artist:'Артист '+i,genre:i<30?'Rock':'Jazz',discoveryMoods:['calm','bright','melancholic','energetic','focus','night'],duration:200}));
 for(const [anchor,genre] of [[tracks[0],'Rock'],[tracks[30],'Jazz']]){
  const s=initialState();s.settings.genres=[];s.settings.repeatCooldown=0;s.tracks=Object.fromEntries(tracks.map(t=>[t.id,t]));s.likes=[anchor.id];
  for(const result of [rankTracks(tracks,s,{now,limit:12}),...moodRecommendations(tracks,s,{now,limit:12}).map(m=>m.items)])assert.ok(result.filter(r=>r.track.genre===genre).length>=10,genre);
 }
});

test('language preference cannot force repeats when its only supported artist is already spaced out',()=>{
 const {s,tracks}=catalogue();for(let i=0;i<tracks.length;i++){
  tracks[i].title=i<20?'Песня '+i:'Song '+i;tracks[i].genre='Pop';tracks[i].artist=i<20?'Любимый':'New '+i;tracks[i].artistId=i<20?'fav':'new'+i;
 }
 s.likes=tracks.slice(0,20).map(t=>t.id);
 const result=rankTracks(tracks,s,{now,limit:18}).map(r=>r.track);
 for(let i=0;i<result.length;i++)assert.ok(result.slice(Math.max(0,i-11),i+1).filter(t=>t.artist==='Любимый').length<=2);
 for(let i=1;i<result.length;i++)assert.ok(!result.slice(Math.max(0,i-4),i).some(t=>t.artist===result[i].artist));
});
