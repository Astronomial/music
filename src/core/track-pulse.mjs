import {normalizeText} from './search.mjs';
import {soundSimilarity} from './sound-profile.mjs';

export function songFamily(track){
  let title=normalizeText(String(track.title||'').replace(/\([^)]*\)|\[[^\]]*\]/g,' '));
  const artist=normalizeText(track.artist).replace(/ topic$/,'');
  if(artist&&title.startsWith(artist+' '))title=title.slice(artist.length+1);
  return title.replace(/(?:^| )(?:remix|ремикс|cover|кавер|sped|slowed|nightcore|acoustic|акустика|live|official|lyrics|audio|video|visualizer)(?: |$).*$/u,'').trim();
}
export function sameSong(a,b){const aa=songFamily(a),bb=songFamily(b);return a.id===b.id||Boolean(aa&&aa===bb);}
export function trackPulseFit(track,seed){
  if(!seed||sameSong(track,seed))return 0;
  const direct=track.directRelatedTo?.includes(seed.id)?0.9:track.relatedTo?.includes(seed.id)?0.48:0;
  const sound=soundSimilarity(track.soundProfile,seed.soundProfile);
  const genres=t=>new Set([t.genre,...(t.discoveryGenres||[])].filter(Boolean).map(normalizeText));
  const a=genres(track),b=genres(seed),genre=[...a].some(g=>b.has(g))?.3:0;
  const mood=track.mood&&track.mood===seed.mood?.15:0;
  const tags=(track.tags||[]).some(t=>(seed.tags||[]).includes(t))?.12:0;
  return Math.max(direct,sound===null?0:Math.max(0,(sound-.55)/.45),genre+mood+tags);
}
export function trackPulseContext(track){return {trackId:track.id,trackTitle:track.title,discovery:.85};}
