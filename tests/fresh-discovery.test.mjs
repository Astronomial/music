import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,normalizeTrack,mergeTracks,recordEvent} from '../src/core/model.mjs';
import {rankTracks,buildProfile} from '../src/core/recommender.mjs';
import {releaseFreshness,recentReleaseRows,freshReleaseTarget} from '../src/core/release-discovery.mjs';
import {matchRecordingGenre} from '../src/core/genre-evidence.mjs';
import {portableLibrary,applyPortable} from '../src/core/sync.mjs';
import {YouTubeCatalog} from '../src/core/youtube.mjs';
import {GenreCatalog} from '../electron/genre-catalog.cjs';
const now=1800000000000,day=86400000;
const song=(i,extra={})=>normalizeTrack({id:'yt_'+String(i).padStart(11,'0'),videoId:String(i).padStart(11,'0'),source:'youtube',title:'Песня '+i,artist:'Артист '+i,genre:'Pop',duration:200,...extra});
const evidence=(at)=>({version:1,source:'itunes',values:['Pop'],confidence:.95,checkedAt:now,recordingId:'1',releasedAt:at});
const state=(tracks,likes)=>({...initialState(),tracks:Object.fromEntries(tracks.map(t=>[t.id,t])),likes:likes.map(t=>t.id),settings:{...initialState().settings,artistDiversity:0,repeatCooldown:0,discovery:1}});
test('old catalogue dates override recent uploads; unknown, future, discovery time and years in titles are not releases',()=>{
 assert.equal(releaseFreshness(song(1,{publishedAt:now-day,genreEvidence:evidence(now-1000*day)}),now).recent,false);
 for(const t of [song(1,{discoveredAt:now,releaseDate:new Date(now).toISOString(),title:'Новинка 2027'}),song(2,{publishedAt:now+2*day}),song(3)])assert.equal(releaseFreshness(t,now).recent,false);
 const upload=releaseFreshness(song(4,{publishedAt:now-day}),now);assert.ok(upload.recent&&!upload.verified&&upload.score<.35);
 const release=releaseFreshness(song(5,{genreEvidence:evidence(now-day)}),now);assert.ok(release.recent&&release.verified&&release.score>.9);
});
test('new release appetite learns from real outcomes separately and ignores failed loads and instant skips',()=>{
 const tracks=Array.from({length:6},(_,i)=>song(i,{genreEvidence:evidence(now-day)})),s=state(tracks,[]);
 s.events=tracks.map(t=>({trackId:t.id,type:'error',surface:'pulse',at:now,seconds:20,ratio:0}));assert.equal(freshReleaseTarget(s,now),.6);
 s.events=tracks.map(t=>({trackId:t.id,type:'skip',surface:'pulse',at:now,seconds:0,ratio:0}));assert.equal(freshReleaseTarget(s,now),.6);
 s.events=tracks.map(t=>({trackId:t.id,type:'skip',surface:'pulse',at:now,seconds:10,ratio:.05}));assert.ok(freshReleaseTarget(s,now)<.4);
 s.events=tracks.map(t=>({trackId:t.id,type:'listen',surface:'pulse',at:now,seconds:190,ratio:.95}));assert.ok(freshReleaseTarget(s,now)>.7);
});
test('a large imported archive cannot drown current likes, including many songs of one favourite artist',()=>{
 for(const size of [40,100]){
  const likes=Array.from({length:size},(_,i)=>song(i,{artist:'Любимый',genre:'Rock'})),imported=Array.from({length:400},(_,i)=>song(10000+i,{genre:'Jazz'})),s=state([...likes,...imported],likes);s.settings.genres=[];s.playlists=[{id:'archive',trackIds:imported.map(t=>t.id)}];
  const p=buildProfile(s,now),rock=p.positive['genre:Rock'],jazz=p.positive['genre:Jazz'];assert.ok(Math.abs(rock/(rock+jazz)-(size>=100?.7:.5))<1e-6);
 }
});
test('freshness priority changes after actual negative feedback, while cold start still offers a catalogue',()=>{
 const seed=song(1),fresh=song(2,{artist:seed.artist,genreEvidence:evidence(now-day)}),old=song(3,{artist:seed.artist,genreEvidence:evidence(now-900*day)}),past=Array.from({length:6},(_,i)=>song(20+i,{genreEvidence:evidence(now-day)})),s=state([seed,fresh,old,...past],[seed]);
 assert.equal(rankTracks([old,fresh],s,{now,limit:1})[0].track.id,fresh.id);
 s.events=past.map(t=>({trackId:t.id,type:'skip',at:now,seconds:10,ratio:.05,surface:'pulse'}));assert.equal(rankTracks([old,fresh],s,{now,limit:1})[0].track.id,old.id);
 const cold=state([],[]),example=song(99,{retrievalSources:['genre','mood-reference']});assert.equal(rankTracks([example],cold,{now}).length,1);
});
test('fresh release lookup uses exact artists and earliest recording dates, retaining remix identity',()=>{
 const row={kind:'song',artistName:'Артист 1',trackName:'Песня 1',releaseDate:new Date(now-5*day).toISOString(),primaryGenreName:'Pop',trackId:1,trackTimeMillis:200000};
 assert.equal(recentReleaseRows([row,{...row,releaseDate:new Date(now-900*day).toISOString()}],'Артист 1',now).length,0);
 assert.equal(recentReleaseRows([row,{...row,artistName:'Чужой'},{...row,trackName:'Песня 1 (Remix)'}],'Артист 1',now).length,2);
 assert.equal(matchRecordingGenre(song(1),[row],now).releasedAt,now-5*day);
 assert.equal(matchRecordingGenre(song(1,{title:'Песня 1 (Remix)'}),[row],now).releasedAt,undefined);
});
test('same candidate pool follows the listener rather than lifetime popularity or a broad Pop label',()=>{
 const a=song(1),b=song(2),groups=[a,b].map((seed,g)=>Array.from({length:30},(_,i)=>song(100+g*100+i,{artist:seed.artist,genreEvidence:evidence(now-7*day)})));
 const hits=Array.from({length:80},(_,i)=>song(500+i,{favoriteCount:1e10,playCount:1e12,genreEvidence:evidence(now-900*day)}));
 const all=[a,b,...groups.flat(),...hits];
 for(let g=0;g<2;g++){const s=state(all,[g?b:a]),r=rankTracks([...groups.flat(),...hits],s,{now,limit:15});assert.equal(r.length,15);assert.ok(r.every(x=>x.track.artist===(g?b:a).artist));}
});
test('unrelated curated references do not leak into Pulse while a saved artist and focus context remain allowed',()=>{
 const seed=song(1),reference=song(2,{retrievalSources:['mood-reference'],mood:'calm'}),personal=song(3,{artist:seed.artist,retrievalSources:['mood-reference']});
 const s=state([seed,reference,personal],[seed]);assert.deepEqual(rankTracks([reference,personal],s,{now}).map(r=>r.track.id),[personal.id]);
 s.likes.push(reference.id);assert.ok(rankTracks([reference],s,{now}).length);
});
test('freshness and source attribution survive refresh, approved wire format and an older metadata response',()=>{
 const original=song(1,{publishedAt:now-day,retrievalSources:['mood-reference'],genreEvidence:evidence(now-900*day)});
 const updated=mergeTracks(state([original],[original]),[song(1,{genreEvidence:evidence(now-2*day)})],now);
 const restored=applyPortable(initialState(),portableLibrary(updated)),t=restored.tracks[original.id];
 assert.equal(t.publishedAt,now-day);assert.ok(t.retrievalSources.includes('mood-reference'));assert.equal(releaseFreshness(t,now).recent,false);
});
test('release catalogue resolves exact songs and never trusts a similarly named video or another artist',async()=>{
 const row={kind:'song',artistName:'Артист 1',trackName:'Песня 1',releaseDate:new Date(Date.now()-day).toISOString(),primaryGenreName:'Pop',trackId:1,trackTimeMillis:200000};
 const service=new YouTubeCatalog(async()=>{throw new Error('not used');},{releaseLookup:async()=>[row]});
 service.search=async()=>({items:[song(9),song(1)]});
 const result=await service.request('/tracks/releases',{query:'Артист 1'});assert.deepEqual(result.items.map(t=>t.id),[song(1).id]);assert.ok(result.items[0].genreEvidence.releasedAt);
 service.releaseLookup=async()=>[];service.orderedSearch=async()=>({items:[song(1),song(2)],hasMore:false});
 assert.deepEqual((await service.request('/tracks/releases',{query:'Артист 1'})).items.map(t=>t.id),[song(1).id]);
});
test('release metadata uses artist identity and the actual recent-song API sort, with cached bounded requests',async()=>{
 const calls=[],service=new GenreCatalog(async address=>{
  const url=new URL(address);calls.push(url);assert.equal(url.hostname,'itunes.apple.com');
  if(url.pathname==='/search'){assert.equal(url.searchParams.get('entity'),'musicArtist');return Response.json({results:[{artistName:'Другой',artistId:9},{artistName:'Артист 1',artistId:12}]});}
  assert.equal(url.pathname,'/lookup');assert.equal(url.searchParams.get('id'),'12');assert.equal(url.searchParams.get('sort'),'recent');assert.equal(url.searchParams.get('entity'),'song');
  return Response.json({results:[{kind:'song',artistName:'Артист 1',trackName:'Новая песня',releaseDate:new Date(Date.now()-day).toISOString()}]});
 });
 assert.equal((await service.releases('Артист 1')).length,1);assert.equal((await service.releases('Артист 1')).length,1);assert.equal(calls.length,2);
 assert.deepEqual(await service.releases('Артист 2'),[]);assert.equal(calls.length,2);
});
test('fresh discoveries have a dedicated budget without narrowing the familiar pool',()=>{
 const likes=Array.from({length:60},(_,i)=>song(i)),fresh=Array.from({length:140},(_,i)=>song(1000+i,{relatedTo:[likes[i%60].id],directRelatedTo:[likes[i%60].id],genreEvidence:evidence(now-10*day)})),older=Array.from({length:140},(_,i)=>song(2000+i,{relatedTo:[likes[i%60].id],directRelatedTo:[likes[i%60].id],favoriteCount:1e12,genreEvidence:evidence(now-900*day)}));
 let s=state([...likes,...fresh,...older],likes);s.settings.discovery=.7;const draws=[];
 for(let i=0;i<90;i++){const at=now+i*210000,r=rankTracks(Object.values(s.tracks),s,{now:at,limit:1,exclude:draws.map(x=>x.track.id)})[0];assert.ok(r);draws.push(r);s=recordEvent(s,r.track.id,'play',{surface:'pulse',newArtist:r.newArtist,recommendation:r.exposure},at);}
 const novel=draws.filter(r=>!r.known);assert.ok(novel.length>=60&&novel.length<=65);assert.ok(novel.filter(r=>r.freshness.recent).length>=novel.length*.55);assert.equal(new Set(draws.map(r=>r.track.id)).size,90);
});
