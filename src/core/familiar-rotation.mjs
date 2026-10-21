// Rotation is independent of taste strength. A low-weight favourite deserves
// the same chance in a familiar slot as the model's highest-scoring favourite.
export function familiarIDs(state,context=null){
  if(context?.trackId)return new Set([context.trackId]);
  if(context?.playlistId)return new Set(state.playlists.find(p=>p.id===context.playlistId)?.trackIds||[]);
  return new Set([...state.likes,...state.playlists.flatMap(p=>p.trackIds)]);
}
export function familiarRotation(state,now=Date.now()){
  const times=new Map(Object.entries(state.familiarPlays||{}).filter(([,at])=>Number.isFinite(at)&&at>0&&at<=now));
  // Upgrade old libraries without discarding their playback history.
  for(const event of state.events)if(event.type==='play'&&event.at<=now)times.set(event.trackId,Math.max(times.get(event.trackId)||0,event.at));
  return times;
}
export function rotationNoise(id,seed){
  let hash=seed|0;for(const c of id)hash=Math.imul(hash^c.charCodeAt(0),16777619);
  return (hash>>>0)/4294967295;
}
export function compareFamiliar(a,b,times,seed){
  return (times.get(a)||0)-(times.get(b)||0)||rotationNoise(a,seed)-rotationNoise(b,seed)||a.localeCompare(b);
}
