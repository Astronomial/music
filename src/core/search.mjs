import { normalizeTrack } from './model.mjs';

export function normalizeText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
export function textSimilarity(a,b) {
  a=normalizeText(a); b=normalizeText(b);
  if(!a||!b)return 0;
  if(a===b)return 1;
  const tokens=s=>new Set(s.split(' '));
  const aa=tokens(a),bb=tokens(b),intersection=[...aa].filter(t=>bb.has(t)).length;
  const tokenScore=2*intersection/(aa.size+bb.size);
  const grams=s=>{const m=new Map();for(let i=0;i<s.length-1;i++){const g=s.slice(i,i+2);m.set(g,(m.get(g)||0)+1);}return m;};
  const ga=grams(a),gb=grams(b);let same=0;
  for(const [g,n]of ga)same+=Math.min(n,gb.get(g)||0);
  const dice=a.length+b.length>2?2*same/(a.length+b.length-2):0;
  return Math.max(tokenScore,dice);
}
function fieldScore(field,query) {
  const f=normalizeText(field),q=normalizeText(query);
  if(!f||!q)return 0;
  if(f===q)return 1;
  if(f.startsWith(q))return 0.94;
  if(f.includes(q))return 0.87;
  const words=q.split(' '),coverage=words.filter(w=>f.split(' ').some(x=>x.startsWith(w))).length/words.length;
  return Math.max(coverage*0.78,textSimilarity(f,q)*0.63);
}
export function trackSearchScore(track,query) {
  const title=fieldScore(track.title,query),artist=fieldScore(track.artist,query);
  return Math.max(title,artist*0.99,fieldScore(`${track.artist} ${track.title}`,query)*0.96);
}
export function normalizeArtist(user) {
  const picture=user.profile_picture || user.profilePicture || {};
  return {id:String(user.id),name:user.name || user.handle || 'Исполнитель',handle:user.handle || '',verified:Boolean(user.is_verified ?? user.isVerified),picture:typeof picture==='string'?picture:picture['480x480']||picture._480x480||'',trackCount:Number(user.track_count ?? user.trackCount)||0};
}
export function searchLocal(tracks,query) {
  const matches=tracks.map(t=>({t,score:trackSearchScore(t,query)})).filter(r=>r.score>=0.43).sort((a,b)=>b.score-a.score||b.t.favoriteCount-a.t.favoriteCount).map(r=>r.t);
  const artists=new Map();
  for(const t of tracks)if(t.artistId&&fieldScore(t.artist,query)>=0.43)artists.set(t.artistId,{id:t.artistId,name:t.artist,handle:'',picture:'',trackCount:tracks.filter(x=>x.artistId===t.artistId).length});
  return {tracks:matches,artists:[...artists.values()].sort((a,b)=>fieldScore(b.name,query)-fieldScore(a.name,query)),hasMore:false,partial:false};
}
export async function searchCatalog(query,request,{offset=0,localTracks=[],offline=false,signal}={}) {
  query=String(query).trim().slice(0,160);
  if(!query)return {tracks:[],artists:[],hasMore:false,partial:false};
  signal?.throwIfAborted();
  if(offline)return searchLocal(localTracks,query);
  const results=await Promise.allSettled([
    request('/tracks/search',{query,limit:40,offset,sort_method:'relevant'}),
    request('/users/search',{query,limit:12,offset:0,sort_method:'relevant'})
  ]);
  signal?.throwIfAborted();
  const [trackResult,artistResult]=results;
  if(results.every(r=>r.status==='rejected'))throw new Error('Поиск в каталоге временно недоступен. Попробуй ещё раз.');
  const artists=(artistResult.status==='fulfilled'?artistResult.value:[]).filter(a=>a.id).map(normalizeArtist).sort((a,b)=>fieldScore(b.name,query)-fieldScore(a.name,query));
  const remote=(trackResult.status==='fulfilled'?trackResult.value:[]).map(normalizeTrack).filter(t=>t.streamable);
  // Searching an artist must surface that artist's music even when the track API indexes titles only.
  const relevantArtists=artists.filter(a=>Math.max(fieldScore(a.name,query),fieldScore(a.handle,query))>=0.68).slice(0,2);
  const artistTracks=await Promise.allSettled(relevantArtists.map(a=>request(`/users/${a.id}/tracks`,{limit:40,offset,filter_tracks:'public',sort_method:'plays',sort_direction:'desc'})));
  signal?.throwIfAborted();
  const combined=new Map([...localTracks,...remote].map(t=>[t.id,t]));
  for(const result of artistTracks)if(result.status==='fulfilled')for(const raw of result.value){const t=normalizeTrack(raw);if(t.streamable)combined.set(t.id,t);}
  const tracks=[...combined.values()].map(t=>({t,score:trackSearchScore(t,query)})).filter(r=>r.score>=0.35).sort((a,b)=>b.score-a.score||(b.t.favoriteCount||0)-(a.t.favoriteCount||0)).map(r=>r.t);
  return {tracks,artists,hasMore:trackResult.status==='fulfilled'&&(trackResult.value.hasMore??remote.length===40)||artistTracks.some(r=>r.status==='fulfilled'&&(r.value.hasMore??r.value.length===40)),partial:results.some(r=>r.status==='rejected')};
}
