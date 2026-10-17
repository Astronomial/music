import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, normalizeTrack, recordEvent } from '../src/core/model.mjs';
import { rankTracks, eventWeight, buildProfile, trackSimilarity } from '../src/core/recommender.mjs';
const now=1800000000000;
const track=(id,genre,artist=id,extra={})=>({id,title:id,artist,artistId:artist,genre,mood:'',tags:[],streamable:true,duration:200,favoriteCount:0,...extra});
function setup(){const s=initialState();s.tracks={a:track('a','House','one'),b:track('b','House','two'),c:track('c','Rock','three')};return s;}
test('saved tracks and playlist membership both shape taste immediately',()=>{
  let s=setup();s.likes=['a'];assert.equal(rankTracks([s.tracks.b,s.tracks.c],s,{now})[0].track.id,'b');
  s.likes=[];s.playlists=[{id:'p',trackIds:['c']}];assert.equal(rankTracks([s.tracks.b,s.tracks.c],s,{now})[0].track.id,'c');
  s.playlists=[];assert.equal(Object.keys(buildProfile(s,now).positive).length,0);
});
test('early skips reduce related tracks and late skips do not penalize taste',()=>{
  let s=setup();s.settings.genres=['House','Rock'];s=recordEvent(s,'a','skip',{seconds:8,ratio:0.04},now);
  assert.equal(rankTracks([s.tracks.b,s.tracks.c],s,{now})[0].track.id,'c');
  assert.equal(eventWeight({type:'skip',seconds:180,ratio:0.9}),0);
  assert.equal(eventWeight({type:'listen',ratio:0.95}),1.5);
  assert.equal(eventWeight({type:'error'}),0);
});
test('taste history decays, explicit likes remain and repeated signals saturate',()=>{
  let s=setup();s.likes=['a'];
  for(let i=0;i<100;i++)s=recordEvent(s,'c','skip',{seconds:5,ratio:0.025},now);
  assert.equal(buildProfile(s,now).weights.get('c'),-7);
  const recent=recordEvent(setup(),'a','listen',{ratio:1},now);
  assert.ok(buildProfile(recent,now+90*86400000).weights.get('a')<buildProfile(recent,now).weights.get('a')/4);
  assert.equal(buildProfile(s,now+90*86400000).weights.get('a'),5);
});
test('hidden, unavailable, queued and recently played tracks stay out of the wave',()=>{
  const s=setup();s.hidden=['a'];s.tracks.d=track('d','House','four',{streamable:false});s.events=[{type:'play',trackId:'b',at:now-1000}];
  assert.deepEqual(rankTracks(Object.values(s.tracks),s,{now}).map(r=>r.track.id),['c']);
  assert.equal(rankTracks(Object.values(s.tracks),s,{now,exclude:['c']}).length,0);
});
test('diversity avoids an artist monopolizing a ranked queue',()=>{
  const s=initialState();s.settings.genres=['House'];const tracks=Array.from({length:8},(_,i)=>track(String(i),'House',i<5?'one':'artist'+i));
  const ranked=rankTracks(tracks,s,{now,seed:1,limit:5});
  assert.notEqual(ranked[0].track.artistId,ranked[1].track.artistId);
  assert.ok(new Set(ranked.map(r=>r.track.artistId)).size>=3);
});
test('cold start respects selected genres and returns useful explanations',()=>{
  const s=setup();s.settings.genres=['Rock'];const first=rankTracks(Object.values(s.tracks),s,{now})[0];
  assert.equal(first.track.genre,'Rock');assert.match(first.reason,/Rock/);
});
test('tempo similarity handles half-time beats and preference clusters retain minority interests',()=>{
  const a=track('seed','House','one',{bpm:80});
  assert.ok(trackSimilarity(a,track('half','House','two',{bpm:160}))>trackSimilarity(a,track('far','House','two',{bpm:120})));
  const s=initialState();s.likes=['a','b','c','d'];s.tracks={a:track('a','House'),b:track('b','House'),c:track('c','House'),d:track('d','Jazz')};
  const ranked=rankTracks([track('h','House'),track('j','Jazz'),track('z','Rock')],s,{now});
  assert.ok(ranked.some(r=>r.track.id==='j'));assert.ok(!ranked.some(r=>r.track.id==='z'),'Unrelated genres must not fill the queue');
});
test('download and stream gating are respected when parsing API responses',()=>{
  assert.equal(normalizeTrack({id:'a',download:{is_downloadable:true,requires_follow:true}}).downloadable,false);
  assert.equal(normalizeTrack({id:'a',is_downloadable:true,download_conditions:{tip:true}}).downloadable,false);
  assert.equal(normalizeTrack({id:'a',is_stream_gated:true}).streamable,false);
  assert.equal(normalizeTrack({id:'a',is_downloadable:true}).downloadable,true);
  assert.equal(normalizeTrack({id:'a',artwork:{'480x480':'https://image'},tags:'house, melodic'}).artwork,'https://image');
});
