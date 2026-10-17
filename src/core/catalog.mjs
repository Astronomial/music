import {sameSong} from './track-pulse.mjs';
import {tasteGenres,discoveryQuery} from './discovery-search.mjs';
import {normalizeTrack} from './model.mjs';
import {selectRetrievalAnchors,playlistSeedState,rankTracks} from './recommender.mjs';
import {artistIndex} from './diversity.mjs';
import {MOOD_MIXES,moodSeedQuery} from './mood-mixes.mjs';
import {waveSettings,waveQuery,retrievalContext,matchesArtist,genresOf,blockedByPreferences} from './wave-settings.mjs';
export async function collectYouTubeCandidates(state,request,{context=null,onBatch,round=0}={}){
  if(context?.trackId){
    const seed=state.tracks[context.trackId];if(!seed?.videoId)return [];
    const first=(await request('/related/'+seed.videoId,{})).map(raw=>{const t=normalizeTrack(raw);return {...t,relatedTo:[...new Set([...t.relatedTo,seed.id])],directRelatedTo:[...new Set([...t.directRelatedTo,seed.id])]};});onBatch?.(first);
    const branches=first.filter(t=>t.videoId&&!sameSong(t,seed)).slice(0,3);
    const extra=await Promise.allSettled(branches.map(t=>request('/related/'+t.videoId,{})));
    const found=new Map(first.map(t=>[t.id,t]));
    for(const result of extra)if(result.status==='fulfilled')for(const raw of result.value){const t=normalizeTrack(raw);if(!found.has(t.id))found.set(t.id,{...t,relatedTo:[...new Set([...t.relatedTo,seed.id])]});}
    const all=[...found.values()];onBatch?.(all);return all;
  }
  const source=playlistSeedState(state,context),settings=waveSettings(state.settings),anchors=selectRetrievalAnchors(source,{limit:12});
  const seeds=anchors.filter(t=>t.source==='youtube').slice(0,6);
  const language=settings.languagePreference;
  const languageContext=language==='any'?{}:{discoveryLanguages:[language]};
  const jobs=seeds.map(t=>({route:`/related/${t.videoId}`,params:{},context:{relatedTo:[t.id],directRelatedTo:[t.id],retrievalSources:['related']}}));
  const artists=[...new Set([...settings.preferredArtists,...anchors.filter(t=>!source.hidden.includes(t.id)&&!source.dislikes?.includes(t.id)&&!blockedByPreferences(t,settings)).map(t=>t.artist).filter(a=>a&&a!=='Неизвестный исполнитель')])].filter(a=>!settings.blockedArtists.some(b=>matchesArtist({artist:a},b)));
  for(const artist of artists.filter(a=>!settings.blockedArtists.some(b=>matchesArtist({artist:a},b))).slice(0,6))jobs.push({route:'/tracks/search',params:{query:discoveryQuery('',settings,artist)},context:{...retrievalContext(settings),retrievalSources:['artist']}});
  const directions=tasteGenres(anchors,settings);
  const permitted=directions.filter(g=>!settings.excludedGenres.includes(g));
  for(const genre of permitted){
    if(language!=='any')jobs.push({route:'/tracks/search',params:{query:discoveryQuery(genre,settings)},context:{...retrievalContext(settings,genre),...languageContext,retrievalSources:['genre-language']}});
    if(language!=='ru'||permitted.indexOf(genre)<2)jobs.push({route:'/tracks/search',params:{query:waveQuery(genre,settings)},context:{...retrievalContext(settings,genre),retrievalSources:['genre']}});
  }
  for(const mix of context?.playlistId?[]:MOOD_MIXES){
    const preferred=permitted.filter(g=>mix.context.genres.includes(g));
    const genre=preferred[0]||permitted[0]||'';
    const moodSettings={...settings,mood:mix.context.mood,energy:mix.context.energy||'any',vocals:mix.context.vocals||'any'};
    jobs.push({route:'/tracks/search',params:{query:discoveryQuery(genre,moodSettings,artists[MOOD_MIXES.indexOf(mix)%Math.max(1,artists.length)]||'')},context:{...retrievalContext(moodSettings,genre),...languageContext,discoveryMoods:[mix.context.mood],retrievalSources:['mood']}});
  }
  for(const genre of permitted.slice(0,2))jobs.push({route:'/tracks/search',params:{query:discoveryQuery(genre,settings),offset:40*(1+(Math.max(0,round)%3))},context:{...retrievalContext(settings,genre),...languageContext,retrievalSources:['discovery-page']}});
  if(!jobs.length)jobs.push({route:'/tracks/search',params:{query:waveQuery('',settings)},context:retrievalContext(settings)});
  // Positive library neighbours run first. Generic mood references never outrank retrieval from saved tracks.
  if(language!=='en'&&!context?.playlistId)jobs.push(...MOOD_MIXES.map(mix=>({route:'/tracks/search',params:{query:moodSeedQuery(mix.id,Math.floor(Date.now()/86400000)+round)},context:{retrievalSources:['mood-reference']}})));
  const found=new Map();let successes=0;
  let expanded=false;const primaryCount=jobs.length;
  for(let i=0;i<jobs.length;){
    const batchJobs=jobs.slice(i,i+2),completed=i+batchJobs.length;
    const batch=await Promise.allSettled(batchJobs.map(({route,params})=>request(route,params)));
    const batchTracks=[];
    for(let j=0;j<batch.length;j++){
      const result=batch[j];if(result.status!=='fulfilled')continue;successes++;
      for(const raw of result.value){
        const t=normalizeTrack(raw);if(!t.streamable)continue;
        const merged={...t};
        for(const key of ['relatedTo','directRelatedTo','discoveryGenres','discoveryMoods','discoveryEnergy','discoveryVocals','discoveryLanguages','retrievalSources'])merged[key]=[...new Set([...(found.get(t.id)?.[key]||[]),...(t[key]||[]),...(batchJobs[j].context[key]||[])])];
        found.set(t.id,merged);batchTracks.push(merged);
      }
    }
    if(batchTracks.length)onBatch?.(batchTracks);
    if(!expanded&&completed>=primaryCount){
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
    i=completed;
  }
  if(!successes)throw new Error('YouTube не отвечает. Можно слушать локальные файлы или повторить загрузку каталога.');
  return [...found.values()];
}
