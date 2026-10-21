import {validateGenreEvidence} from './genre-evidence.mjs';
import {validateSoundProfile} from './sound-profile.mjs';
import {validContext} from './contextual-learning.mjs';
// Versioned portable YouTube metadata. Keys, file paths and stream URLs stay on each device.
const validID=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{11}$/.test(id);
const text=(s,n=200)=>typeof s==='string'?s.trim().slice(0,n):'';
const list=(a,n=3000)=>Array.isArray(a)?[...new Set(a.filter(x=>typeof x==='string').map(x=>x.slice(0,200)))].slice(0,n):[];
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const own=(o,k)=>o&&Object.hasOwn(o,k)?o[k]:undefined;
const set=(o,k,v)=>Object.defineProperty(o,k,{value:v,enumerable:true,configurable:true,writable:true});
const clamp=(v,min,max,fallback)=>Number.isFinite(Number(v))?Math.max(min,Math.min(max,Number(v))):fallback;
export function mergeSet(current=[],base=[],incoming=[]){const old=new Set(base),next=new Set(incoming);return [...new Set([...current.filter(x=>!old.has(x)||next.has(x)),...incoming.filter(x=>!old.has(x))])];}
export function mergeObjects(current={},base={},incoming={}){
  const result=structuredClone(current);
  for(const key of new Set([...Object.keys(base),...Object.keys(incoming)])){
    const before=own(base,key),after=own(incoming,key),actual=own(result,key);
    if(same(before,after))continue;
    if(!Object.hasOwn(incoming,key))delete result[key];
    else if(before&&after&&typeof after==='object'&&!Array.isArray(after))set(result,key,mergeObjects(actual||{},before,after));
    else if(Array.isArray(after)&&after.every(x=>typeof x==='string'))set(result,key,mergeSet(actual,before,after));
    else set(result,key,structuredClone(after));
  }
  return result;
}
const eventKey=e=>[e.trackID||e.trackId,e.kind||e.type,Math.round(e.at),e.seconds||0,e.ratio||0,e.mood||''].join('|');
const entityMap=(a,key=x=>x.id)=>Object.fromEntries((a||[]).map(x=>[key(x),x]));
function mergeEntities(current,base,incoming,key){return Object.values(mergeObjects(entityMap(current,key),entityMap(base,key),entityMap(incoming,key)));}
const rotationTimes=value=>Object.fromEntries(Object.entries(value&&typeof value==='object'&&!Array.isArray(value)?value:{}).slice(0,20000).filter(([id,at])=>validID(id)&&Number.isFinite(at)&&at>0));
const mergeRotation=(a={},b={})=>Object.fromEntries([...new Set([...Object.keys(a),...Object.keys(b)])].map(id=>[id,Math.max(a[id]||0,b[id]||0)]));
const extraSettings=['excludedGenres','preferredArtists','artistDiversity','genreMode','energy','vocals','includeLibrary','playlistSource','explorationStyle','languagePreference','skipSensitivity','sessionInfluence','recommendationVersion'];
export function sanitizePortable(doc){
  if(!doc||doc.version!==1||!doc.tracks||typeof doc.tracks!=='object'||Array.isArray(doc.tracks)||!Array.isArray(doc.likedIDs)||!Array.isArray(doc.playlists)||!Array.isArray(doc.events))throw new Error('Несовместимая библиотека');
  const tracks=Object.create(null);
  for(const [id,t] of Object.entries(doc.tracks).slice(0,6000))if(validID(id)&&t?.videoID===id)set(tracks,id,{videoID:id,title:text(t.title),artist:text(t.artist),...(typeof t.artistID==='string'&&/^UC[\w-]{10,80}$/.test(t.artistID)?{artistID:t.artistID}:{}),duration:clamp(t.duration,0,86400,0),...(typeof t.artworkURL==='string'&&/^https:\/\//.test(t.artworkURL)?{artworkURL:t.artworkURL.slice(0,2000)}:{}),genres:list(t.genres,40),moodHints:list(t.moodHints,20),relatedTo:list(t.relatedTo,100).filter(validID),directRelatedTo:list(t.directRelatedTo,100).filter(validID),discoveryLanguages:list(t.discoveryLanguages,5),genre:text(t.genre,80),...(validateGenreEvidence(t.genreEvidence)?{genreEvidence:validateGenreEvidence(t.genreEvidence)}:{}),mood:text(t.mood,40),tags:list(t.tags,30),language:text(t.language,20),...(validateSoundProfile(t.soundProfile)?{soundProfile:validateSoundProfile(t.soundProfile)}:{})});
  const s=doc.settings||{};
  return {version:1,tracks,familiarPlays:rotationTimes(doc.familiarPlays),likedIDs:list(doc.likedIDs).filter(validID),hiddenIDs:list(doc.hiddenIDs).filter(validID),dislikedIDs:list(doc.dislikedIDs,6000).filter(validID),playlists:[...new Map(doc.playlists.slice(0,300).filter(p=>p&&text(p.id)&&typeof p.name==='string'&&Array.isArray(p.trackIDs)).map(p=>[text(p.id),{id:text(p.id),name:text(p.name,100),trackIDs:list(p.trackIDs).filter(validID)}])).values()],events:doc.events.slice(-3000).filter(e=>e&&validID(e.trackID)&&['play','listen','skip','error','like','playlist-add','dislike'].includes(e.kind)&&Number.isFinite(e.at)&&Number.isFinite(e.seconds)&&e.seconds>=0).map(e=>({trackID:e.trackID,kind:e.kind,at:Math.round(e.at),seconds:clamp(e.seconds,0,86400,0),ratio:clamp(e.ratio,0,1,0),...(validContext(e.recommendation)?{recommendation:structuredClone(e.recommendation)}:{}),...(typeof e.surface==='string'?{surface:text(e.surface,40)}:{}),...(typeof e.newArtist==='boolean'?{newArtist:e.newArtist}:{}),...(typeof e.mood==='string'?{mood:text(e.mood,30)}:{})})),settings:{genres:list(s.genres,40),excludedArtists:list(s.excludedArtists,40),excludedGenres:list(s.excludedGenres,40),preferredArtists:list(s.preferredArtists,40),seedPlaylistIDs:list(s.seedPlaylistIDs,300),discovery:clamp(s.discovery,0,1,.35),repeatHours:clamp(s.repeatHours,0,24,2),artistDiversity:clamp(s.artistDiversity,0,1,.6),mood:text(s.mood,30)||'any',genreMode:s.genreMode==='strict'?'strict':'prefer',energy:['low','medium','high'].includes(s.energy)?s.energy:'any',vocals:['instrumental','vocal'].includes(s.vocals)?s.vocals:'any',includeLibrary:s.includeLibrary!==false,playlistSource:s.playlistSource==='selected'?'selected':'all',explorationStyle:['nearby','balanced','adventurous'].includes(s.explorationStyle)?s.explorationStyle:'nearby',languagePreference:['ru','en','any'].includes(s.languagePreference)?s.languagePreference:'ru',skipSensitivity:s.skipSensitivity==='soft'?'soft':'strict',sessionInfluence:clamp(s.sessionInfluence,0,1,.65),recommendationVersion:2}};
}
export function portableLibrary(state){
  const tracks=Object.create(null),id=x=>String(x).replace(/^yt_/,'');
  for(const t of Object.values(state.tracks||{}))if(t?.source==='youtube'&&validID(t.videoId))set(tracks,t.videoId,{videoID:t.videoId,title:t.title,artist:t.artist,...(/^yt_UC[\w-]{10,80}$/.test(t.artistId||'')?{artistID:t.artistId.slice(3)}:{}),duration:t.duration||0,...(t.artwork?{artworkURL:t.artwork}:{}),genres:t.discoveryGenres?.length?t.discoveryGenres:t.genre?[t.genre]:[],moodHints:[...(t.discoveryMoods||[]),...(t.discoveryEnergy||[]).map(x=>'energy:'+x),...(t.discoveryVocals||[]).map(x=>'vocals:'+x)],relatedTo:(t.relatedTo||[]).map(id),directRelatedTo:(t.directRelatedTo||[]).map(id),discoveryLanguages:t.discoveryLanguages||[],genre:t.genre||'',genreEvidence:t.genreEvidence,mood:t.mood||'',tags:t.tags||[],language:t.language||'',soundProfile:t.soundProfile});
  const s=state.settings||{};
  return sanitizePortable({version:1,tracks,familiarPlays:Object.fromEntries(Object.entries(state.familiarPlays||{}).map(([key,at])=>[id(key),at])),likedIDs:(state.likes||[]).map(id),hiddenIDs:(state.hidden||[]).map(id),dislikedIDs:(state.dislikes||[]).map(id),playlists:(state.playlists||[]).map(p=>({id:p.id,name:p.name,trackIDs:p.trackIds.map(id)})),events:(state.events||[]).filter(e=>['play','listen','skip','error','like','playlist-add','dislike'].includes(e.type)).map(e=>({trackID:id(e.trackId),kind:e.type,at:e.at,seconds:e.seconds||0,ratio:e.ratio||0,recommendation:e.recommendation,surface:e.surface,...(validContext(e.recommendation)?{recommendation:structuredClone(e.recommendation)}:{}),...(typeof e.surface==='string'?{surface:text(e.surface,40)}:{}),...(typeof e.newArtist==='boolean'?{newArtist:e.newArtist}:{}),...(e.mood?{mood:e.mood}:{})})),settings:{...Object.fromEntries(extraSettings.map(k=>[k,s[k]])),seedPlaylistIDs:s.seedPlaylistIds||[],genres:s.genres||[],excludedArtists:s.blockedArtists||[],discovery:s.discovery??.35,repeatHours:s.repeatCooldown??2,mood:s.mood||'any'}});
}
export function mergePortable(current,base,incoming){
  current=sanitizePortable(current);incoming=sanitizePortable(incoming);if(base)base=sanitizePortable(base);
  return sanitizePortable({version:1,familiarPlays:mergeRotation(current.familiarPlays,incoming.familiarPlays),tracks:mergeObjects(current.tracks,base?.tracks,incoming.tracks),likedIDs:mergeSet(current.likedIDs,base?.likedIDs,incoming.likedIDs),hiddenIDs:mergeSet(current.hiddenIDs,base?.hiddenIDs,incoming.hiddenIDs),dislikedIDs:mergeSet(current.dislikedIDs,base?.dislikedIDs,incoming.dislikedIDs),playlists:mergeEntities(current.playlists,base?.playlists,incoming.playlists),events:mergeEntities(current.events,base?.events,incoming.events,eventKey).sort((a,b)=>a.at-b.at).slice(-3000),settings:base?mergeObjects(current.settings,base.settings,incoming.settings):current.settings});
}
export function applyPortable(state,doc){
  const next=structuredClone(state),id=x=>'yt_'+x,isYouTube=x=>next.tracks[x]?.source==='youtube'||String(x).startsWith('yt_')&&validID(String(x).slice(3));
  for(const t of Object.values(doc.tracks))set(next.tracks,id(t.videoID),{...next.tracks[id(t.videoID)],id:id(t.videoID),source:'youtube',videoId:t.videoID,title:t.title,artist:t.artist,...(t.artistID?{artistId:'yt_'+t.artistID}:{}),duration:t.duration,artwork:t.artworkURL||'',discoveryGenres:t.genres,discoveryMoods:t.moodHints.filter(x=>!x.startsWith('energy:')&&!x.startsWith('vocals:')),discoveryEnergy:t.moodHints.filter(x=>x.startsWith('energy:')).map(x=>x.slice(7)),discoveryVocals:t.moodHints.filter(x=>x.startsWith('vocals:')).map(x=>x.slice(7)),relatedTo:t.relatedTo.map(id),directRelatedTo:t.directRelatedTo.map(id),discoveryLanguages:t.discoveryLanguages,genre:t.genre,genreEvidence:t.genreEvidence||next.tracks[id(t.videoID)]?.genreEvidence||null,mood:t.mood,tags:t.tags,language:t.language,soundProfile:t.soundProfile||next.tracks[id(t.videoID)]?.soundProfile||null});
  next.familiarPlays={...next.familiarPlays,...Object.fromEntries(Object.entries(doc.familiarPlays||{}).map(([key,at])=>[id(key),Math.max(next.familiarPlays?.[id(key)]||0,at)]))};
  next.likes=[...(next.likes||[]).filter(x=>!isYouTube(x)),...doc.likedIDs.map(id)];
  next.dislikes=[...(next.dislikes||[]).filter(x=>!isYouTube(x)),...(doc.dislikedIDs||[]).map(id)];
  next.likes=next.likes.filter(x=>!next.dislikes.includes(x));
  next.hidden=[...(next.hidden||[]).filter(x=>!isYouTube(x)),...doc.hiddenIDs.map(id)];
  const playlists=new Map(doc.playlists.map(p=>[p.id,p]));
  next.playlists=next.playlists.filter(p=>playlists.has(p.id)||p.trackIds.some(x=>!isYouTube(x))).map(p=>{
    const incoming=playlists.get(p.id);playlists.delete(p.id);return {...p,...(incoming?{name:incoming.name}:{}),trackIds:[...p.trackIds.filter(x=>!isYouTube(x)),...(incoming?.trackIDs||[]).map(id)]};
  });
  next.playlists.push(...[...playlists.values()].map(p=>({id:p.id,name:p.name,trackIds:p.trackIDs.map(id),createdAt:Date.now()})));
  const metadata=new Map(next.events.map(e=>[eventKey({...e,trackId:String(e.trackId).replace(/^yt_/, '')}),e]));
  next.events=[...(next.events||[]).filter(e=>!isYouTube(e.trackId)||!['play','listen','skip','error','like','playlist-add','dislike'].includes(e.type)),...doc.events.map(e=>({...metadata.get(eventKey(e)),trackId:id(e.trackID),type:e.kind,at:e.at,seconds:e.seconds,ratio:e.ratio,recommendation:e.recommendation||metadata.get(eventKey(e))?.recommendation,surface:e.surface||metadata.get(eventKey(e))?.surface||'sync',...(validContext(e.recommendation)?{recommendation:structuredClone(e.recommendation)}:{}),...(typeof e.surface==='string'?{surface:text(e.surface,40)}:{}),...(typeof e.newArtist==='boolean'?{newArtist:e.newArtist}:{}),...(e.mood?{mood:e.mood}:{})}))].sort((a,b)=>a.at-b.at).slice(-3000);
  next.settings={...next.settings,...Object.fromEntries(extraSettings.map(k=>[k,doc.settings[k]])),seedPlaylistIds:doc.settings.seedPlaylistIDs,genres:doc.settings.genres,blockedArtists:doc.settings.excludedArtists,discovery:doc.settings.discovery,repeatCooldown:doc.settings.repeatHours,mood:doc.settings.mood};return next;
}
// Apply only a renderer's changes when a phone has updated the disk concurrently.
export function mergeDesktop(current,base,incoming){const next=mergeObjects(current,base||{},incoming);next.playlists=mergeEntities(current.playlists,base?.playlists,incoming.playlists);next.familiarPlays=mergeRotation(current.familiarPlays,incoming.familiarPlays);next.events=mergeEntities(current.events,base?.events,incoming.events,eventKey).sort((a,b)=>a.at-b.at).slice(-3000);return next;}
