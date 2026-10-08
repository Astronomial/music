import {normalizeTrack} from './model.mjs';
import {selectRetrievalAnchors} from './recommender.mjs';
import {MOOD_MIXES} from './mood-mixes.mjs';
import {waveSettings,waveQuery,retrievalContext,matchesArtist} from './wave-settings.mjs';
export async function collectYouTubeCandidates(state,request){
  const settings=waveSettings(state.settings),anchors=selectRetrievalAnchors(state,{limit:12});
  const seeds=anchors.filter(t=>t.source==='youtube').slice(0,6);
  const jobs=seeds.map(t=>({route:`/related/${t.videoId}`,params:{},context:{relatedTo:[t.id],retrievalSources:['related']}}));
  const artists=[...new Set([...settings.preferredArtists,...anchors.filter(t=>t.source!=='youtube').map(t=>t.artist).filter(a=>a&&a!=='Неизвестный исполнитель')])];
  for(const artist of artists.filter(a=>!settings.blockedArtists.some(b=>matchesArtist({artist:a},b))).slice(0,6))jobs.push({route:'/tracks/search',params:{query:waveQuery(artist,settings)},context:{...retrievalContext(settings),retrievalSources:['artist']}});
  const genres=settings.genres.length?settings.genres:['Pop','Alternative','Electronic'];
  const directions=settings.genreMode==='strict'&&settings.genres.length?genres:[...new Set([...genres,'Ambient','House'])];
  const permitted=directions.filter(g=>!settings.excludedGenres.includes(g));
  for(const genre of permitted)jobs.push({route:'/tracks/search',params:{query:waveQuery(genre,settings)},context:{...retrievalContext(settings,genre),retrievalSources:['genre']}});
  for(const mix of MOOD_MIXES){
    const preferred=permitted.filter(g=>mix.context.genres.includes(g));
    const genre=preferred[0]||permitted[0]||'';
    const moodSettings={...settings,mood:mix.context.mood==='night'?'calm':mix.context.mood,energy:mix.context.energy||'any',vocals:mix.context.vocals||'any'};
    jobs.push({route:'/tracks/search',params:{query:mix.id==='night'?`${genre} late night music`:waveQuery(genre,moodSettings)},context:{...retrievalContext(moodSettings,genre),discoveryMoods:[mix.context.mood],retrievalSources:['mood']}});
  }
  if(!jobs.length)jobs.push({route:'/tracks/search',params:{query:waveQuery('',settings)},context:retrievalContext(settings)});
  const found=new Map();let successes=0;
  for(let i=0;i<jobs.length;i+=2){
    const batch=await Promise.allSettled(jobs.slice(i,i+2).map(({route,params})=>request(route,params)));
    for(let j=0;j<batch.length;j++){
      const result=batch[j];if(result.status!=='fulfilled')continue;successes++;
      for(const raw of result.value){
        const t=normalizeTrack(raw);if(!t.streamable)continue;
        const merged={...t};
        for(const key of ['relatedTo','discoveryGenres','discoveryMoods','discoveryEnergy','discoveryVocals','retrievalSources'])merged[key]=[...new Set([...(found.get(t.id)?.[key]||[]),...(t[key]||[]),...(jobs[i+j].context[key]||[])])];
        found.set(t.id,merged);
      }
    }
  }
  if(!successes)throw new Error('YouTube не отвечает. Можно слушать локальные файлы или повторить загрузку каталога.');
  return [...found.values()];
}
