// Retrieval labels are deliberately absent: a query is not a recording's genre.
import recordings from './mood-recordings.json' with {type:'json'};
import {semanticGenres} from './semantic-audio.mjs';
export const GENRE_ALIASES={
  Electronic:['electronic','electronica','dance','электроника'],House:['house','deep house','progressive house','хаус'],Techno:['techno','техно'],
  'Hip-Hop/Rap':['hip hop','hip hop rap','rap','alternative rap','хип хоп','рэп'],Alternative:['alternative','indie','alternative rock','альтернатива'],
  Pop:['pop','russian pop','поп'],Ambient:['ambient','эмбиент'],Jazz:['jazz','джаз'],Rock:['rock','russian rock','рок'],
  'R&B/Soul':['r b','rnb','r b soul','soul','соул'],'Lo-Fi':['lo fi','lofi'],'Drum & Bass':['drum bass','drum and bass','dnb','драм н бэйс'],
  Classical:['classical','классическая'],Metal:['metal','heavy metal','метал'],Reggae:['reggae','регги'],'Folk/Country':['folk','country','singer songwriter','фолк'],
  Chanson:['chanson','russian chanson','русский шансон','шансон'],
  Blatnaya:['blatnaya','blatnaya pesnya','criminal chanson','блатная','блатная песня','блатные песни','блатняк','тюремная песня','тюремные песни'],
  'Caucasian Estrada':['caucasian estrada','caucasian pop','кавказская эстрада','кавказский шансон'],
  "Children's Music":['children s music','children music','kids music','nursery rhymes','детская музыка','детские песни','музыка для детей']
};
export const HARD_EXCLUDED_GENRES=new Set(['Chanson','Blatnaya','Caucasian Estrada',"Children's Music"]);
export const genreFold=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const genreNames=new Map(Object.entries(GENRE_ALIASES).flatMap(([name,aliases])=>[name,...aliases].map(alias=>[genreFold(alias),name])));
const curatedRecordings=new Map(recordings.map(r=>[artistIdentity(r.artist)+'|'+recordingIdentity(r.title),r]));

export function canonicalGenres(value){
  const parts=Array.isArray(value)?value:[value];
  return [...new Set(parts.flatMap(part=>{
    const text=genreFold(part);
    // Exact aliases first: Alternative Rock must not also become generic Rock.
    const exact=genreNames.get(text);
    if(exact)return [exact];
    return String(part||'').split(/[,;|/]/).length>1?String(part).split(/[,;|/]/).flatMap(canonicalGenres):[];
  }))];
}
// A veto is independent of positive metadata selection: a conflicting Pop
// label, library membership or recommendation score cannot erase it. Region,
// artist names and query directions are deliberately not classifiers.
export function hardGenreVeto(track){
  const values=[...canonicalGenres(track.genre),...(validateGenreEvidence(track.genreEvidence)?.values||[]),...(track.tags||[]).flatMap(canonicalGenres)];
  return values.some(g=>HARD_EXCLUDED_GENRES.has(g));
}
export function validateGenreEvidence(e){
  if(!e||e.version!==1||e.source!=='itunes'||!Array.isArray(e.values)||!Number.isFinite(e.checkedAt)||e.checkedAt<0||!Number.isFinite(e.confidence))return null;
  const values=canonicalGenres(e.values);
  if(e.values.length>4||e.confidence<0||e.confidence>1||(!values.length&&e.confidence!==0))return null;
  return {version:1,source:'itunes',values,confidence:values.length?Math.min(.95,e.confidence):0,checkedAt:e.checkedAt,recordingId:String(e.recordingId||'').slice(0,60),...(Number.isFinite(e.releasedAt)&&e.releasedAt>0?{releasedAt:e.releasedAt}:{})};
}
const genreCache=new WeakMap();
export function genresOf(track){
  const cached=genreCache.get(track);if(cached&&cached.sound===track.soundProfile&&cached.genre===track.genre&&cached.evidence===track.genreEvidence&&cached.artist===track.artist&&cached.title===track.title)return cached.result;
  const result=readGenres(track);genreCache.set(track,{sound:track.soundProfile,genre:track.genre,evidence:track.genreEvidence,artist:track.artist,title:track.title,result});return result;
}
function readGenres(track){
  const evidence=validateGenreEvidence(track.genreEvidence);
  if(evidence?.values.length&&evidence.confidence>=.8)return {values:evidence.values,confidence:evidence.confidence,source:evidence.source};
  const values=canonicalGenres(track.genre);
  if(!values.length){
    const reference=curatedRecordings.get(artistIdentity(track.artist)+'|'+recordingIdentity(track.title));
    const curated=canonicalGenres(reference?.genres||[]);
    if(curated.length)return {values:curated,confidence:.85,source:'curated-recording'};
    const inferred=semanticGenres(track.soundProfile?.semantic);
    if(inferred.length)return {values:inferred,confidence:.7,source:'audio-model'};
  }
  return {values,confidence:values.length?1:0,source:values.length?'metadata':'unknown'};
}
const neighbours=[['Electronic','House','Techno','Drum & Bass'],['Ambient','Lo-Fi'],['Pop','R&B/Soul'],['Rock','Alternative','Metal'],['Hip-Hop/Rap','R&B/Soul'],['Jazz','Lo-Fi']];
export function genreRelation(a,b){
  const x=genresOf(a).values,y=genresOf(b).values;
  if(x.some(g=>y.includes(g)))return 1;
  return neighbours.some(group=>x.some(g=>group.includes(g))&&y.some(g=>group.includes(g)))?.5:0;
}
// Only discard presentation labels, never remix/live/cover qualifiers: those are
// different recordings and must not inherit the studio version's metadata.
export function recordingIdentity(title){return genreFold(String(title||'').replace(/\s*[[(](?:official\s*)?(?:music\s*)?(?:audio|video|lyrics?|visualizer|hd|hq)[\])]/gi,'').replace(/\s*[-–—|]\s*(?:official\s*)?(?:music\s*)?(?:audio|video|lyrics?|visualizer|hd|hq)\s*$/i,''));}
export function artistIdentity(artist){return genreFold(String(artist||'').replace(/\s*-?\s*Topic\s*$|VEVO\s*$/i,''));}
export function matchRecordingGenre(track,rows,now=Date.now()){
  const title=recordingIdentity(track.title),artist=artistIdentity(track.artist);
  const matches=(Array.isArray(rows)?rows:[]).filter(row=>row.kind==='song'&&recordingIdentity(row.trackName)===title&&artistIdentity(row.artistName)===artist&&(!track.duration||!row.trackTimeMillis||Math.abs(track.duration-row.trackTimeMillis/1000)<=Math.max(6,track.duration*.04)));
  const labels=[...new Set(matches.flatMap(row=>canonicalGenres(row.primaryGenreName)))];
  // Disagreement between releases is uncertainty, not permission to attach every label.
  const values=labels.length===1?labels:[];
  const dates=matches.map(r=>Date.parse(r.releaseDate)).filter(at=>Number.isFinite(at)&&at>0&&at<=now+86400000);
  return {version:1,source:'itunes',values,confidence:values.length?.95:0,checkedAt:now,recordingId:values.length?String(matches[0]?.trackId||''):'',...(dates.length?{releasedAt:Math.min(...dates)}:{})};
}
