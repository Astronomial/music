import {feedbackReward} from './feedback.mjs';

// Language of a recording is rarely supplied by YouTube. Text and search intent
// are evidence of differing strength, never a claim that audio was analysed.
export function languageEvidence(track,preference){
  if(preference==='any')return {fit:0,confidence:0,source:'none'};
  const language=String(track.language||'').toLowerCase().split(/[-_]/)[0];
  if(language&&(/^[a-z]{2}$/.test(language)||['rus','eng'].includes(language)))return {fit:language===preference||language===(preference==='ru'?'rus':'eng')?1:0,confidence:1,source:'metadata'};
  if(/[іїєґў]/i.test(track.title||''))return {fit:0,confidence:0,source:'unknown'};
  if(/[а-яё]/i.test(track.title||''))return {fit:preference==='ru'?0.8:0,confidence:0.8,source:'title'};
  if(track.discoveryLanguages?.includes(preference))return {fit:0.3,confidence:0.3,source:'search'};
  if(preference==='ru'&&/[а-яё]/i.test(track.artist||''))return {fit:0.2,confidence:0.2,source:'artist'};
  return {fit:0,confidence:0,source:'unknown'};
}

export function discoveryPolicy(state,settings,now=Date.now()){
  const recent=state.events.filter(e=>e.at<=now&&now-e.at<90*60000&&['pulse','mood'].includes(e.surface));
  const outcomes=recent.filter(e=>feedbackReward(e)!==null).slice(-6);
  let earlySkips=0;
  for(let i=outcomes.length-1;i>=0;i--){const e=outcomes[i];if(e.type!=='skip'||e.seconds>=30||e.ratio>=.25)break;earlySkips++;}
  const base={nearby:0.12,balanced:0.25,adventurous:0.45}[settings.explorationStyle]??0.12;
  const exposure=recent.filter(e=>e.type==='play').slice(-12);
  const classified=exposure.filter(e=>['familiar','nearby','stretch'].includes(e.recommendation?.lane));
  return {discoveryExposureCount:classified.length,newTrackCount:classified.filter(e=>e.recommendation.lane!=='familiar').length,surpriseRate:base/(1+earlySkips),earlySkips,exposureCount:exposure.length,surprises:exposure.filter(e=>e.recommendation?.lane==='stretch').length,preferredLanguageCount:exposure.filter(e=>state.tracks[e.trackId]&&languageEvidence(state.tracks[e.trackId],settings.languagePreference).fit>=.6).length};
}

export function neighbourhood(track,anchors,contentSimilarity,weights,maxSemantic=1,semantic=null){
  let best=semantic?.fit||0,match=semantic?.match||null,direct=0,indirect=0;
  if(semantic&&!track.relatedTo?.length)return {fit:best,match,direct,indirect,corroboration:0,close:best>=.24};
  const supportingArtists=new Set();
  for(const anchor of anchors){
    if(best+1e-9<maxSemantic){const similarity=contentSimilarity(track,anchor.track);if(similarity>best){best=similarity;match=anchor.track;}}
    if(track.relatedTo?.includes(anchor.track.id)&&(weights.get(anchor.track.id)||0)>0){
      const isDirect=track.directRelatedTo?.includes(anchor.track.id);
      if(isDirect){direct++;supportingArtists.add(anchor.track.artistId||anchor.track.artist);}
      else indirect++;
      if(!match||best<0.3)match=anchor.track;
    }
  }
  // Search labels alone do not establish a musical neighbourhood. Direct links
  // from independent favourite artists corroborate relevance; second hops are weaker.
  const graph=direct?Math.min(.9,.58+.12*(supportingArtists.size-1)):indirect?.34:0;
  const fit=Math.max(best,graph);
  return {fit,match,direct,indirect,corroboration:supportingArtists.size,close:fit>=.24};
}
