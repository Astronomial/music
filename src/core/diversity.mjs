import {fold} from './wave-settings.mjs';
const nameCache=new WeakMap();
const unknown=new Set(['','unknown','unknown artist','неизвестный исполнитель','исполнитель не указан']);
function names(track){
  if(nameCache.has(track))return nameCache.get(track);
  const name=fold(String(track.artist||'').replace(/\s*[-–]?\s*(?:-\s*)?Topic\s*$|VEVO\s*$/ig,''));
  if(unknown.has(name)){nameCache.set(track,[]);return [];}
  const result=String(track.artist).replace(/\s*-?\s*Topic\s*$|VEVO\s*$/ig,'').split(/\s*,\s*|\s+(?:feat\.?|ft\.?|featuring|with|&|x)\s+/i).map(fold).filter(n=>!unknown.has(n));
  nameCache.set(track,result);return result;
}
// Link channel/name aliases, while retaining separate identities for collaborators.
export function artistIndex(tracks){
  const parent=new Map();
  function root(key){if(!parent.has(key))parent.set(key,key);let result=key;while(parent.get(result)!==result)result=parent.get(result);while(parent.get(key)!==key){const next=parent.get(key);parent.set(key,result);key=next;}return result;}
  for(const track of tracks){const ns=names(track);if(ns.length&&track.artistId&&!/^name_/.test(track.artistId)){const name=root('name:'+ns[0]),id=root('id:'+track.artistId);if(name!==id)parent.set(id,name);}}
  return track=>{
    const ns=names(track),keys=ns.map(n=>root('name:'+n));
    if(!keys.length&&track.artistId&&!/unknown|неизвестный/i.test(track.artistId))keys.push(root('id:'+track.artistId));
    return [...new Set(keys.length?keys:['unknown:'+track.id])];
  };
}
export function recordingKey(track,keys){
  const title=fold(String(track.title||'').replace(/\s*[\[(](?:official\s*)?(?:music\s*)?(?:audio|video|lyrics?|visuali[sz]er|hd|hq)[\])]\s*/ig,' ').replace(/\s*[-–—|]\s*(?:official\s*)?(?:music\s*)?(?:audio|video|lyrics?|visuali[sz]er|hd|hq)\s*$/ig,''));
  return title&&title!=='без названия'?keys(track).slice().sort().join('|')+'::'+title:'id:'+track.id;
}
export function diversityHistory(state,now,keys,currentTrackId){
  // Started playback is exposure even if immediately skipped; failed requests and shelves are not.
  const plays=state.events.filter(e=>e.type==='play'&&now-e.at>=0&&now-e.at<=90*60000&&state.tracks[e.trackId]);
  const history=plays.slice(-12).map(e=>({track:state.tracks[e.trackId],newArtist:e.newArtist===true}));
  const current=state.tracks[currentTrackId];if(current&&history.at(-1)?.track.id!==current.id)history.push({track:current,newArtist:false});
  return history.slice(-12).map(({track:t,newArtist})=>({keys:keys(t),recording:recordingKey(t,keys),id:t.id,newArtist}));
}
export function familiarArtists(state,now,keys){
  const ids=new Set([...state.likes,...state.playlists.flatMap(p=>p.trackIds),...state.events.filter(e=>['play','listen','skip'].includes(e.type)&&now-e.at<=30*86400000).map(e=>e.trackId)]);
  return new Set([...ids].flatMap(id=>state.tracks[id]?keys(state.tracks[id]):[]));
}
export function artistSpacing(diversity){
  return {gap:diversity===0?0:Math.max(1,Math.round(1+diversity*4)),maxPerWindow:diversity>=.85?1:diversity>=.45?2:3,window:12};
}
