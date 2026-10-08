import {performance} from 'node:perf_hooks';
import {rankTracks,moodRecommendations} from '../src/core/recommender.mjs';
import {initialState,normalizeTrack} from '../src/core/model.mjs';
const s=initialState();s.settings.genres=['House','Rock','Jazz'];
const genres=['House','Rock','Jazz','Ambient','Pop','Electronic'];
const tracks=Array.from({length:6000},(_,i)=>normalizeTrack({id:'track'+i,title:'Song'+i,artist:'Artist '+i%120,artistId:'artist'+i%120,genre:genres[i%6],mood:i%2?'Peaceful':'Upbeat',tags:['melodic','chill'],duration:200,bpm:70+i%100}));
s.tracks=Object.fromEntries(tracks.map(t=>[t.id,t]));s.likes=tracks.slice(0,45).map(t=>t.id);
for(const [name,fn] of [['next',()=>rankTracks(tracks,s,{now:1800000000000})],['mixes',()=>moodRecommendations(tracks,s,{now:1800000000000})]]){const t=performance.now();const result=fn();console.log(`${name}: ${(performance.now()-t).toFixed(1)} ms (${result.length} results)`);}
