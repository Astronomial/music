import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {moodFitness,MOOD_MIXES} from '../src/core/mood-mixes.mjs';
import {rankTracks} from '../src/core/recommender.mjs';
import {initialState,normalizeTrack} from '../src/core/model.mjs';
const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/mood-fitness.json',import.meta.url)));
const track=t=>normalizeTrack({...t,id:'yt_'+t.videoID,videoId:t.videoID,source:'youtube',discoveryMoods:t.moodHints,discoveryGenres:t.genres});
test('Windows and iOS ship the same mood definitions and rejection cases',()=>{
 for(const [a,b] of [['../src/core/mood-recordings.json','../ios/Packages/FormaCore/Sources/FormaCore/Resources/mood-recordings.json'],['../src/core/mood-rules.json','../ios/Packages/FormaCore/Sources/FormaCore/Resources/mood-rules.json'],['./fixtures/mood-fitness.json','../ios/Packages/FormaCore/Tests/FormaCoreTests/Fixtures/mood-fitness.json']])assert.deepEqual(JSON.parse(fs.readFileSync(new URL(a,import.meta.url))),JSON.parse(fs.readFileSync(new URL(b,import.meta.url))));
 for(const m of MOOD_MIXES)for(const text of [m.title,m.label,m.headline,m.subtitle])assert.ok(!/[A-Za-z]/.test(text),text);
});
for(const f of fixtures)test('recording mood: '+f.name,()=>{
 const scores=moodFitness(track(f.track));
 for(const id of f.accept)assert.ok(scores[id]>=.6,`${f.name}: ${id} missing`);
 for(const id of f.reject)assert.equal(scores[id],0,`${f.name}: ${id} incorrectly admitted`);
});
test('favourites and Russian quotas cannot override a contradictory recording mood',()=>{
 const quiet=track({...fixtures.find(f=>f.name==='quiet_vocal').track,artist:'Любимый',genre:'Pop'});
 const wrong=track({...fixtures.find(f=>f.name==='busy_instrumental').track,artist:'Любимый',genre:'Pop'});
 const unknown=track({...fixtures[0].track,artist:'Любимый',genre:'Pop'});
 const s=initialState();s.settings.repeatCooldown=0;s.settings.genres=['Pop'];s.tracks=Object.fromEntries([quiet,wrong,unknown].map(t=>[t.id,t]));s.likes=[wrong.id,unknown.id];
 const result=rankTracks([wrong,unknown,quiet],s,{context:{mood:'calm'},limit:24});
 assert.deepEqual(result.map(r=>r.track.id),[quiet.id]);
 s.hidden=[quiet.id];assert.deepEqual(rankTracks([wrong,unknown,quiet],s,{context:{mood:'calm'},limit:24}),[]);
});

import {collectYouTubeCandidates} from '../src/core/catalog.mjs';
test('mood searches override global energy/vocals without assigning recording emotion',async()=>{
 const s=initialState();s.settings={...s.settings,energy:'high',vocals:'vocal',languagePreference:'ru'};
 const calls=[];await collectYouTubeCandidates(s,async(route,params)=>{calls.push({route,...params});return []});
 const focus=calls.find(c=>c.query?.includes('концентрации'));
 assert.ok(focus.query.includes('без вокала')&&focus.query.includes('медленная')&&!focus.query.includes('быстрая'));
 const night=calls.find(c=>c.query?.includes('ночная'));assert.ok(night.query.includes('медленная')&&!night.query.includes('быстрая'));
 assert.ok(calls.some(c=>c.query?.includes('Прованс')||c.query?.includes('Улыбайся')||c.query?.includes('Химия')||c.query?.includes('шаре')||c.query?.includes('Маршрутка')));
});
