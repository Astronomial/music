// Likes are stored oldest-first for compatibility with desktop/iOS sync.
// History supplies real timestamps after a merge; older profiles fall back to
// the stored insertion order. Never mutate likes or the playlist queue here.
export function likedTracksNewestFirst(state) {
  const dates=new Map();
  for(const e of state.events||[])if(e.type==='like'&&Number.isFinite(e.at))dates.set(e.trackId,Math.max(dates.get(e.trackId)||0,e.at));
  return state.likes.map((id,index)=>({track:state.tracks[id],index,at:dates.get(id)||0}))
    .filter(x=>x.track).sort((a,b)=>b.at-a.at||b.index-a.index).map(x=>x.track);
}

export function retireLegacyCatalog(state) {
  const {apiKey,...settings}=state.settings||{};
  return {...state,settings:{...settings,provider:'youtube'}};
}
