import {normalizeTrack} from './model.mjs';
import {buildProfile} from './recommender.mjs';
export async function collectYouTubeCandidates(state,request){
  const profile=buildProfile(state);
  const seeds=[...profile.weights].filter(([id,w])=>w>0&&state.tracks[id]?.source==='youtube').sort((a,b)=>b[1]-a[1]).slice(0,5).map(([id])=>state.tracks[id]);
  const jobs=seeds.map(t=>[`/related/${t.videoId}`,{}]);
  const fileArtists=[...profile.weights].filter(([id,w])=>w>0&&state.tracks[id]?.source!=='youtube').sort((a,b)=>b[1]-a[1]).map(([id])=>state.tracks[id]?.artist).filter(a=>a&&a!=='Неизвестный исполнитель');
  for(const artist of [...new Set(fileArtists)].slice(0,3))jobs.push(['/tracks/search',{query:artist}]);
  const genres=state.settings.genres.length?state.settings.genres.slice(0,3):['Pop','Alternative','Electronic'];
  // Search context is weaker evidence than an actual genre tag; do not invent metadata.
  for(const genre of [...new Set([...genres,'Ambient','House'])])jobs.push(['/tracks/search',{query:`${genre} music`,discoveryGenre:genre}]);
  const found=new Map();let successes=0;
  for(let i=0;i<jobs.length;i+=2){const batch=await Promise.allSettled(jobs.slice(i,i+2).map(([route,params])=>request(route,params)));for(let j=0;j<batch.length;j++){const r=batch[j];if(r.status==='fulfilled'){successes++;for(const raw of r.value){const t=normalizeTrack(raw),genre=jobs[i+j][1].discoveryGenre;if(t.streamable)found.set(t.id,{...t,relatedTo:[...new Set([...(found.get(t.id)?.relatedTo||[]),...t.relatedTo])],discoveryGenres:[...new Set([...(found.get(t.id)?.discoveryGenres||[]),...t.discoveryGenres,...(genre?[genre]:[])])]});}}}}
  if(!successes)throw new Error('YouTube не отвечает. Можно слушать локальные файлы или повторить загрузку каталога.');
  return [...found.values()];
}
