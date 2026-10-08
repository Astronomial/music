// The canonical address was supplied by the user's own Yandex embed code.
export const REQUESTED_PLAYLIST={id:'astronomial-favorites',name:'Мне нравится · Яндекс',sourceURL:'https://music.yandex.ru/playlists/lk.7658af97-0bd8-43ef-a8ed-85f39757d258',canonicalURL:'https://music.yandex.ru/users/Astronomial/playlists/3'};
export function ensureRequestedPlaylist(state){
  if(state.importRequests?.some(r=>r.id===REQUESTED_PLAYLIST.id))return state;
  const imported=state.playlists.some(p=>[REQUESTED_PLAYLIST.sourceURL,REQUESTED_PLAYLIST.canonicalURL].includes(p.sourceURL));
  return {...state,importRequests:[...(state.importRequests||[]),{...REQUESTED_PLAYLIST,status:imported?'complete':'pending'}]};
}
