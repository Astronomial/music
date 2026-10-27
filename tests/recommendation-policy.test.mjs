import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState, normalizeTrack} from '../src/core/model.mjs';
import {buildProfile, rankTracks, moodRecommendations} from '../src/core/recommender.mjs';
import {blockedByPreferences, waveSettings} from '../src/core/wave-settings.mjs';
import {matchRecordingGenre} from '../src/core/genre-evidence.mjs';

const now=1800000000000;
const song=(n,extra={})=>normalizeTrack({id:'yt_'+String(n).padStart(11,'0'),videoId:String(n).padStart(11,'0'),source:'youtube',title:'Песня '+n,artist:'Артист '+n,duration:200,genre:'Pop',...extra});
const forbidden=['Russian Chanson','Русский шансон','шансон','Блатная песня','Blatnaya','Кавказская эстрада','Caucasian Pop'];
test('hard genre veto applies before familiar rotation, mood filling and positive learning',()=>{
 const seed=song(1), bad=forbidden.map((genre,i)=>song(10+i,{genre,mood:'calm',relatedTo:[seed.id],directRelatedTo:[seed.id]}));
 const state=initialState();state.tracks=Object.fromEntries([seed,...bad].map(t=>[t.id,t]));state.likes=[seed.id,...bad.map(t=>t.id)];state.playlists=[{id:'import',name:'Imported',trackIds:bad.map(t=>t.id)}];state.settings.repeatCooldown=0;
 for(const track of bad){assert.equal(blockedByPreferences(track,waveSettings(state.settings)),true,track.genre);assert.ok(!(buildProfile(state,now).weights.get(track.id)>0));}
 assert.ok(rankTracks(bad,state,{now}).length===0);
 for(const mix of moodRecommendations(bad,state,{now}))assert.equal(mix.items.length,0);
 assert.equal(state.likes.length,bad.length+1,'the manual library is preserved');
});
test('veto survives conflicting Pop evidence and composite genre fields without matching names or regions',()=>{
 const evidence={version:1,source:'itunes',values:['Pop'],confidence:.95,checkedAt:now,recordingId:'123'};
 for(const genre of forbidden)assert.equal(blockedByPreferences(song(20,{genre:'Pop / '+genre,genreEvidence:evidence}),waveSettings()),true,genre);
 for(const extra of [{genre:'Pop',artist:'Кавказ'},{genre:'Pop',title:'Шансон моей жизни'},{genre:'Turkish Pop',artist:'seyadsultan'},{genre:'Folk',artist:'Народный ансамбль'}])assert.equal(blockedByPreferences(song(30,extra),waveSettings()),false);
});
test('exact external recording metadata retains banned styles instead of losing them as unknown',()=>{
 const track=song(40);
 const row={kind:'song',trackName:track.title,artistName:track.artist,trackTimeMillis:200000,primaryGenreName:'Russian Chanson',trackId:42};
 assert.deepEqual(matchRecordingGenre(track,[row],now).values,['Chanson']);
});
