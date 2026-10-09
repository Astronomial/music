import {initialState,normalizeTrack,recordEvent} from '../src/core/model.mjs';
import {rankTracks} from '../src/core/recommender.mjs';
import {pathToFileURL} from 'node:url';

// Deterministic behavioural simulation, NOT an estimate of a listener's taste.
// Candidate metadata is fixed before playback, likes exist before the session,
// and feedback is added only after each choice. No future events enter ranking.
const start=1800000000000;
const track=(id,artist,genre,ru=true,extra={})=>normalizeTrack({id,title:(ru?'Запись ':'Recording ')+id,artist,artistId:artist,genre,language:ru?'ru':'en',duration:200,...extra});
function fixture(){
  const s=initialState();s.settings.repeatCooldown=24;
  const saved=[...Array.from({length:100},(_,i)=>track('saved'+i,'Dominant','Pop')),
    ...Array.from({length:12},(_,i)=>track('minor'+i,'Minor '+i,'Rock'))];
  const pool=[...saved,...Array.from({length:100},(_,i)=>track('near'+i,'New '+i,i%3?'Pop':'Rock',i%4!==0)),
    ...Array.from({length:60},(_,i)=>track('weak'+i,'Weak '+i,'',true,{discoveryGenres:['Pop'],discoveryLanguages:['ru']})),
    ...Array.from({length:40},(_,i)=>track('far'+i,'Far '+i,'Ambient'))];
  s.tracks=Object.fromEntries(pool.map(t=>[t.id,t]));s.likes=saved.map(t=>t.id);
  return {state:s,pool};
}
function evaluate(rank){
  let {state,pool}=fixture();const sequence=[];
  for(let i=0;i<40;i++){
    const now=start+i*205000,item=rank(pool,state,{now,limit:1,seed:7});
    if(!item.length)break;
    const chosen=item[0],good=['Pop','Rock'].includes(chosen.track.genre);
    sequence.push({id:chosen.track.id,artist:chosen.track.artist,newTrack:!chosen.known,newArtist:chosen.newArtist,ru:chosen.track.language==='ru',good,lane:chosen.lane});
    state=recordEvent(state,chosen.track.id,'play',{surface:'pulse',newArtist:chosen.newArtist,...(chosen.exposure?{recommendation:chosen.exposure}:{})},now);
    state=recordEvent(state,chosen.track.id,good?'listen':'skip',{surface:'pulse',seconds:good?190:8,ratio:good?.95:.04,...(chosen.exposure?{recommendation:chosen.exposure}:{})},now+(good?190000:8000));
  }
  const share=key=>Number((sequence.filter(x=>x[key]).length/Math.max(1,sequence.length)).toFixed(3));
  let maxArtist=0;
  for(let i=0;i<sequence.length;i++)for(const t of sequence.slice(Math.max(0,i-11),i+1))maxArtist=Math.max(maxArtist,sequence.slice(Math.max(0,i-11),i+1).filter(x=>x.artist===t.artist).length);
  return {played:sequence.length,uniqueRecordings:new Set(sequence.map(x=>x.id)).size,uniqueArtists:new Set(sequence.map(x=>x.artist)).size,newTrackShare:share('newTrack'),newArtistShare:share('newArtist'),explicitGenreMatchShare:share('good'),explicitRussianShare:share('ru'),maxArtistIn12:maxArtist};
}
const result={kind:'synthetic-sequential-simulation',current:evaluate(rankTracks)};
if(process.env.FORMA_BASELINE_RECOMMENDER){const baseline=await import(pathToFileURL(process.env.FORMA_BASELINE_RECOMMENDER));result.baseline=evaluate(baseline.rankTracks);}
console.log(JSON.stringify(result,null,2));
