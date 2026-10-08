import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,normalizeTrack,mergeTracks} from '../src/core/model.mjs';
import {rankTracks,buildProfile} from '../src/core/recommender.mjs';
import {waveSettings,DEFAULT_WAVE_SETTINGS,genresOf,preferenceAffinity,matchesArtist} from '../src/core/wave-settings.mjs';
import {collectYouTubeCandidates} from '../src/core/catalog.mjs';
import {collectCandidates,apiURL,API_HOSTS} from '../src/core/audius.mjs';
const now=1800000000000;
const track=(id,genre='House',artist=id,extra={})=>normalizeTrack({id,title:id,genre,artist,artistId:artist,...extra});
const ids=(tracks,state)=>rankTracks(tracks,state,{now,seed:1}).map(r=>r.track.id);

test('old profiles gain wave defaults and malformed preferences are bounded',()=>{
  assert.deepEqual(waveSettings(),DEFAULT_WAVE_SETTINGS);
  assert.equal(waveSettings({genreMode:'strict',genres:[]}).genreMode,'prefer');
  const s=waveSettings({genres:['House','Rock','House','bogus'],excludedGenres:['Rock'],discovery:NaN,artistDiversity:4,repeatCooldown:-5,mood:'invalid',energy:'invalid',vocals:'invalid',blockedArtists:['Björk','bjork',5],includeLibrary:false});
  assert.deepEqual(s.genres,['House']);assert.deepEqual(s.blockedArtists,['bjork']);
  assert.equal(s.discovery,.3);assert.equal(s.artistDiversity,1);assert.equal(s.repeatCooldown,0);assert.equal(s.mood,'any');assert.equal(s.energy,'any');assert.equal(s.vocals,'any');assert.equal(s.includeLibrary,false);
});
test('strict genres accept query evidence while real metadata takes precedence',()=>{
  const s=initialState();s.settings.genres=['House'];s.settings.genreMode='strict';
  const tracks=[track('tagged','Deep House'),track('inferred','',undefined,{source:'youtube',discoveryGenres:['House']}),track('rock','Rock',undefined,{discoveryGenres:['House']}),track('unknown','')];
  assert.deepEqual(new Set(ids(tracks,s)),new Set(['tagged','inferred']));
  assert.deepEqual(genresOf(tracks[0]),{values:['House'],confidence:1});
});
test('artist and genre exclusions win over likes without removing manual library entries',()=>{
  const s=initialState();const tracks=[track('a','House','Björk & Guest'),track('b','Rock / House','Other'),track('c','House','Other')];
  s.tracks=Object.fromEntries(tracks.map(t=>[t.id,t]));s.likes=['a','b'];s.settings.blockedArtists=['BJORK'];s.settings.excludedGenres=['Rock'];
  assert.deepEqual(ids(tracks,s),['c']);assert.deepEqual(s.likes,['a','b']);
  assert.equal(matchesArtist(track('x','House','Artist Eleven'),'Artist'),true);assert.equal(matchesArtist(track('x','House','Artist11'),'Artist1'),false);
  s.settings.excludedGenres=['House'];assert.deepEqual(ids(tracks,s),[]);
});
test('mood, energy, vocals and artist preferences change ranking using available evidence',()=>{
  const s=initialState();s.settings.mood='calm';s.settings.energy='low';s.settings.vocals='instrumental';
  const match=track('match','House','One',{mood:'Peaceful',bpm:75,tags:['instrumental']});
  const opposite=track('opposite','House','Two',{mood:'Excited',bpm:145,tags:['vocals']});
  assert.equal(ids([opposite,match],s)[0],'match');
  const settings=waveSettings(s.settings),inferred=track('query','',undefined,{discoveryMoods:['calm'],discoveryEnergy:['low'],discoveryVocals:['instrumental']});
  assert.ok(preferenceAffinity(match,settings).score>preferenceAffinity(inferred,settings).score);
  assert.ok(preferenceAffinity(inferred,settings).score>preferenceAffinity(track('unknown',''),settings).score);
  s.settings={...s.settings,mood:'any',energy:'any',vocals:'any',preferredArtists:['Two']};assert.equal(ids([match,opposite],s)[0],'opposite');
});
test('repeat interval and library inclusion change eligibility independently of taste',()=>{
  const s=initialState(),tracks=[track('recent'),track('older'),track('new')];s.tracks=Object.fromEntries(tracks.map(t=>[t.id,t]));s.likes=['recent'];
  s.events=[{type:'play',trackId:'recent',at:now-10*60000},{type:'play',trackId:'older',at:now-4*3600000}];
  assert.deepEqual(new Set(ids(tracks,s)),new Set(['older','new']));
  s.settings.repeatCooldown=24;assert.deepEqual(ids(tracks,s),['new']);
  s.settings.repeatCooldown=0;assert.equal(ids(tracks,s).length,3);
  s.settings.includeLibrary=false;assert.deepEqual(new Set(ids(tracks,s)),new Set(['older','new']));assert.equal(buildProfile(s,now).weights.get('recent'),5);
});
test('only selected playlists seed taste; likes and listening remain active',()=>{
  const s=initialState();s.tracks={house:track('house'),rock:track('rock','Rock'),liked:track('liked','Jazz')};s.likes=['liked'];s.playlists=[{id:'p1',trackIds:['house']},{id:'p2',trackIds:['rock']}];
  assert.equal(buildProfile(s,now).weights.get('rock'),3);
  s.settings.playlistSource='selected';s.settings.seedPlaylistIds=['p1'];let p=buildProfile(s,now);assert.equal(p.weights.get('house'),3);assert.equal(p.weights.has('rock'),false);assert.equal(p.weights.get('liked'),5);
  s.settings.seedPlaylistIds=[];p=buildProfile(s,now);assert.equal(p.weights.has('house'),false);assert.equal(p.weights.get('liked'),5);
});
test('artist variety control trades repetition for more different performers',()=>{
  const s=initialState();s.settings.preferredArtists=['One'];const tracks=[...Array.from({length:6},(_,i)=>track('one'+i,'House','One')),...Array.from({length:6},(_,i)=>track('other'+i,'House','Other '+i))];
  s.settings.artistDiversity=0;const low=rankTracks(tracks,s,{now,limit:6});
  s.settings.artistDiversity=1;const high=rankTracks(tracks,s,{now,limit:6});
  assert.equal(new Set(low.map(r=>r.track.artistId)).size,1);assert.ok(new Set(high.map(r=>r.track.artistId)).size>=4);
});
test('YouTube retrieval uses every chosen direction and combines character preferences',async()=>{
  const s=initialState();s.settings={...s.settings,genres:['House','Jazz','Rock','Techno','Pop'],excludedGenres:['Rock'],genreMode:'strict',mood:'focus',energy:'low',vocals:'instrumental',preferredArtists:['Björk','Blocked'],blockedArtists:['Blocked']};
  const queries=[];const candidates=await collectYouTubeCandidates(s,async(route,p)=>{assert.equal(route,'/tracks/search');queries.push(p.query);return [track('yt_abcdefghijk','',undefined,{source:'youtube',videoId:'abcdefghijk'})];});
  for(const g of ['House','Jazz','Techno','Pop'])assert.ok(queries.some(q=>q.startsWith(g+' ')));
  assert.equal(queries.some(q=>q.includes('Rock')||q.includes('Blocked')||q.startsWith('Ambient')),false);assert.ok(queries.some(q=>q.startsWith('Björk')));
  assert.ok(queries.every(q=>q.includes('focus study slow mellow instrumental music')));
  assert.deepEqual(new Set(candidates[0].discoveryGenres),new Set(['House','Jazz','Techno','Pop']));assert.equal(candidates[0].genre,'');assert.equal(candidates[0].mood,'');
  const merged=mergeTracks({...s,tracks:{[candidates[0].id]:candidates[0]}},[track(candidates[0].id,'',undefined,{source:'youtube'})]);assert.deepEqual(merged.tracks[candidates[0].id].discoveryGenres,candidates[0].discoveryGenres);
});
test('unselected playlist and blocked artist do not become YouTube related seeds',async()=>{
  const s=initialState();s.tracks={a:track('a','House','Allowed',{source:'youtube',videoId:'abcdefghijk'}),b:track('b','House','Blocked',{source:'youtube',videoId:'12345678901'})};s.playlists=[{id:'p1',trackIds:['a']},{id:'p2',trackIds:['b']}];s.settings.playlistSource='selected';s.settings.seedPlaylistIds=['p1'];const routes=[];
  await collectYouTubeCandidates(s,async route=>{routes.push(route);return[];});assert.ok(routes.includes('/related/abcdefghijk'));assert.equal(routes.includes('/related/12345678901'),false);
  s.settings.blockedArtists=['Allowed'];routes.length=0;await collectYouTubeCandidates(s,async route=>{routes.push(route);return[];});assert.equal(routes.some(r=>r.startsWith('/related/')),false);
});
test('Audius keeps character query context across duplicate responses and uses valid native routes',async()=>{
  const s=initialState();s.settings.mood='calm';s.settings.vocals='instrumental';s.settings.preferredArtists=['Björk'];s.tracks={a:track('a','House','local_Test',{tags:['piano']})};s.likes=['a'];const queries=[];
  const result=await collectCandidates(s,async(route,p)=>{apiURL(API_HOSTS[0],route,p);if(p.query)queries.push(p.query);return [track('same','House')];});
  assert.ok(queries.includes('Björk'));assert.ok(queries.some(q=>q.includes('calm relaxing instrumental music')));assert.deepEqual(result[0].discoveryMoods,['calm']);assert.deepEqual(result[0].discoveryVocals,['instrumental']);
});
