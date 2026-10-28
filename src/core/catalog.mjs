import {sameSong} from './track-pulse.mjs';
import {tasteGenres,discoveryQuery} from './discovery-search.mjs';
import {normalizeTrack} from './model.mjs';
import {selectRetrievalAnchors,playlistSeedState,rankTracks,buildProfile,prepareRanking} from './recommender.mjs';
import {artistIndex} from './diversity.mjs';
import {feedbackReward} from './feedback.mjs';
import {MOOD_MIXES,moodSeedQueries,moodEvidence,MOOD_COLLECTION_SIZE} from './mood-mixes.mjs';
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
  const source=playlistSeedState(state,context),settings=waveSettings(state.settings);
  const profile=buildProfile(source),leading=selectRetrievalAnchors(source,{limit:12,profile});
  const allAnchors=[...new Map([...leading,...[...profile.weights].filter(([id,w])=>w>0&&source.tracks[id]&&!source.hidden.includes(id)&&!blockedByPreferences(source.tracks[id],settings)).map(([id])=>source.tracks[id])].map(t=>[t.id,t])).values()];
  const offset=(Math.max(0,round)*6)%Math.max(1,allAnchors.length);
  const anchors=Array.from({length:Math.min(12,allAnchors.length)},(_,i)=>allAnchors[(offset+i)%allAnchors.length]);
  const recentAnchors=[...new Map([...source.events].reverse().filter(e=>e.at<=Date.now()&&Date.now()-e.at<7*86400000&&(feedbackReward(e)??0)>=.7).map(e=>source.tracks[e.trackId]).filter(t=>t&&(profile.weights.get(t.id)||0)>0&&!source.hidden.includes(t.id)&&!source.dislikes?.includes(t.id)&&!blockedByPreferences(t,settings)).map(t=>[t.id,t])).values()].slice(0,2);
  const seeds=[...new Map([...recentAnchors,...anchors].filter(t=>t.source==='youtube').map(t=>[t.id,t])).values()].slice(0,6);
  const language=settings.languagePreference;
  const languageContext=language==='any'?{}:{discoveryLanguages:[language]};
  const jobs=seeds.map(t=>({route:`/related/${t.videoId}`,params:{},context:{relatedTo:[t.id],directRelatedTo:[t.id],retrievalSources:['related']}}));
  const artists=[...new Set([...settings.preferredArtists,...recentAnchors.map(t=>t.artist),...anchors.filter(t=>!source.hidden.includes(t.id)&&!source.dislikes?.includes(t.id)&&!blockedByPreferences(t,settings)).map(t=>t.artist).filter(a=>a&&a!=='Неизвестный исполнитель')])].filter(a=>!settings.blockedArtists.some(b=>matchesArtist({artist:a},b)));
  if(artists.length)jobs.unshift({route:'/tracks/releases',params:{query:artists[Math.max(0,round)%artists.length]},context:{retrievalSources:['personal-releases']}});
  for(const artist of artists.filter(a=>!settings.blockedArtists.some(b=>matchesArtist({artist:a},b))).slice(0,6))jobs.push({route:'/tracks/search',params:{query:discoveryQuery('',settings,artist)},context:{...retrievalContext(settings),retrievalSources:['artist']}});
  const directions=tasteGenres(anchors,settings);
  const permitted=directions.filter(g=>!settings.excludedGenres.includes(g));
  for(const genre of permitted){
    if(language!=='any')jobs.push({route:'/tracks/search',params:{query:discoveryQuery(genre,settings)},context:{...retrievalContext(settings,genre),...languageContext,retrievalSources:['genre-language']}});
    if(language!=='ru'||permitted.indexOf(genre)<2)jobs.push({route:'/tracks/search',params:{query:waveQuery(genre,settings)},context:{...retrievalContext(settings,genre),retrievalSources:['genre']}});
  }
  const moodMixes=context?.playlistId?[]:context?.mood?MOOD_MIXES.filter(m=>m.id===context.mood):MOOD_MIXES;
  for(const mix of moodMixes){
    const preferred=permitted.filter(g=>mix.context.genres.includes(g));
    const genre=preferred[0]||permitted[0]||'';
    const moodSettings={...settings,mood:mix.context.mood,energy:mix.context.energy||'any',vocals:mix.context.vocals||'any'};
    jobs.push({route:'/tracks/search',params:{query:discoveryQuery(genre,moodSettings,artists[MOOD_MIXES.indexOf(mix)%Math.max(1,artists.length)]||'')},context:{...retrievalContext(moodSettings,genre),...languageContext,discoveryMoods:[mix.context.mood],retrievalSources:['mood']}});
  }
  for(const genre of permitted.slice(0,2))jobs.push({route:'/tracks/search',params:{query:discoveryQuery(genre,settings),offset:40*(1+(Math.max(0,round)%3))},context:{...retrievalContext(settings,genre),...languageContext,retrievalSources:['discovery-page']}});
  if(!jobs.length)jobs.push({route:'/tracks/search',params:{query:waveQuery('',settings)},context:retrievalContext(settings)});
  // Positive library neighbours run first. Generic mood references never outrank retrieval from saved tracks.
  const moodPrepared=moodMixes.length?prepareRanking(source,Date.now(),null,Object.values(source.tracks)):null;
  for(const mix of moodMixes){
    const matching=Object.values(source.tracks).filter(t=>moodEvidence(t,mix.context)>0);
    const playable=rankTracks(matching,source,{context:mix.context,limit:MOOD_COLLECTION_SIZE,allowRecent:true,prepared:moodPrepared});
    if(playable.length>=MOOD_COLLECTION_SIZE&&!context?.mood)continue;
    const moodAnchors=playable.map(r=>r.track).filter(t=>t.videoId);
    const chosen=moodAnchors.length?moodAnchors[Math.max(0,round)%moodAnchors.length]:null;
    if(chosen&&!seeds.some(t=>t.id===chosen.id))jobs.push({route:'/related/'+chosen.videoId,params:{},context:{relatedTo:[chosen.id],directRelatedTo:[chosen.id],retrievalSources:['mood-related']}});
    // Exact references bootstrap the shelf, but do not create a positive link
    // from these globally known songs to the listener's favourites.
    for(const query of moodSeedQueries(mix.id,{artists,genres:permitted,offset:Math.max(0,round)*3,limit:3}))jobs.push({route:'/tracks/search',params:{query},context:{retrievalSources:['mood-reference']}});
  }
  // Optional co-listening enrichment runs after the ordinary sources. A cold
  // lookup only warms a cache in the main process and returns immediately.
  const collaborator=anchors.filter(t=>t.source==='youtube'&&artists.includes(t.artist));
  if(collaborator.length){const seed=collaborator[Math.max(0,round)%collaborator.length];jobs.push({route:'/tracks/neighbours',params:{query:seed.artist},context:{relatedTo:[seed.id],retrievalSources:['listenbrainz-neighbour']}});}
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
        if(requested.size-seeds.length===1)jobs.push({route:'/tracks/releases',params:{query:bridge.artist},context:{relatedTo:[bridge.id,...bridge.relatedTo],retrievalSources:['artist-neighbour']}});
        jobs.push({route:`/related/${bridge.videoId}`,params:{},context:{relatedTo:[bridge.id,...bridge.relatedTo],directRelatedTo:[bridge.id],discoveryGenres:genresOf(bridge).values,retrievalSources:['discovery-related']}});
        if(requested.size-seeds.length>=3)break;
      }
    }
    i=completed;
  }
  if(!successes)throw new Error('YouTube не отвечает. Можно слушать локальные файлы или повторить загрузку каталога.');
  return [...found.values()];
}
