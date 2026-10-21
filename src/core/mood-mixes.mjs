import rules from './mood-rules.json' with {type:'json'};
import recordings from './mood-recordings.json' with {type:'json'};
import {fold} from './wave-settings.mjs';
import {validateSoundProfile} from './sound-profile.mjs';
import {artistIdentity,genreRelation} from './genre-evidence.mjs';
export const MOOD_COLLECTION_SIZE=25;
export const MOOD_MIXES=rules.map((r,i)=>({...r,className:['mix-sage','mix-sand','mix-lilac','mix-blue','mix-focus','mix-night'][i],context:{id:r.id,mood:r.id,genres:r.genres,...(['calm','focus','night'].includes(r.id)?{energy:'low'}:r.id==='energetic'?{energy:'high'}:{}),...(r.id==='focus'?{vocals:'instrumental'}:{})}}));
// Conservative catalogue annotations match the original recording only.
const canonical=s=>fold(s).replace(/(?: official (?:music )?(?:video|audio)| lyrics| lyric video| topic| audio| video)$/, '').trim();
const recordingIndex=new Map(recordings.map(r=>[canonical(r.artist)+'|'+canonical(r.title),r]));
export function moodRecording(track){return recordingIndex.get(canonical(track.artist||'')+'|'+canonical(track.title||''));}
export function moodSeedQuery(id,offset=0){const pool=recordings.filter(r=>r.moods.includes(id));const r=pool[((offset%pool.length)+pool.length)%pool.length];return r?r.artist+' '+r.title:'';}
export function moodSeedQueries(id,{artists=[],genres=[],offset=0,limit=3}={}){
  const names=new Set(artists.map(artistIdentity)),pool=recordings.filter(r=>r.moods.includes(id));
  const favourites=pool.filter(r=>names.has(artistIdentity(r.artist)));
  const compatible=pool.filter(r=>(r.genres||[]).some(g=>genres.some(genre=>genreRelation({genre:g},{genre})>0)));
  // Known artists first, then nearby styles. Rotate songs, never freeze the
  // shelf on a single hard-coded example. Query provenance is not a mood label.
  const group=[...new Map([...favourites,...compatible,...pool].map(r=>[r.artist+"|"+r.title,r])).values()];
  return Array.from({length:Math.min(limit,group.length)},(_,i)=>group[(Math.max(0,offset)+i)%group.length]).map(r=>r.artist+' '+r.title);
}
const cache=new WeakMap();
const normalized=rules.map(r=>({...r,positive:r.positive.map(fold),titleSignals:r.titleSignals.map(fold)}));
function contains(text,word){return text.includes(' '+word+' ');}
function has(text,words){return words.some(word=>contains(text,word)&&!['не','not','no','without','без'].some(no=>contains(text,no+' '+word)));}
const instrumental=['instrumental','instrumentals','без вокала','без слов','no vocals','without vocals','karaoke','инструментальная','инструментальный','инструментал'];
const vocals=['vocals','vocal','singing','with vocals','с вокалом','вокальная','вокальный','lyrics','с текстом'];
const intense=['energetic','aggressive','hardstyle','hardcore','screamo','workout','агрессивная','энергичная'];
const gentle=[...normalized.find(r=>r.id==='calm').positive,'lo fi','soft','focus','focused','study','концентрация'];
export function moodFitness(track){
  if(cache.has(track))return cache.get(track);
  const mood=' '+fold(track.mood||'')+' ',tags=' '+fold((track.tags||[]).join(' '))+' ',title=' '+fold(track.title||'')+' ';
  const sound=validateSoundProfile(track.soundProfile);
  const tempo=sound&&sound.tempoConfidence>=.35&&sound.tempo>0?Math.max(0,Math.min(1,(sound.tempo-65)/105)):null;
  const energy=sound?(tempo===null?sound.onsetRate*.6+sound.brightness*.4:sound.onsetRate*.6+sound.brightness*.2+tempo*.2):null;
  const reference=moodRecording(track);
  const inst=reference?.instrumental||has(tags,instrumental)||has(title,instrumental),voice=has(tags,vocals)||has(title,vocals);
  const calm=has(mood+tags,gentle)||has(title,['relaxing piano','спокойная музыка','тихое фортепиано'])||['ambient','lo fi'].includes(fold(track.genre||''))||(energy!==null&&energy<=.35);
  const result={};
  for(const r of normalized){
    let score=has(mood,[r.id,...r.positive]) ? .95 : has(tags,r.positive) ? .8 : has(title,r.titleSignals) ? .65 : reference?.moods.includes(r.id) ? .82 : 0;
    const conflict=r.conflicts.some(id=>{const other=normalized.find(x=>x.id===id);return has(mood,[id,...other.positive])||has(tags,other.positive)||(score<.8&&has(title,other.titleSignals));});
    if(conflict||(['calm','focus','night'].includes(r.id)&&(has(tags,intense)||has(title,['hardstyle remix','hardcore remix','screamo cover','aggressive remix','энергичный ремикс'])))||(r.id==='bright'&&has(tags,['aggressive','angry','злая','агрессивная']))){result[r.id]=0;continue;}
    if(energy!==null&&((r.maxEnergy!==null&&energy>r.maxEnergy)||(r.minEnergy!==null&&energy<r.minEnergy))){result[r.id]=0;continue;}
    if(r.id==='calm'&&energy!==null&&energy<=.3)score=Math.max(score,.7);
    if(r.id==='energetic'&&energy!==null&&energy>=.64)score=Math.max(score,.7);
    if(r.id==='night'&&energy!==null&&energy<=.48&&sound.brightness<=.4)score=Math.max(score,.66);
    if(r.id==='focus'){
      if(!inst||voice||!(calm||reference?.moods.includes('focus'))){result[r.id]=0;continue;}
      score=Math.max(score,.75);
    }
    // A query or a broad genre never establishes eligibility for a mood.
    const hint=track.discoveryMoods?.includes(r.id);
    result[r.id]=score>=.6?Math.min(1,score+(hint ? .03 : 0)):0;
  }
  cache.set(track,result);return result;
}
export function moodEvidence(track,context){return context?.mood?moodFitness(track)[context.mood]||0:0;}
