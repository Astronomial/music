import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState, normalizeTrack} from '../src/core/model.mjs';
import {buildProfile, rankTracks, moodRecommendations} from '../src/core/recommender.mjs';
import {blockedByPreferences, waveSettings, upgradeWaveSettings} from '../src/core/wave-settings.mjs';
import {matchRecordingGenre} from '../src/core/genre-evidence.mjs';
import {buildContextualModel,contextFeatures} from '../src/core/contextual-learning.mjs';
import {buildFeedbackModel} from '../src/core/feedback.mjs';

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
test('a broad Pop label alone cannot fill discovery slots or overrule a concrete library neighbour',()=>{
 const seed=song(50),generic=Array.from({length:30},(_,i)=>song(100+i,{favoriteCount:1e9})),good=song(200,{genre:'',relatedTo:[seed.id],directRelatedTo:[seed.id]});
 const state=initialState();state.tracks={[seed.id]:seed};state.likes=[seed.id];state.settings.repeatCooldown=0;
 assert.deepEqual(rankTracks(generic,state,{now}).map(r=>r.track.id),[]);
 assert.deepEqual(rankTracks([...generic,good],state,{now}).map(r=>r.track.id),[good.id]);
});
test('manual listening to forbidden styles never trains positive recommendation models',()=>{
 const track=song(60,{genre:'Russian Chanson'}),state=initialState();state.tracks={[track.id]:track};
 const recommendation={version:3,features:contextFeatures({taste:1,genre:1,known:true}),lane:'familiar'};
 state.events=[{type:'like',trackId:track.id,at:now,seconds:0,ratio:0,recommendation}];
 assert.equal(buildContextualModel(state,now).samples,0);
 assert.equal(buildFeedbackModel(state,now).global.size,0);
});
test('explicit unwanted artists and children music are excluded without banning nearby names or winter songs',()=>{
 for(const extra of [{artist:'Стас Михайлов - Topic'},{artist:'Ваня Дмитриенко'},{artist:'Vanya Dmitrienko'},{genre:"Children’s Music"},{genre:'Детская музыка'}])assert.equal(blockedByPreferences(song(70,extra),waveSettings()),true);
 for(const extra of [{artist:'ксюшенька'},{artist:'бэя'},{artist:'Три дня дождя'},{artist:'MARKUL'},{title:'Скоро новый год',artist:'Janna RAY'},{artist:'Михайловский оркестр'}])assert.equal(blockedByPreferences(song(71,extra),waveSettings()),false);
});
test('artist taste guidance migrates once and later user edits are preserved',()=>{
 const first=upgradeWaveSettings({preferredArtists:['Existing'],recommendationVersion:2});
 for(const name of ['ксюшенька','бэя','Три дня дождя','MARKUL'])assert.ok(first.preferredArtists.includes(name));
 assert.ok(first.preferredArtists.includes('Existing'));
 const edited=upgradeWaveSettings({...first,preferredArtists:['Other']});assert.deepEqual(edited.preferredArtists,['Other']);
});
test('an explicitly preferred artist is personal evidence even outside the current dominant genre',()=>{
 const seed=song(800),preferred=song(801,{artist:'MARKUL',genre:'Hip-Hop/Rap'}),state=initialState();
 state.likes=[seed.id];state.tracks={[seed.id]:seed};state.settings.preferredArtists=['MARKUL'];
 assert.equal(rankTracks([preferred],state,{now})[0]?.track.id,preferred.id);
});
