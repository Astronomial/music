import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,normalizeTrack,recordEvent} from '../src/core/model.mjs';
import {rankTracks,selectRetrievalAnchors,interestClusters,moodRecommendations,buildProfile} from '../src/core/recommender.mjs';
import {buildFeedbackModel,predictFeedback} from '../src/core/feedback.mjs';
import {parseYandexPlaylistURL,parseImportFile,applyLibraryImport,matchLibrary} from '../src/core/library-import.mjs';
import {ensureRequestedPlaylist,REQUESTED_PLAYLIST} from '../src/core/starter-library.mjs';
import {requestPublicYandexPlaylist} from '../src/core/yandex.mjs';
const now=1800000000000;
const track=(id,artist,genre='House',extra={})=>normalizeTrack({id,title:id,artist,artistId:artist,genre,...extra});

test('retrieval represents minority interests instead of filling every seed slot with one genre',()=>{
  const s=initialState();const tracks=[...Array.from({length:12},(_,i)=>track('house'+i,'HouseArtist','House')),track('jazz','JazzArtist','Jazz'),track('rock','RockArtist','Rock')];s.tracks=Object.fromEntries(tracks.map(t=>[t.id,t]));s.likes=tracks.map(t=>t.id);
  assert.ok(interestClusters(s,now).length>=3);const seeds=selectRetrievalAnchors(s,{now,limit:6});assert.ok(seeds.some(t=>t.genre==='Jazz'));assert.ok(seeds.some(t=>t.genre==='Rock'));
  s.settings.blockedArtists=['JazzArtist'];assert.equal(selectRetrievalAnchors(s,{now,limit:6}).some(t=>t.artist==='JazzArtist'),false);
});
test('shared listening feedback predicts enjoyment in Pulse and mood playlists, without learning from impressions',()=>{
  let s=initialState();s.tracks={a:track('a','Liked artist'),b:track('b','Skipped artist')};const a=track('newA','Liked artist'),b=track('newB','Skipped artist');
  assert.equal(predictFeedback(a,buildFeedbackModel(s,now)).mean,.5);
  for(let day=0;day<5;day++){s=recordEvent(s,'a','listen',{seconds:180,ratio:.95,mood:'calm',surface:'mood'},now-day*86400000);s=recordEvent(s,'b','skip',{seconds:8,ratio:.05,surface:'pulse'},now-day*86400000);}
  const model=buildFeedbackModel(s,now),yes=predictFeedback(a,model),no=predictFeedback(b,model);
  assert.ok(yes.mean>.5);assert.ok(no.mean<.5);assert.ok(predictFeedback(a,model,'calm').mean>yes.mean);
  assert.equal(rankTracks([b,a],s,{now})[0].track.id,a.id);
  const before=JSON.stringify(s.events);moodRecommendations([a,b],s,{now});assert.equal(JSON.stringify(s.events),before);
});
test('feedback from the same repeated track in a day is bounded and network errors do not train taste',()=>{
  let s=initialState();s.tracks={a:track('a','One')};for(let i=0;i<100;i++)s=recordEvent(s,'a','listen',{ratio:1},now-i*1000);
  assert.ok(buildFeedbackModel(s,now).global.get('artist:one').positive<=1);assert.ok(buildFeedbackModel(s,now).global.get('artist:one').positive>.99);
  const before=predictFeedback(s.tracks.a,buildFeedbackModel(s,now));s=recordEvent(s,'a','error',{seconds:8,ratio:0},now);assert.deepEqual(predictFeedback(s.tracks.a,buildFeedbackModel(s,now)),before);
  s=recordEvent(s,'a','skip',{seconds:1,ratio:.01},now);assert.deepEqual(predictFeedback(s.tracks.a,buildFeedbackModel(s,now)),before);
});
test('current session adds context that fades without discarding permanent favorites',()=>{
  let s=initialState();const rock=track('rock','Old','Rock'),house=track('house','Now','House');s.tracks={rock,house};s.likes=['rock'];
  for(let i=0;i<3;i++)s=recordEvent(s,'house','listen',{seconds:180,ratio:1},now-i*60000);
  const recent=rankTracks([track('h','New','House'),track('r','Other','Rock')],s,{now});assert.ok(recent.find(r=>r.track.id==='h').signals.session>0);
  const later=rankTracks([track('h','New','House')],s,{now:now+3*3600000});assert.equal(later[0].signals.session,0);assert.equal(buildProfile(s,now+90*86400000).weights.get('rock'),5);
});
test('mood playlists use mood evidence and taste, enforce exclusions and preserve different contents',()=>{
  const s=initialState();const tracks=[track('calm','One','Ambient',{mood:'Peaceful'}),track('happy','Two','Pop',{mood:'Upbeat'}),track('sad','Three','Alternative',{mood:'Sad'}),track('energy','Four','Rock',{mood:'Energetic'}),track('night','Five','House',{mood:'Brooding'}),track('unknown','Six','')];s.settings.excludedGenres=['Rock'];
  const mixes=moodRecommendations(tracks,s,{now});assert.equal(mixes.length,6);assert.equal(mixes.find(m=>m.id==='calm').items[0].track.id,'calm');assert.equal(mixes.find(m=>m.id==='bright').items[0].track.id,'happy');assert.ok(mixes.find(m=>m.id==='melancholic').items.some(r=>r.track.id==='sad'));assert.equal(mixes.find(m=>m.id==='night').items[0].track.id,'night');assert.equal(mixes.some(m=>m.items.some(r=>r.track.id==='unknown'||r.track.id==='energy')),false);
  s.tracks=Object.fromEntries(tracks.map(t=>[t.id,t]));s.likes=['happy'];assert.equal(buildProfile(s,now).weights.get('happy'),5);
});
test('liking a mood recommendation makes related music an anchor for the same Pulse',()=>{
  const s=initialState();const seed=track('saved','One','Alternative',{source:'youtube',videoId:'abcdefghijk',mood:'Sad'});s.tracks={saved:seed};s.likes=['saved'];
  const related=track('related','Two','',{source:'youtube',relatedTo:['saved']}),random=track('random','Three','',{source:'youtube'});
  assert.equal(rankTracks([random,related],s,{now})[0].track.id,'related');assert.equal(selectRetrievalAnchors(s,{now})[0].id,'saved');
});
test('provided liked-playlist and iframe addresses resolve only to validated public endpoints',()=>{
  assert.equal(parseYandexPlaylistURL(REQUESTED_PLAYLIST.sourceURL+'?utm_source=web').path,'/users/Astronomial/playlists/3');
  assert.equal(parseYandexPlaylistURL('<iframe src="https://music.yandex.ru/iframe/playlist/Astronomial/3"></iframe>').url,REQUESTED_PLAYLIST.canonicalURL);
  assert.throws(()=>parseYandexPlaylistURL('<iframe src="https://evil.example/iframe/playlist/Astronomial/3"></iframe>'));
  assert.throws(()=>parseYandexPlaylistURL('https://music.yandex.ru/iframe/playlist/x%2F..%2Fetc/3'));
});
test('requested playlist is queued once and retains real source titles when playable versions are missing',async()=>{
  const s=ensureRequestedPlaylist(initialState());assert.equal(s.importRequests[0].status,'pending');assert.equal(ensureRequestedPlaylist(s),s);
  const lib=parseImportFile(JSON.stringify({name:'Liked',tracks:[{title:'Song',artist:'Artist'},{title:'Missing',artist:'Other'}]}));lib.sourceURL=REQUESTED_PLAYLIST.sourceURL;
  const items=await matchLibrary(lib,async(_route,p)=>p.query.includes('Missing')?[]:[normalizeTrack({id:'yt_abcdefghijk',source:'youtube',videoId:'abcdefghijk',title:'Song',artist:'Artist'})]);
  const next=applyLibraryImport(s,lib,items,{id:REQUESTED_PLAYLIST.id,preserveUnmatched:true});assert.equal(next.playlists[0].trackIds.length,2);assert.equal(next.tracks[next.playlists[0].trackIds[1]].title,'Missing');assert.equal(next.tracks[next.playlists[0].trackIds[1]].streamable,false);
  const again=applyLibraryImport(next,lib,items,{id:REQUESTED_PLAYLIST.id,preserveUnmatched:true});assert.equal(again.playlists.length,1);assert.equal(again.imports.length,1);assert.ok(selectRetrievalAnchors(again,{now}).some(t=>t.artist==='Other'));
});
test('liked playlist can use the fixed public web metadata fallback when the API refuses the request',async()=>{
  const calls=[];
  const lib=await requestPublicYandexPlaylist(REQUESTED_PLAYLIST.sourceURL,async url=>{calls.push(url);if(url.startsWith('https://api.music'))return new Response('',{status:403});return Response.json({playlist:{title:'Мне нравится',trackCount:1,tracks:[{title:'Song',artists:[{name:'Artist'}],durationMs:200000}]}});});
  assert.equal(lib.tracks[0].title,'Song');assert.equal(calls.length,2);assert.match(calls[1],/^https:\/\/music.yandex.ru\/handlers\/playlist.jsx\?owner=Astronomial&kinds=3&light=false$/);
});
