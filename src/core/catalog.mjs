import {normalizeTrack} from './model.mjs';
import {selectRetrievalAnchors,playlistSeedState,rankTracks} from './recommender.mjs';
import {artistIndex} from './diversity.mjs';
import {MOOD_MIXES} from './mood-mixes.mjs';
import {waveSettings,waveQuery,retrievalContext,matchesArtist,genresOf,blockedByPreferences} from './wave-settings.mjs';
export async function collectYouTubeCandidates(state,request,{context=null,onBatch,round=0}={}){
  const source=playlistSeedState(state,context),settings=waveSettings(state.settings),anchors=selectRetrievalAnchors(source,{limit:12});
  const seeds=anchors.filter(t=>t.source==='youtube').slice(0,6);
  const language=settings.languagePreference;
  const regionalQuery=query=>language==='ru'?`${query} русская музыка`:language==='en'?`${query} english songs`:query;
  const languageContext=language==='any'?{}:{discoveryLanguages:[language]};
  const jobs=seeds.map(t=>({route:`/related/${t.videoId}`,params:{},context:{relatedTo:[t.id],directRelatedTo:[t.id],retrievalSources:['related']}}));
  const artists=[...new Set([...settings.preferredArtists,...anchors.filter(t=>context?.playlistId||t.source!=='youtube').map(t=>t.artist).filter(a=>a&&a!=='Неизвестный исполнитель')])];
  for(const artist of artists.filter(a=>!settings.blockedArtists.some(b=>matchesArtist({artist:a},b))).slice(0,6))jobs.push({route:'/tracks/search',params:{query:waveQuery(artist,settings)},context:{...retrievalContext(settings),retrievalSources:['artist']}});
  const playlistGenres=context?.playlistId?[...new Set(anchors.flatMap(t=>genresOf(t).values))]:[];
  const genres=playlistGenres.length?playlistGenres:settings.genres.length?settings.genres:['Pop','Alternative','Electronic'];
  const directions=settings.genreMode==='strict'||settings.explorationStyle==='nearby'?genres:[...new Set([...genres,'Ambient','House'])];
  const permitted=directions.filter(g=>!settings.excludedGenres.includes(g));
  for(const genre of permitted){
    if(language!=='any')jobs.push({route:'/tracks/search',params:{query:regionalQuery(waveQuery(genre,settings))},context:{...retrievalContext(settings,genre),...languageContext,retrievalSources:['genre-language']}});
    jobs.push({route:'/tracks/search',params:{query:waveQuery(genre,settings)},context:{...retrievalContext(settings,genre),retrievalSources:['genre']}});
  }
  for(const mix of context?.playlistId?[]:MOOD_MIXES){
    const preferred=permitted.filter(g=>mix.context.genres.includes(g));
    const genre=preferred[0]||permitted[0]||'';
    const moodSettings={...settings,mood:mix.context.mood==='night'?'calm':mix.context.mood,energy:mix.context.energy||'any',vocals:mix.context.vocals||'any'};
    jobs.push({route:'/tracks/search',params:{query:regionalQuery(mix.id==='night'?`${genre} late night music`:waveQuery(genre,moodSettings))},context:{...retrievalContext(moodSettings,genre),...languageContext,discoveryMoods:[mix.context.mood],retrievalSources:['mood']}});
  }
  for(const genre of permitted.slice(0,2))jobs.push({route:'/tracks/search',params:{query:regionalQuery(waveQuery(genre,settings)),offset:40*(1+(Math.max(0,round)%3))},context:{...retrievalContext(settings,genre),...languageContext,retrievalSources:['discovery-page']}});
  if(!jobs.length)jobs.push({route:'/tracks/search',params:{query:waveQuery('',settings)},context:retrievalContext(settings)});
  const found=new Map();let successes=0;
  let expanded=false;
  for(let i=0;i<jobs.length;i+=2){
    const batch=await Promise.allSettled(jobs.slice(i,i+2).map(({route,params})=>request(route,params)));
    const batchTracks=[];
    for(let j=0;j<batch.length;j++){
      const result=batch[j];if(result.status!=='fulfilled')continue;successes++;
      for(const raw of result.value){
        const t=normalizeTrack(raw);if(!t.streamable)continue;
        const merged={...t};
        for(const key of ['relatedTo','directRelatedTo','discoveryGenres','discoveryMoods','discoveryEnergy','discoveryVocals','discoveryLanguages','retrievalSources'])merged[key]=[...new Set([...(found.get(t.id)?.[key]||[]),...(t[key]||[]),...(jobs[i+j].context[key]||[])])];
        found.set(t.id,merged);batchTracks.push(merged);
      }
    }
    if(batchTracks.length)onBatch?.(batchTracks);
    if(!expanded&&i+2>=seeds.length){
      expanded=true;
      const keys=artistIndex([...Object.values(source.tracks),...found.values()]);
      const seedArtists=new Set(anchors.flatMap(keys)),seenArtists=new Set(),requested=new Set(seeds.map(t=>t.videoId));
      const bridges=[...found.values()].filter(t=>t.source==='youtube'&&t.relatedTo?.some(id=>seeds.some(s=>s.id===id))&&!source.hidden.includes(t.id)&&!blockedByPreferences(t,settings));
      const ordered=rankTracks(bridges,source,{limit:12,context,exclude:source.likes}).map(r=>r.track);
      for(const bridge of ordered){
        const artists=keys(bridge);
        if(requested.has(bridge.videoId)||artists.some(k=>seedArtists.has(k)||seenArtists.has(k)))continue;
        for(const key of artists)seenArtists.add(key);requested.add(bridge.videoId);
        jobs.push({route:`/related/${bridge.videoId}`,params:{},context:{relatedTo:[bridge.id,...bridge.relatedTo],directRelatedTo:[bridge.id],discoveryGenres:genresOf(bridge).values,retrievalSources:['discovery-related']}});
        if(requested.size-seeds.length>=3)break;
      }
    }
  }
  if(!successes)throw new Error('YouTube не отвечает. Можно слушать локальные файлы или повторить загрузку каталога.');
  return [...found.values()];
}
