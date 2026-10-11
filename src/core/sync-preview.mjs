import {sanitizePortable} from './sync.mjs';
export function stableJSON(value){
  if(Array.isArray(value))return '['+value.map(stableJSON).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableJSON(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export function summarizeChanges(before,after){
  before=sanitizePortable(before);after=sanitizePortable(after);
  const added=(a,b)=>b.filter(x=>!a.includes(x)),removed=(a,b)=>added(b,a),same=(a,b)=>stableJSON(a)===stableJSON(b);
  const oldPlaylists=new Map(before.playlists.map(p=>[p.id,p])),newPlaylists=new Map(after.playlists.map(p=>[p.id,p]));
  const changes={likesAdded:added(before.likedIDs,after.likedIDs).length,likesRemoved:removed(before.likedIDs,after.likedIDs).length,dislikesAdded:added(before.dislikedIDs,after.dislikedIDs).length,dislikesRemoved:removed(before.dislikedIDs,after.dislikedIDs).length,hiddenAdded:added(before.hiddenIDs,after.hiddenIDs).length,hiddenRemoved:removed(before.hiddenIDs,after.hiddenIDs).length,playlistsAdded:after.playlists.filter(p=>!oldPlaylists.has(p.id)).length,playlistsRemoved:before.playlists.filter(p=>!newPlaylists.has(p.id)).length,playlistsChanged:after.playlists.filter(p=>oldPlaylists.has(p.id)&&!same(oldPlaylists.get(p.id),p)).length,tracksAdded:Object.keys(after.tracks).filter(id=>!Object.hasOwn(before.tracks,id)).length,settingsChanged:Object.keys(after.settings).filter(k=>!same(before.settings[k],after.settings[k])).length,soundProfilesChanged:Object.keys(after.tracks).filter(id=>!same(before.tracks[id]?.soundProfile||null,after.tracks[id].soundProfile||null)).length,historyAdded:0,historyRemoved:0,details:[]};
  const eventKey=e=>[e.trackID,e.kind,e.at,e.seconds,e.ratio,e.mood||''].join('|'),oldEvents=new Set(before.events.map(eventKey)),newEvents=new Set(after.events.map(eventKey));
  changes.historyAdded=after.events.filter(e=>!oldEvents.has(eventKey(e))).length;changes.historyRemoved=before.events.filter(e=>!newEvents.has(eventKey(e))).length;
  const title=id=>{const t=after.tracks[id]||before.tracks[id];return t?`${t.artist} — ${t.title}`:id;};
  for(const [label,ids] of [['Лайк',added(before.likedIDs,after.likedIDs)],['Снять лайк',removed(before.likedIDs,after.likedIDs)],['Дизлайк',added(before.dislikedIDs,after.dislikedIDs)],['Снять дизлайк',removed(before.dislikedIDs,after.dislikedIDs)]])for(const id of ids.slice(0,3))changes.details.push(`${label}: ${title(id)}`);
  for(const p of after.playlists)if(!same(oldPlaylists.get(p.id),p))changes.details.push(`${oldPlaylists.has(p.id)?'Изменить':'Добавить'} плейлист: ${p.name}`);
  for(const p of before.playlists)if(!newPlaylists.has(p.id))changes.details.push(`Удалить плейлист: ${p.name}`);
  changes.details=changes.details.slice(0,10);return changes;
}
