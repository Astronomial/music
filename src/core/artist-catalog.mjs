import {normalizeText,normalizeArtist} from './search.mjs';
import {normalizeTrack} from './model.mjs';
export function artistFromTrack(track){return {id:track.artistId||'name_'+normalizeText(track.artist),name:track.artist||'Исполнитель',picture:''};}
export async function artistTracks(artist,request,{tracks=[],offline=false,offset=0,signal}={}){
  signal?.throwIfAborted();
  const local=tracks.filter(t=>(Boolean(artist.id)&&t.artistId===artist.id)||normalizeText(t.artist)===normalizeText(artist.name));
  if(offline)return {tracks:local,hasMore:false};
  let id=artist.id;
  if(!/^yt_UC[\w-]{10,80}$/.test(id)){
    try{const artists=await request('/users/search',{query:artist.name});signal?.throwIfAborted();id=artists.map(normalizeArtist).find(a=>normalizeText(a.name)===normalizeText(artist.name))?.id;}catch{signal?.throwIfAborted();}
  }
  let raw;
  try{if(id)raw=await request(`/users/${id}/tracks`,{offset,limit:40});}catch{}
  if(!raw?.length)raw=await request('/tracks/search',{query:artist.name,offset,sort_method:'popular'});
  signal?.throwIfAborted();
  return {tracks:[...new Map([...local,...raw.map(normalizeTrack)].filter(t=>t.streamable&&(id&&t.artistId===id||normalizeText(t.artist)===normalizeText(artist.name))).map(t=>[t.id,t])).values()],hasMore:Boolean(raw.hasMore)};
}
