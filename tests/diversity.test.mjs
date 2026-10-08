import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,normalizeTrack,recordEvent} from '../src/core/model.mjs';
import {rankTracks,selectRetrievalAnchors,playlistPulseContext} from '../src/core/recommender.mjs';
import {artistIndex,recordingKey} from '../src/core/diversity.mjs';
import {collectYouTubeCandidates} from '../src/core/catalog.mjs';
const now=1800000000000;
const song=(id,artist,extra={})=>normalizeTrack({id,title:'Song '+id,artist,artistId:artist,genre:'House',duration:200,...extra});
function biasedLibrary(){
  const s=initialState(),saved=Array.from({length:30},(_,i)=>song('liked'+i,'Favourite'));
  const fresh=Array.from({length:32},(_,i)=>song('fresh'+i,'New artist '+i));
  s.settings.genres=['House'];s.settings.preferredArtists=['Favourite'];
  s.tracks=Object.fromEntries([...saved,...fresh].map(t=>[t.id,t]));s.likes=saved.map(t=>t.id);return s;
}
test('repeated single-track recalculations retain spacing and discover distinct artists despite a dominant favourite',()=>{
  let s=biasedLibrary(),last=null;const sequence=[];
  for(let i=0;i<24;i++){
    const item=rankTracks(Object.values(s.tracks),s,{now:now+i*200000,limit:1,currentTrackId:last?.id,exclude:last?[last.id]:[]})[0];assert.ok(item);
    sequence.push(item.track);s=recordEvent(s,item.track.id,'play',{newArtist:item.newArtist},now+i*200000);
    s=recordEvent(s,item.track.id,'listen',{seconds:190,ratio:.95},now+i*200000+190000);last=item.track;
  }
  assert.equal(new Set(sequence.map(t=>t.id)).size,24);
  assert.ok(new Set(sequence.map(t=>t.artist)).size>=18);
  for(let i=0;i<sequence.length;i++){
    const window=sequence.slice(Math.max(0,i-11),i+1);assert.ok(window.filter(t=>t.artist==='Favourite').length<=2);
    assert.ok(!sequence.slice(Math.max(0,i-3),i).some(t=>t.artist===sequence[i].artist));
  }
});
test('instant skips and a current track without a playback event still separate artists without training negative taste',()=>{
  const s=biasedLibrary();s.events=[{trackId:'liked0',type:'play',at:now-1000},{trackId:'liked0',type:'skip',seconds:0,ratio:0,at:now}];
  assert.notEqual(rankTracks(Object.values(s.tracks),s,{now,limit:1})[0].track.artist,'Favourite');
  s.events=[];assert.notEqual(rankTracks(Object.values(s.tracks),s,{now,limit:1,currentTrackId:'liked0'})[0].track.artist,'Favourite');
});
test('artist alias channels and collaborations cannot evade session spacing',()=>{
  const s=initialState(),a=song('a','Björk',{artistId:'UC1'}),b=song('b','BJORK - Topic',{artistId:'UC2'}),c=song('c','Björk, Guest',{artistId:'UC1'}),d=song('d','New artist');
  s.tracks={a,b,c,d};s.likes=['a'];s.events=[{trackId:'a',type:'play',at:now-1000}];
  assert.equal(rankTracks([b,c,d],s,{now,limit:1})[0].track.id,'d');
});
test('duplicate uploads collapse to one recording and share the repeat interval; distinct remixes remain',()=>{
  const s=initialState(),a=song('a','Artist',{title:'Real Song (Official Audio)'}),b=song('b','ARTIST',{title:'Real Song — Official Video'}),remix=song('r','Artist',{title:'Real Song (Club Remix)'});
  s.tracks={a,b,remix};const keys=artistIndex([a,b,remix]);assert.equal(recordingKey(a,keys),recordingKey(b,keys));
  assert.equal(rankTracks([a,b,remix],s,{now}).length,2);
  s.events=[{trackId:'a',type:'play',at:now-1000}];assert.deepEqual(rankTracks([b,remix],s,{now}).map(r=>r.track.id),['r']);
  s.settings.repeatCooldown=0;assert.equal(rankTracks([b,remix],s,{now}).length,2);
});
test('queue diversity keeps taste relevance and relaxes gracefully when only one artist is available',()=>{
  const s=initialState(),liked=song('seed','Only artist'),match=song('match','Only artist'),unrelated=song('random','Other',{genre:'Classical'});
  s.tracks={liked,match,unrelated};s.likes=['seed'];s.events=[{trackId:'seed',type:'play',at:now-1000}];
  assert.equal(rankTracks([match,unrelated],s,{now,limit:1})[0].track.id,'match');
  assert.equal(rankTracks([match],s,{now,limit:5}).length,1);
  s.settings.blockedArtists=['Only artist'];assert.equal(rankTracks([match],s,{now}).length,0);
});
test('playlist and mood recommendations share the same artist spacing across recalculations',()=>{
  const s=biasedLibrary();s.playlists=[{id:'p',name:'My House',trackIds:s.likes}];
  s.events=[{trackId:'liked0',type:'play',at:now-1000}];
  const pool=Object.values(s.tracks).map(t=>({...t,discoveryMoods:['energetic']}));
  for(const context of [playlistPulseContext(s,'p'),{mood:'energetic'}])assert.notEqual(rankTracks(pool,s,{now,context,limit:1})[0].track.artist,'Favourite');
});
test('retrieval anchors cover minority artists before second songs of a dominant artist',()=>{
  const s=biasedLibrary();s.likes.push('fresh0','fresh1','fresh2');const selected=selectRetrievalAnchors(s,{now,limit:4});
  assert.equal(new Set(selected.map(t=>t.artist)).size,4);
});
test('YouTube retrieval explores three new-artist bridges and later search pages without following blocked artists',async()=>{
  const s=initialState(),seed=song('yt_abcdefghijk','Favourite',{source:'youtube',videoId:'abcdefghijk'});
  s.tracks={[seed.id]:seed};s.likes=[seed.id];s.settings.genres=['House'];s.settings.blockedArtists=['Blocked'];
  const bridge=song('yt_12345678901','New artist',{source:'youtube',videoId:'12345678901'}),blocked=song('yt_12345678902','Blocked',{source:'youtube',videoId:'12345678902'});
  const discovered=song('yt_12345678903','Another new artist',{source:'youtube',videoId:'12345678903'}),calls=[];
  const found=await collectYouTubeCandidates(s,async(route,params)=>{calls.push([route,params]);return route==='/related/abcdefghijk'?[bridge,blocked]:route==='/related/12345678901'?[discovered]:[];},{round:1});
  assert.ok(calls.some(([r])=>r==='/related/12345678901'));assert.ok(!calls.some(([r])=>r==='/related/12345678902'));
  assert.ok(calls.some(([r,p])=>r==='/tracks/search'&&p.offset===80));
  const next=found.find(t=>t.id===discovered.id);assert.ok(next.relatedTo.includes(seed.id));assert.ok(next.retrievalSources.includes('discovery-related'));
  assert.equal(rankTracks([next,song('random','Classical',{genre:'Classical'})],s,{now,limit:1})[0].track.id,next.id);
});

test('minority artists survive the 120-anchor budget even with hundreds of stronger songs from one artist',()=>{
  const s=initialState(),dominant=Array.from({length:180},(_,i)=>song('strong'+i,'Dominant')),minority=song('minority','Minority',{genre:'Jazz'});
  s.tracks=Object.fromEntries([...dominant,minority].map(t=>[t.id,t]));s.likes=dominant.map(t=>t.id);s.playlists=[{id:'minor',trackIds:[minority.id]}];
  const seeds=selectRetrievalAnchors(s,{now,limit:3});assert.ok(seeds.some(t=>t.id==='minority'));
});
