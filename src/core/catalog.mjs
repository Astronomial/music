import {normalizeTrack} from './model.mjs';
import {buildProfile} from './recommender.mjs';
import {waveSettings,waveQuery,retrievalContext,blockedByPreferences,matchesArtist} from './wave-settings.mjs';
export async function collectYouTubeCandidates(state,request){
  const settings=waveSettings(state.settings),profile=buildProfile(state);
  const anchors=[...profile.weights].filter(([id,w])=>w>0&&state.tracks[id]&&!blockedByPreferences(state.tracks[id],settings)).sort((a,b)=>b[1]-a[1]).map(([id])=>state.tracks[id]);
  const seeds=anchors.filter(t=>t.source==='youtube').slice(0,5);
  const jobs=seeds.map(t=>({route:`/related/${t.videoId}`,params:{},context:{}}));
  const artists=[...new Set([...settings.preferredArtists,...anchors.filter(t=>t.source!=='youtube').map(t=>t.artist).filter(a=>a&&a!=='Неизвестный исполнитель')])];
  for(const artist of artists.filter(a=>!settings.blockedArtists.some(b=>matchesArtist({artist:a},b))).slice(0,6))jobs.push({route:'/tracks/search',params:{query:waveQuery(artist,settings)},context:retrievalContext(settings)});
  const genres=settings.genres.length?settings.genres:['Pop','Alternative','Electronic'];
  const directions=settings.genreMode==='strict'&&settings.genres.length?genres:[...new Set([...genres,'Ambient','House'])];
  for(const genre of directions.filter(g=>!settings.excludedGenres.includes(g)))jobs.push({route:'/tracks/search',params:{query:waveQuery(genre,settings)},context:retrievalContext(settings,genre)});
  if(!jobs.length)jobs.push({route:'/tracks/search',params:{query:waveQuery('',settings)},context:retrievalContext(settings)});
  const found=new Map();let successes=0;
  for(let i=0;i<jobs.length;i+=2){
    const batch=await Promise.allSettled(jobs.slice(i,i+2).map(({route,params})=>request(route,params)));
    for(let j=0;j<batch.length;j++){
      const result=batch[j];if(result.status!=='fulfilled')continue;successes++;
      for(const raw of result.value){
        const t=normalizeTrack(raw);if(!t.streamable)continue;
        const merged={...t};
        for(const key of ['relatedTo','discoveryGenres','discoveryMoods','discoveryEnergy','discoveryVocals'])merged[key]=[...new Set([...(found.get(t.id)?.[key]||[]),...(t[key]||[]),...(jobs[i+j].context[key]||[])])];
        found.set(t.id,merged);
      }
    }
  }
  if(!successes)throw new Error('YouTube не отвечает. Можно слушать локальные файлы или повторить загрузку каталога.');
  return [...found.values()];
}
