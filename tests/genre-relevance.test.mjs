import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {initialState,normalizeTrack,mergeTracks} from '../src/core/model.mjs';
import {genresOf,canonicalGenres,GENRE_ALIASES,matchRecordingGenre} from '../src/core/genre-evidence.mjs';
import {rankTracks,moodRecommendations,buildProfile,selectGenreMetadataAnchors} from '../src/core/recommender.mjs';
import {tasteGenres} from '../src/core/discovery-search.mjs';
import {buildFeedbackModel} from '../src/core/feedback.mjs';
import {portableLibrary,applyPortable} from '../src/core/sync.mjs';
import {CONTEXT_VERSION,validContext} from '../src/core/contextual-learning.mjs';
import {GenreCatalog} from '../electron/genre-catalog.cjs';
const now=1800000000000;
const song=(n,genre='',extra={})=>normalizeTrack({id:'yt_'+String(n).padStart(11,'0'),videoId:String(n).padStart(11,'0'),source:'youtube',artist:'Артист '+n,title:'Песня '+n,genre,duration:200,...extra});
test('query genre accumulation cannot label a recording, train taste or satisfy strict filters',()=>{
 const seed=song(1,'',{discoveryGenres:Object.keys(GENRE_ALIASES)}),s=initialState();s.tracks={[seed.id]:seed};s.likes=[seed.id];s.settings.genres=[];
 assert.deepEqual(genresOf(seed).values,[]);assert.ok(!Object.keys(buildProfile(s,now).positive).some(k=>k.startsWith('genre:')));
 assert.deepEqual(tasteGenres([seed],s.settings),[]);
 s.events=[{trackId:seed.id,type:'listen',ratio:1,seconds:200,at:now}];assert.ok(![...buildFeedbackModel(s,now).global.keys()].some(k=>k.startsWith('genre:')));
 s.settings.genreMode='strict';s.settings.genres=['Rock'];assert.deepEqual(selectGenreMetadataAnchors(s,{now}).map(t=>t.id),[seed.id]);assert.equal(rankTracks([seed],s,{now}).length,0);
});
test('genre normalization distinguishes subgenres, composite labels and unsupported metadata',()=>{
 assert.deepEqual(canonicalGenres('Alternative Rock'),['Alternative']);assert.deepEqual(canonicalGenres('Deep House'),['House']);assert.deepEqual(canonicalGenres('Rock / House'),['Rock','House']);
 assert.deepEqual(canonicalGenres('R&B/Soul'),['R&B/Soul']);assert.deepEqual(canonicalGenres('soundtrack of my life'),[]);
 assert.deepEqual(JSON.parse(fs.readFileSync('ios/Packages/FormaCore/Sources/FormaCore/Resources/genre-aliases.json')),GENRE_ALIASES);
});
test('genre matches exact recording and artist, never an arbitrary remix, cover or ambiguous release',()=>{
 const track=song(1,'',{title:'ВНИМАНИЕ! (Official Audio)',artist:'ксюшенька - Topic'});
 const row={kind:'song',trackName:'ВНИМАНИЕ!',artistName:'ксюшенька',trackTimeMillis:200000,primaryGenreName:'Russian Pop',trackId:12};
 assert.deepEqual(matchRecordingGenre(track,[row],now).values,['Pop']);
 for(const modified of [{artistName:'Другой'},{trackName:'ВНИМАНИЕ! (Remix)'},{trackTimeMillis:260000},{kind:'music-video'}])assert.deepEqual(matchRecordingGenre(track,[{...row,...modified}],now).values,[]);
 assert.deepEqual(matchRecordingGenre(track,[row,{...row,primaryGenreName:'Jazz'}],now).values,[]);
});
test('language, mood, popularity and novelty quotas cannot force unrelated recordings into home or Pulse',()=>{
 const seed=song(1,'Rock'),s=initialState();s.likes=[seed.id];s.tracks={[seed.id]:seed};s.settings.repeatCooldown=0;
 // Simulate the original iOS defaults: they must not expand a real Rock library into rap/electronic music.
 s.settings.genres=['Electronic','Rock','Hip-Hop/Rap'];
 const good=Array.from({length:18},(_,i)=>song(10+i,'Rock',{mood:'calm',language:'en'}));
 const garbage=Array.from({length:80},(_,i)=>song(100+i,i%2?'Jazz':'Hip-Hop/Rap',{mood:'calm',discoveryGenres:['Rock'],favoriteCount:1e9,relatedTo:[seed.id],directRelatedTo:[seed.id]}));
 const moodOnly=song(300,'',{mood:'calm',discoveryGenres:['Rock']});
 const result=rankTracks([...garbage,moodOnly,...good],s,{now,limit:30});
 assert.equal(result.length,18);assert.ok(result.every(r=>r.track.genre==='Rock'));
 for(const mix of moodRecommendations([...garbage,moodOnly,...good],s,{now,limit:24}))assert.ok(mix.items.every(r=>r.track.genre==='Rock'));
 assert.deepEqual(rankTracks(garbage,s,{now}),[],'Do not fill an empty queue with unrelated tracks');
});
test('unknown new artists need direct taste evidence; second hops and shared mood alone are insufficient',()=>{
 const seed=song(1),s=initialState();s.tracks={[seed.id]:seed};s.likes=[seed.id];
 const direct=song(2,'',{relatedTo:[seed.id],directRelatedTo:[seed.id]}),indirect=song(3,'',{relatedTo:[seed.id]}),mood=song(4,'',{mood:'calm'});
 assert.deepEqual(rankTracks([mood,indirect,direct],s,{now}).map(r=>r.track.id),[direct.id]);
});
test('trusted recording genres survive catalogue refresh and approved portable sync; old context is ignored',()=>{
 const t=song(1);t.genreEvidence={version:1,source:'itunes',values:['Rock'],confidence:.95,checkedAt:now,recordingId:'12'};
 let s=initialState();s.tracks={[t.id]:t};s.likes=[t.id];s=mergeTracks(s,[song(1)],now);
 assert.deepEqual(genresOf(s.tracks[t.id]).values,['Rock']);const restored=applyPortable(initialState(),portableLibrary(s));assert.deepEqual(genresOf(restored.tracks[t.id]).values,['Rock']);
 assert.equal(CONTEXT_VERSION,3);assert.equal(validContext({version:1,features:[1,0,0,0,0,0,0,0,0,0],lane:'nearby'}),false);
});
test('metadata requests are bounded, shared, cached, and contain no audio requests',async()=>{
 let calls=0;const service=new GenreCatalog(async url=>{calls++;assert.equal(new URL(url).hostname,'itunes.apple.com');return Response.json({results:[{kind:'song',trackName:'Песня 1',artistName:'Артист 1',trackTimeMillis:200000,primaryGenreName:'Rock',trackId:12}]});});
 const t=song(1);const result=await Promise.all([service.lookup(t),service.lookup(t)]);assert.deepEqual(result[0].values,['Rock']);assert.equal(calls,1);await service.lookup(t);assert.equal(calls,1);
 const unavailable=new GenreCatalog(async()=>{throw new Error('Network unavailable');});unavailable.lastRequest=Date.now()-3000;
 // Malformed input is rejected before making a network request.
 assert.equal(await unavailable.lookup({title:'a'.repeat(201),artist:'A'}),null);
});

test('a genuine saved-track neighbour outranks unrelated music with only a shared broad genre',()=>{
 const seed=song(1,'Pop'),s=initialState();s.tracks={[seed.id]:seed};s.likes=[seed.id];s.settings.artistDiversity=0;
 const direct=song(2,'',{relatedTo:[seed.id],directRelatedTo:[seed.id]}),generic=song(3,'Pop');
 const result=rankTracks([generic,direct],s,{now,limit:2});assert.equal(result[0].track.id,direct.id);
});

test('energetic music and generic mood uploads never replace songs or train taste from accidental completion',()=>{
 const seed=song(1,'Pop'),s=initialState();s.tracks={[seed.id]:seed};s.likes=[seed.id];
 const titles=['Energetic Music','Royalty Free Energetic Background Music','Музыка для хорошего настроения','Фоновая музыка'];
 const utility=titles.map((title,i)=>song(i+10,'Pop',{title,relatedTo:[seed.id],directRelatedTo:[seed.id]}));
 const real=song(2,'Pop',{title:'Энергия',relatedTo:[seed.id],directRelatedTo:[seed.id]});
 for(const t of utility)s.tracks[t.id]=t;s.events=utility.map(t=>({trackId:t.id,type:'listen',at:now,seconds:190,ratio:.95}));
 assert.deepEqual(rankTracks([...utility,real],s,{now}).map(r=>r.track.id),[real.id]);
 for(const t of utility)assert.ok(!buildProfile(s,now).weights.has(t.id));
 s.likes=[utility[0].id];assert.ok(rankTracks(utility,s,{now}).length>0,'Explicitly saved functional music remains supported');
});
