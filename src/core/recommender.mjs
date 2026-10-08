const DAY = 86400000;
import {waveSettings,genresOf,blockedByPreferences,preferenceAffinity,activeSeedPlaylists} from './wave-settings.mjs';
import {buildFeedbackModel,predictFeedback,feedbackReward} from './feedback.mjs';
import {moodEvidence,MOOD_MIXES} from './mood-mixes.mjs';
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// Tracks are replaced, never mutated, when catalogue metadata changes.
const featureCache=new WeakMap(),vectorCache=new WeakMap();
function rememberVector(vector){const entries=Object.entries(vector),norm=Math.sqrt(entries.reduce((sum,[,v])=>sum+v*v,0));const info={entries,norm};vectorCache.set(vector,info);return info;}
function vectorInfo(vector){return vectorCache.get(vector)||{entries:Object.entries(vector),norm:Math.sqrt(Object.values(vector).reduce((sum,v)=>sum+v*v,0))};}
export function playlistPulseContext(state,id){
  const playlist=state.playlists.find(p=>p.id===id);
  if(!playlist||!playlist.trackIds.some(id=>state.tracks[id]))return null;
  return {playlistId:id,playlistName:playlist.name,discovery:0.75};
}
export function playlistSeedState(state,context){
  if(!context?.playlistId)return state;
  const playlist=state.playlists.find(p=>p.id===context.playlistId);
  const seeds=new Set(playlist?.trackIds||[]);
  // Unrelated listening must not become a retrieval anchor for this playlist.
  // The ranker still reads the original state for shared feedback/session learning.
  const events=state.events.filter(e=>seeds.has(e.trackId)||state.tracks[e.trackId]?.relatedTo?.some(id=>seeds.has(id)));
  return {...state,events,likes:[],playlists:playlist?[playlist]:[],settings:{...state.settings,genres:[],playlistSource:'all',seedPlaylistIds:[]}};
}
export function features(t) {
  if(featureCache.has(t))return featureCache.get(t);
  const f = {};
  const genreTraits=genresOf(t);
  for(const genre of genreTraits.values)f[`genre:${genre}`]=1.8*genreTraits.confidence;
  if (t.mood) f[`mood:${t.mood}`] = 0.9;
  if (t.artistId) f[`artist:${t.artistId}`] = 1.2;
  if(t.artist)f[`artistName:${t.artist.toLowerCase().replace(/ё/g,'е').trim()}`]=0.5;
  if(t.source==='youtube'){
    f[`seed:${t.id}`]=1.1;
    for(const id of t.relatedTo||[])f[`seed:${id}`]=1.1;
  }
  for (const tag of (t.tags || []).slice(0, 12)) f[`tag:${tag}`] = 0.55;
  featureCache.set(t,f);rememberVector(f);return f;
}
export function cosine(a, b) {
  const ai=vectorInfo(a),bi=vectorInfo(b);
  if(!ai.norm||!bi.norm)return 0;
  const [entries,other]=ai.entries.length<=bi.entries.length?[ai.entries,b]:[bi.entries,a];
  let dot=0;for(const [key,value] of entries)dot+=value*(other[key]||0);
  return dot/(ai.norm*bi.norm);
}
export function eventWeight(e) {
  if (e.type === 'hide') return -7;
  if (e.type === 'listen') return (e.ratio || 0) >= 0.8 ? 1.5 : (e.ratio || 0) >= 0.5 ? 0.5 : 0;
  // Actual listened time, rather than the seek position, defines an early skip.
  if (e.type === 'skip') return e.seconds < 30 && (e.ratio || 0) < 0.25 ? -2.5 : (e.ratio || 0) < 0.65 ? -0.8 : 0;
  return 0;
}
export function buildProfile(state, now = Date.now()) {
  const settings=waveSettings(state.settings);
  const weights = new Map();
  for (const id of state.likes) weights.set(id, 5);
  for (const p of activeSeedPlaylists(state,settings)) for (const id of new Set(p.trackIds)) weights.set(id, Math.min(9, (weights.get(id) || 0) + 3));
  // Saturation stops one repeatedly played/skipped track from dominating taste.
  const implicit = new Map();
  for (const e of state.events) {
    const value = eventWeight(e) * Math.pow(0.5, Math.max(0, now - e.at) / (30 * DAY));
    implicit.set(e.trackId, clamp((implicit.get(e.trackId) || 0) + value, -7, 4));
  }
  for (const [id, weight] of implicit) weights.set(id, (weights.get(id) || 0) + weight);
  const positive = {}, negative = {};
  let negativeEvidence = 0;
  for (const [id, weight] of weights) {
    const track = state.tracks[id]; if (!track) continue;
    if(weight<0)negativeEvidence+=Math.min(2.5,Math.abs(weight));
    const target = weight >= 0 ? positive : negative;
    for (const [key, value] of Object.entries(features(track))) target[key] = (target[key] || 0) + Math.abs(weight) * value;
  }
  for (const g of settings.genres) positive[`genre:${g}`] = (positive[`genre:${g}`] || 0) + 3;
  rememberVector(positive);rememberVector(negative);
  return { positive, negative, weights, negativeEvidence };
}
export function trackSimilarity(a,b,vectorA=features(a),vectorB=features(b)) {
  const metadata=cosine(vectorA,vectorB);
  if(!a.bpm||!b.bpm)return metadata;
  // Half/double tempo equivalence handles tracks tagged at different beat levels.
  const distance=Math.min(Math.abs(a.bpm-b.bpm),Math.abs(a.bpm*2-b.bpm),Math.abs(a.bpm-b.bpm*2));
  const tempo=Math.exp(-(distance*distance)/(2*18*18));
  return metadata*0.85+tempo*0.15;
}
export function interestClusters(state,now=Date.now()){
  const profile=buildProfile(state,now),clusters=[];
  const anchors=[...profile.weights].filter(([id,w])=>w>0&&state.tracks[id]).sort((a,b)=>b[1]-a[1]);
  for(const [id,weight] of anchors.slice(0,120)){
    const track=state.tracks[id],vector=features(track);
    let cluster=clusters.find(c=>cosine(vector,c.vector)>.58);
    if(!cluster&&clusters.length<8){cluster={vector:{},weight:0,members:[]};clusters.push(cluster);}
    if(!cluster)cluster=clusters.reduce((a,b)=>cosine(vector,a.vector)>cosine(vector,b.vector)?a:b);
    if(!cluster)continue;
    cluster.members.push({track,weight});cluster.weight+=weight;
    for(const [key,value] of Object.entries(vector))cluster.vector[key]=(cluster.vector[key]||0)+value*weight;
  }
  return clusters.sort((a,b)=>b.weight-a.weight);
}
export function selectRetrievalAnchors(state,{now=Date.now(),limit=8}={}){
  const settings=waveSettings(state.settings),clusters=interestClusters(state,now),selected=[];
  for(let round=0;round<limit&&selected.length<limit;round++)for(const c of clusters){
    const t=c.members.filter(m=>!state.hidden.includes(m.track.id)&&!blockedByPreferences(m.track,settings))[round]?.track;
    if(t)selected.push(t);if(selected.length===limit)break;
  }
  return selected;
}
function sessionProfile(state,now){
  const positive={},negative={};let positiveCount=0,negativeCount=0;
  for(const e of state.events.slice(-80)){
    if(now-e.at>90*60000)continue;
    const reward=feedbackReward(e),t=state.tracks[e.trackId];if(reward===null||!t)continue;
    const strength=Math.pow(.5,Math.max(0,now-e.at)/(30*60000));
    const target=reward>=.7?positive:negative;
    if(reward>=.7)positiveCount+=strength;else negativeCount+=strength;
    for(const [key,value] of Object.entries(features(t)))target[key]=(target[key]||0)+value*strength;
  }
  rememberVector(positive);rememberVector(negative);
  return {positive,negative,positiveCount,negativeCount};
}
export function prepareRanking(state,now=Date.now(),context=null){
  return {state,now,context,profile:buildProfile(playlistSeedState(state,context),now),settings:waveSettings(state.settings),feedback:buildFeedbackModel(state,now),recentTaste:sessionProfile(state,now)};
}
export function rankTracks(candidates, state, options = {}) {
  const { now = Date.now(), limit = 30, exclude = [], context = null, seed = Math.floor(now / 3600000), allowRecent = false } = options;
  if(context?.playlistId&&!playlistPulseContext(state,context.playlistId))return [];
  const {profile,settings,feedback,recentTaste}=options.prepared||prepareRanking(state,now,context);
  const anchors=[...profile.weights].filter(([,w])=>w>0).sort((a,b)=>b[1]-a[1]).slice(0,45).map(([id,w])=>({track:state.tracks[id],weight:w})).filter(a=>a.track).map(a=>({...a,vector:features(a.track)}));
  const banned = new Set([...state.hidden, ...exclude]);
  const recent = new Set(state.events.filter(e => e.type === 'play' && now - e.at < settings.repeatCooldown * 3600000).map(e => e.trackId));
  const library=new Set([...state.likes,...state.playlists.flatMap(p=>p.trackIds)]);
  const last = [...state.events].reverse().find(e => (e.type === 'listen' || e.type === 'play')&&now-e.at<=90*60000);
  const lastTrack = last && state.tracks[last.trackId];
  const lastVector = lastTrack ? features(lastTrack) : {};
  const discovery = context?.discovery??settings.discovery;
  const liked=new Set(state.likes);
  const contextSettings=context?.mood?{...settings,mood:context.mood==='night'?'any':context.mood,energy:context.energy||'any',vocals:context.vocals||'any',genres:[],preferredArtists:[]}:null;
  const unique = new Map(candidates.map(t => [t.id, t]));
  const ranked = [...unique.values()].filter(t => t.streamable && !banned.has(t.id) && !blockedByPreferences(t,settings) && (settings.includeLibrary||!library.has(t.id)) && (allowRecent || !recent.has(t.id)) && (!context?.mood||moodEvidence(t,context)>0)).map(track => {
    const vector = features(track);
    const globalAffinity = cosine(vector, profile.positive);
    const closestAnchor = anchors.length?Math.max(...anchors.map(a=>trackSimilarity(track,a.track,vector,a.vector)*Math.min(1,a.weight/3))):globalAffinity;
    // Preserve several distinct musical interests instead of averaging them away.
    const affinity = globalAffinity*0.65+closestAnchor*0.35;
    // One early skip is useful feedback, but should not erase a whole genre.
    const avoidance = cosine(vector, profile.negative)*Math.min(1,profile.negativeEvidence/8);
    const known = (profile.weights.get(track.id) || 0) > 0;
    const popular = Math.min(1, Math.log1p(track.favoriteCount || 0) / 12);
    const noise = stableNoise(track.id, seed);
    let contextScore = context?.genres?.includes(track.genre) ? 0.6 : 0;
    if(!contextScore&&context?.genres?.some(g=>track.discoveryGenres?.includes(g)))contextScore=0.3;
    if (context?.moods?.includes(track.mood)) contextScore += 0.55;
    if(context?.mood)contextScore=moodEvidence(track,context)*.8+preferenceAffinity(track,contextSettings).score;
    // A played/skipped recommendation is evidence; merely showing a shelf is not.
    const session = cosine(vector,recentTaste.positive)*Math.min(1,recentTaste.positiveCount/2)*1.05-cosine(vector,recentTaste.negative)*Math.min(.6,recentTaste.negativeCount/4)+(recentTaste.positiveCount?0:Math.max(0,cosine(vector,lastVector))*.08);
    // Novel candidates still need a taste match: exploration is not random genre drift.
    const novelty = !known ? discovery * (0.2 + affinity * 0.45) : (1 - discovery) * 0.12;
    const preference=preferenceAffinity(track,settings);
    const predicted=predictFeedback(track,feedback,context?.mood||settings.mood);
    const learning=(predicted.mean-.5)*1.6;
    const exploration=discovery*predicted.uncertainty*(.15+affinity*.45);
    let score = 2.2 * affinity - 1.65 * avoidance + novelty + session + learning+exploration+popular*.04+noise*.03+contextScore+preference.score;
    const ownWeight = profile.weights.get(track.id) || 0;
    if (ownWeight < 0) score -= Math.min(1.8, Math.abs(ownWeight) * 0.3);
    let reason = track.source==='local'?'Из твоей локальной музыки':`Новое из ${track.source==='youtube'?'YouTube':'Audius'}`;
    if (contextScore) reason = track.mood||track.genre?`Под настроение · ${track.mood || track.genre}`:'Найдено в направлении подборки';
    else if (liked.has(track.id)) reason = 'Из твоих любимых';
    else if (profile.positive[`artist:${track.artistId}`]) reason = 'Ты слушаешь этого исполнителя';
    else if (profile.positive[`genre:${track.genre}`]) reason = `В твоём вкусе · ${track.genre}`;
    else if (affinity > 0.1) reason = 'Похоже на музыку в твоей библиотеке';
    if(track.relatedTo?.some(id=>profile.weights.get(id)>0))reason='Рядом с музыкой, которую ты сохраняешь';
    if(session>.35)reason='В ритме твоих последних прослушиваний';
    if(predicted.mean>.6&&predicted.evidence>=2)reason='Ты часто дослушиваешь похожую музыку';
    if(preference.reason)reason=preference.reason;
    if(context?.mood)reason=moodEvidence(track,context)>=1?'Под настроение · и в твоём вкусе':'В направлении этой подборки';
    if(context?.playlistId&&affinity>.1)reason=`По мотивам «${context.playlistName||'плейлиста'}»`;
    return {track,score,reason,vector,known,genres:genresOf(track).values,signals:{taste:affinity,session,predictedEnjoyment:predicted.mean,uncertainty:predicted.uncertainty,context:contextScore},lane:known?'familiar':predicted.evidence<2?'exploration':'related'};
  });
  // Greedy MMR balances relevance with artist and content diversity.
  const result = [], artistCounts = new Map(),genreCounts=new Map();
  const targets=Object.entries(profile.positive).filter(([k,v])=>k.startsWith('genre:')&&v>0&&!settings.excludedGenres.includes(k.slice(6)));
  const totalGenre=targets.reduce((sum,[,v])=>sum+v,0);
  let newCount=0;
  while (ranked.length && result.length < limit) {
    const recentVectors=result.slice(-4).map(r=>r.vector);
    const previousTrack=result.at(-1)?.track,previousArtist=previousTrack&&(previousTrack.artistId||previousTrack.artist);
    const discoveryDeficit=discovery*(result.length+1)-newCount;
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < ranked.length; i++) {
      const item = ranked[i];
      const artistKey = item.track.artistId || item.track.artist;
      const count = artistCounts.get(artistKey) || 0;
      let similarity=0;for(const vector of recentVectors)similarity=Math.max(similarity,cosine(item.vector,vector));
      const genres=item.genres;
      const calibration=totalGenre&&!context?.mood?Math.max(0,...targets.filter(([k])=>genres.includes(k.slice(6))).map(([k,v])=>(v/totalGenre-(genreCounts.get(k.slice(6))||0)/Math.max(1,result.length))*.3)):0;
      const balance=result.length?(item.known?-1:1)*clamp(discoveryDeficit,-1,1)*.16:0;
      const adjusted = item.score+calibration+balance - similarity * (0.05 + settings.artistDiversity*0.5 + discovery * 0.25) - count * settings.artistDiversity*1.4 - (previousArtist && previousArtist === artistKey ? settings.artistDiversity*1.6 : 0);
      if (adjusted > bestScore) { bestScore = adjusted; best = i; }
    }
    const [item] = ranked.splice(best, 1);
    result.push(item);if(!item.known)newCount++;
    const key = item.track.artistId || item.track.artist;
    artistCounts.set(key, (artistCounts.get(key) || 0) + 1);
    for(const g of item.genres)genreCounts.set(g,(genreCounts.get(g)||0)+1);
  }
  return result.map(({ vector, genres, ...item }) => item);
}
export function moodRecommendations(candidates,state,{now=Date.now(),limit=24,prepared:shared=null}={}){
  const prepared=shared||prepareRanking(state,now);
  return MOOD_MIXES.map(mix=>({...mix,items:rankTracks(candidates,state,{now,limit,prepared,context:mix.context,allowRecent:true,seed:Math.floor(now/86400000)})}));
}
function stableNoise(id, seed) {
  let hash = seed | 0;
  for (const c of id) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967295;
}
export function retrievalSeeds(state) {
  const p = buildProfile(state);
  const top = prefix => Object.entries(p.positive).filter(([k]) => k.startsWith(prefix)).sort((a,b) => b[1]-a[1]).slice(0, 4).map(([k]) => k.slice(prefix.length));
  const settings=waveSettings(state.settings);
  return { genres: [...new Set([...settings.genres,...top('genre:')])].filter(g=>!settings.excludedGenres.includes(g)), artists: top('artist:'), tags: top('tag:') };
}
