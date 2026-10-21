import {utilityRecording} from './recording-quality.mjs';
import {genreRelation} from './genre-evidence.mjs';
import {trackPulseFit,sameSong} from './track-pulse.mjs';
const DAY = 86400000;
import {createSoundMatcher} from './sound-profile.mjs';
import {waveSettings,genresOf,blockedByPreferences,preferenceAffinity,activeSeedPlaylists} from './wave-settings.mjs';
import {buildFeedbackModel,predictFeedback,feedbackReward} from './feedback.mjs';
import {artistIndex,recordingKey,diversityHistory,familiarArtists,artistSpacing} from './diversity.mjs';
import {moodEvidence,MOOD_MIXES} from './mood-mixes.mjs';
import {languageEvidence,discoveryPolicy,neighbourhood} from './discovery-policy.mjs';
import {buildContextualModel,contextFeatures,predictContext,CONTEXT_VERSION} from './contextual-learning.mjs';
import {familiarIDs,familiarRotation,compareFamiliar} from './familiar-rotation.mjs';
import {releaseFreshness,freshReleaseTarget} from './release-discovery.mjs';
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// Tracks are replaced, never mutated, when catalogue metadata changes.
const featureCache=new WeakMap(),vectorCache=new WeakMap(),semanticCache=new WeakMap();
function rememberVector(vector){const entries=Object.entries(vector),norm=Math.sqrt(entries.reduce((sum,[,v])=>sum+v*v,0));const info={entries,norm};vectorCache.set(vector,info);return info;}
function vectorInfo(vector){return vectorCache.get(vector)||{entries:Object.entries(vector),norm:Math.sqrt(Object.values(vector).reduce((sum,v)=>sum+v*v,0))};}
export function playlistPulseContext(state,id){
  const playlist=state.playlists.find(p=>p.id===id);
  if(!playlist||!playlist.trackIds.some(id=>state.tracks[id]))return null;
  return {playlistId:id,playlistName:playlist.name,discovery:0.75};
}
export function playlistSeedState(state,context){
  if(context?.trackId){const id=context.trackId;return {...state,likes:[id],playlists:[],events:state.events.filter(e=>e.trackId===id||state.tracks[e.trackId]?.relatedTo?.includes(id)),settings:{...state.settings,genres:[],playlistSource:'all',seedPlaylistIds:[]}};}
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
  if (e.type === 'listen'&&e.seconds>=3) return (e.ratio || 0) >= 0.8 ? 1.5 : (e.ratio || 0) >= 0.5 ? 0.5 : 0;
  // Actual listened time, rather than the seek position, defines an early skip.
  if (e.type === 'skip') return e.seconds>=3?(e.seconds < 30 && (e.ratio || 0) < 0.25 ? -2.5 : (e.ratio || 0) < 0.65 ? -0.8 : 0):0;
  return 0;
}
export function buildProfile(state, now = Date.now(), sharedArtistKeys=null) {
  const settings=waveSettings(state.settings);
  const weights = new Map();
  for (const id of state.likes) weights.set(id, 5);
  for (const p of activeSeedPlaylists(state,settings)) for (const id of new Set(p.trackIds)) weights.set(id, Math.min(9, (weights.get(id) || 0) + 3));
  // Saturation stops one repeatedly played/skipped track from dominating taste.
  const implicit = new Map();
  for (const e of state.events) {
    if(!Number.isFinite(e.at)||e.at>now)continue;
    const value = eventWeight(e) * Math.pow(0.5, Math.max(0, now - e.at) / (30 * DAY))*(e.type==='skip'&&settings.skipSensitivity==='soft'?.35:1);
    implicit.set(e.trackId, clamp((implicit.get(e.trackId) || 0) + value, -7, 4));
  }
  for (const [id, weight] of implicit) weights.set(id, (weights.get(id) || 0) + weight);
  const explicit=new Set([...state.likes,...activeSeedPlaylists(state,settings).flatMap(p=>p.trackIds)]);
  for(const [id,weight] of weights)if(weight>0&&state.tracks[id]&&utilityRecording(state.tracks[id])&&!explicit.has(id))weights.delete(id);
  for(const id of state.dislikes||[])weights.set(id,-4);
  const likeIDs=new Set(state.likes),playlistIDs=new Set(activeSeedPlaylists(state,settings).flatMap(p=>p.trackIds));
  const likeShare=playlistIDs.size?(likeIDs.size>=100?.7:.5):1;
  const sourceVectors=[{},{},{}],sourceMass=[0,0,0],portions=new Map();
  const positive = {}, negative = {};
  const artistKeys=sharedArtistKeys||artistIndex(Object.values(state.tracks)),totals=new Map(),counts=new Map(),balancedWeights=new Map();
  for(const [id,weight] of weights)if(weight>0&&state.tracks[id])for(const key of artistKeys(state.tracks[id])){totals.set(key,(totals.get(key)||0)+weight);counts.set(key,(counts.get(key)||0)+1);}
  let negativeEvidence = 0;
  for (const [id, weight] of weights) {
    const track = state.tracks[id]; if (!track) continue;
    if(weight<0)negativeEvidence+=Math.min(2.5,Math.abs(weight));
    const scale=weight>0?Math.min(1,...artistKeys(track).map(key=>(10+3*Math.log1p(counts.get(key)||0))/(totals.get(key)||1))):1;
    balancedWeights.set(id,weight*scale);
    const target = weight >= 0 ? positive : negative;
    if(weight>0){
      const liked=likeIDs.has(id)?likeShare/Math.max(1,likeIDs.size):0,imported=playlistIDs.has(id)?(likeIDs.size?1-likeShare:1)/Math.max(1,playlistIDs.size):0,total=liked+imported;
      const shares=total?[liked/total,imported/total,0]:[0,0,1];portions.set(id,shares);
      for(let i=0;i<3;i++)if(shares[i]){const mass=weight*scale*shares[i];sourceMass[i]+=mass;for(const [key,value] of Object.entries(features(track)))sourceVectors[i][key]=(sourceVectors[i][key]||0)+mass*value;}
    }else for (const [key, value] of Object.entries(features(track))) target[key] = (target[key] || 0) + Math.abs(weight*scale) * value;
  }
  // Balance artists within each source, then restore source budgets. A large
  // imported archive must not drown a smaller collection of current likes.
  const explicitMass=sourceMass[0]+sourceMass[1],share=sourceMass[0]?(sourceMass[1]?likeShare:1):0;
  const budgets=[explicitMass*share,explicitMass*(1-share),explicitMass?Math.min(sourceMass[2],explicitMass*.15):sourceMass[2]];
  const factors=budgets.map((budget,i)=>sourceMass[i]?budget/sourceMass[i]:0);
  for(let i=0;i<3;i++)for(const [key,value] of Object.entries(sourceVectors[i]))positive[key]=(positive[key]||0)+value*factors[i];
  for(const [id,shares] of portions)balancedWeights.set(id,balancedWeights.get(id)*shares.reduce((sum,share,i)=>sum+share*factors[i],0));
  for (const g of settings.genres) positive[`genre:${g}`] = (positive[`genre:${g}`] || 0) + 3;
  rememberVector(positive);rememberVector(negative);
  return { positive, negative, weights, balancedWeights, negativeEvidence };
}
export function trackSimilarity(a,b,vectorA=features(a),vectorB=features(b)) {
  const metadata=cosine(vectorA,vectorB);
  if(!a.bpm||!b.bpm)return metadata;
  // Half/double tempo equivalence handles tracks tagged at different beat levels.
  const distance=Math.min(Math.abs(a.bpm-b.bpm),Math.abs(a.bpm*2-b.bpm),Math.abs(a.bpm-b.bpm*2));
  const tempo=Math.exp(-(distance*distance)/(2*18*18));
  return metadata*0.85+tempo*0.15;
}
export function interestClusters(state,now=Date.now(),profile=buildProfile(state,now),sharedKeys=null){
  const clusters=[];
  const anchors=[...(profile.balancedWeights||profile.weights)].filter(([id,w])=>w>0&&state.tracks[id]).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  const keyFor=sharedKeys||artistIndex(Object.values(state.tracks)),groups=new Map();
  for(const anchor of anchors){const key=keyFor(state.tracks[anchor[0]])[0];if(!groups.has(key))groups.set(key,[]);groups.get(key).push(anchor);}
  const diverseAnchors=[];
  for(let round=0;diverseAnchors.length<Math.min(120,anchors.length);round++){
    for(const group of groups.values()){if(group[round])diverseAnchors.push(group[round]);if(diverseAnchors.length===120)break;}
  }
  for(const [id,weight] of diverseAnchors){
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
export function selectRetrievalAnchors(state,{now=Date.now(),limit=8,profile=null,artistKeys=null}={}){
  const settings=waveSettings(state.settings),clusters=interestClusters(state,now,profile||buildProfile(state,now,artistKeys),artistKeys),selected=[],seen=new Set();
  const keys=artistKeys||artistIndex(Object.values(state.tracks)),counts=new Map();
  const groups=clusters.map(c=>c.members.filter(m=>!state.hidden.includes(m.track.id)&&!blockedByPreferences(m.track,settings)).map(m=>m.track));
  // Cover different interests AND different artists before requesting a second song from one artist.
  for(let cap=1;cap<=limit&&selected.length<limit;cap++){
    let progress=true;
    while(progress&&selected.length<limit){
      progress=false;
      for(const group of groups){
        const track=group.find(t=>!seen.has(t.id)&&keys(t).every(k=>(counts.get(k)||0)<cap));
        if(!track)continue;
        selected.push(track);seen.add(track.id);for(const key of keys(track))counts.set(key,(counts.get(key)||0)+1);progress=true;
        if(selected.length===limit)break;
      }
    }
  }
  return selected;
}
// Classification must be able to inspect saved unknown tracks even in strict mode.
export function selectGenreMetadataAnchors(state,{limit=24,now=Date.now()}={}){
  return selectRetrievalAnchors({...state,settings:{...state.settings,genreMode:'prefer',excludedGenres:[]}},{limit,now});
}
function sessionProfile(state,now){
  const positive={},negative={};let positiveCount=0,negativeCount=0;
  for(const e of state.events.slice(-80)){
    if(e.at>now||now-e.at>90*60000)continue;
    const reward=feedbackReward(e),t=state.tracks[e.trackId];if(reward===null||!t)continue;
    const strength=Math.pow(.5,Math.max(0,now-e.at)/(30*60000))*(e.type==='skip'&&state.settings.skipSensitivity==='soft'?.5:1);
    const target=reward>=.7?positive:negative;
    if(reward>=.7)positiveCount+=strength;else negativeCount+=strength;
    for(const [key,value] of Object.entries(features(t)))target[key]=(target[key]||0)+value*strength;
  }
  rememberVector(positive);rememberVector(negative);
  return {positive,negative,positiveCount,negativeCount};
}
export function prepareRanking(state,now=Date.now(),context=null,candidates=[]){
  const index=artistIndex([...Object.values(state.tracks),...candidates]),keyCache=new WeakMap();
  const artistKeys=track=>{if(!keyCache.has(track))keyCache.set(track,index(track));return keyCache.get(track);};
  const source=playlistSeedState(state,context),profile=buildProfile(source,now,artistKeys),settings=waveSettings(state.settings);
  const anchors=selectRetrievalAnchors(source,{now,limit:45,profile,artistKeys}).map(track=>({track,weight:profile.weights.get(track.id)||0,vector:features(track)}));
  const anchorArtists=new Map();
  for(const [id,weight] of profile.weights)if(weight>0&&source.tracks[id]&&!source.hidden.includes(id))for(const key of artistKeys(source.tracks[id]))if(!anchorArtists.has(key))anchorArtists.set(key,source.tracks[id]);
  const sound=createSoundMatcher(anchors.map(a=>({profile:a.track.soundProfile,weight:a.weight})),(state.dislikes||[]).map(id=>state.tracks[id]?.soundProfile));
  const moodTaste=Object.fromEntries(MOOD_MIXES.map(m=>[m.id,Math.max(0,...anchors.map(a=>moodEvidence(a.track,m.context)))]));
  return {state,now,context,artistKeys,profile,anchors,sound,anchorArtists,moodTaste,semanticNeighbours:new Map(),affinityVectors:new Map(),affinities:new WeakMap(),neighbourhoods:new WeakMap(),settings,feedback:buildFeedbackModel(state,now),recentTaste:sessionProfile(state,now),contextual:buildContextualModel(state,now),policy:discoveryPolicy(state,settings,now)};
}
function semanticFeatures(track){
  if(semanticCache.has(track))return semanticCache.get(track);
  const vector=Object.fromEntries(Object.entries(features(track)).filter(([key])=>!key.startsWith('artist')&&!key.startsWith('seed:')));
  rememberVector(vector);semanticCache.set(track,vector);return vector;
}
function nearestSemantic(track,anchors,keys,cache,anchorArtists){
  const vector=semanticFeatures(track),reliability=track.genre||track.mood||track.tags?.length?1:genresOf(track).confidence;
  const signature=JSON.stringify([Object.entries(vector),reliability]);
  if(!cache.has(signature)){
    let fit=0,match=null;
    for(const anchor of anchors){
      const source=anchor.track,sourceReliability=source.genre||source.mood||source.tags?.length?1:genresOf(source).confidence;
      const similarity=cosine(vector,semanticFeatures(source))*.65*Math.min(reliability,sourceReliability);
      if(similarity>fit){fit=similarity;match=source;}
      if(fit>=.65*reliability)break;
    }
    cache.set(signature,{fit,match});
  }
  const key=keys(track).find(key=>!key.startsWith('unknown:')&&anchorArtists.has(key));
  return key?{fit:.7,match:anchorArtists.get(key)}:cache.get(signature);
}
export function rankTracks(candidates, state, options = {}) {
  const { now = Date.now(), limit = 30, exclude = [], context = null, seed = Math.floor(now / 3600000), allowRecent = false, currentTrackId = null } = options;
  if(context?.playlistId&&!playlistPulseContext(state,context.playlistId))return [];
  const {profile,anchors,sound,anchorArtists,moodTaste,semanticNeighbours,affinityVectors,affinities,neighbourhoods,settings,feedback,recentTaste,contextual,policy,artistKeys:sharedArtistKeys}=options.prepared||prepareRanking(state,now,context,candidates);
  const banned = new Set([...state.hidden, ...exclude]);
  const recent = new Set(state.events.filter(e => e.type === 'play' && e.at<=now && now - e.at < settings.repeatCooldown * 3600000).map(e => e.trackId));
  const library=new Set([...state.likes,...state.playlists.flatMap(p=>p.trackIds)]);
  const last = [...state.events].reverse().find(e => (e.type === 'listen' || e.type === 'play')&&e.at<=now&&now-e.at<=90*60000);
  const lastTrack = last && state.tracks[last.trackId];
  const lastVector = lastTrack ? features(lastTrack) : {};
  const discovery = context?.discovery??settings.discovery;
  const liked=new Set(state.likes),disliked=new Set(state.dislikes||[]);
  const familiarPool=familiarIDs(state,context),rotation=familiarRotation(state,now);
  const contextSettings=context?.mood?{...settings,mood:context.mood==='night'?'any':context.mood,energy:context.energy||'any',vocals:context.vocals||'any',genres:[],preferredArtists:[]}:null;
  const artistKeys=sharedArtistKeys||artistIndex([...Object.values(state.tracks),...candidates]);
  const familiar=familiarArtists(state,now,artistKeys);
  const history=diversityHistory(state,now,artistKeys,currentTrackId);
  const recentRecordings=new Set(state.events.filter(e=>e.type==='play'&&e.at<=now&&now-e.at<settings.repeatCooldown*3600000&&state.tracks[e.trackId]).map(e=>recordingKey(state.tracks[e.trackId],artistKeys)));
  const spacing=artistSpacing(settings.artistDiversity);
  const unique = new Map(candidates.map(t => [t.id, t]));
  const qualitySource=playlistSeedState(state,context);
  const knownRecordings=new Set([...qualitySource.likes,...qualitySource.playlists.flatMap(p=>p.trackIds)]);
  const personalDiscoveryAvailable=[...unique.values()].some(t=>t.streamable&&!knownRecordings.has(t.id)&&!banned.has(t.id)&&!exclude.includes(t.id)&&(allowRecent||!recent.has(t.id))&&(!context?.mood||moodEvidence(t,context)>0)&&!utilityRecording(t)&&!blockedByPreferences(t,settings)&&(artistKeys(t).some(k=>anchorArtists.has(k))||(t.directRelatedTo||[]).some(id=>(profile.weights.get(id)||0)>0&&state.tracks[id]&&(!genresOf(t).values.length||!genresOf(state.tracks[id]).values.length||genreRelation(t,state.tracks[id])>0))));
  const utilitySeeds=new Set([...qualitySource.likes,...activeSeedPlaylists(qualitySource,settings).flatMap(p=>p.trackIds)].filter(id=>qualitySource.tracks[id]&&utilityRecording(qualitySource.tracks[id])));
  const seedTrack=context?.trackId?state.tracks[context.trackId]:null;
  const newReleaseTarget=freshReleaseTarget(state,now);
  let ranked = [...unique.values()].filter(t => (!context?.trackId||seedTrack&&!sameSong(t,seedTrack)&&trackPulseFit(t,seedTrack)>.1) && t.streamable && !banned.has(t.id) && (allowRecent || !recentRecordings.has(recordingKey(t,artistKeys))) && !blockedByPreferences(t,settings) && (settings.includeLibrary||!library.has(t.id)) && (allowRecent || !recent.has(t.id)) && (!context?.mood||moodEvidence(t,context)>0)).map(track => {
    const vector = features(track);
    if(!affinities.has(track)){
      const signature=JSON.stringify([Object.entries(vector),track.bpm||0]);
      if(!affinityVectors.has(signature)){
        const global=cosine(vector,profile.positive),closest=anchors.length?Math.max(...anchors.map(a=>trackSimilarity(track,a.track,vector,a.vector)*Math.min(1,a.weight/3))):global;
        affinityVectors.set(signature,{global,closest});
      }
      affinities.set(track,affinityVectors.get(signature));
    }
    const {global:globalAffinity,closest:closestAnchor}=affinities.get(track);
    // Preserve several distinct musical interests instead of averaging them away.
    const audio=sound(track.soundProfile),audioAffinity=audio.fit;
    const affinity = audioAffinity===null?globalAffinity*0.4+closestAnchor*0.6:(globalAffinity*0.4+closestAnchor*0.6)*.7+audioAffinity*.3;
    // One early skip is useful feedback, but should not erase a whole genre.
    const avoidance = cosine(vector, profile.negative)*Math.min(1,profile.negativeEvidence/8);
    const known = knownRecordings.has(track.id);
    const keys=artistKeys(track),newArtist=keys.every(key=>!familiar.has(key));
    const noise = stableNoise(track.id, seed);
    let contextScore = context?.genres?.includes(track.genre) ? 0.6 : 0;

    if (context?.moods?.includes(track.mood)) contextScore += 0.55;
    if(context?.mood)contextScore=moodEvidence(track,context)*.8+preferenceAffinity(track,contextSettings).score;
    // A played/skipped recommendation is evidence; merely showing a shelf is not.
    const session = (cosine(vector,recentTaste.positive)*Math.min(1,recentTaste.positiveCount/2)*1.05-cosine(vector,recentTaste.negative)*Math.min(.6,recentTaste.negativeCount/4)+(recentTaste.positiveCount?0:Math.max(0,cosine(vector,lastVector))*.08))*(settings.sessionInfluence/.65);
    if(!neighbourhoods.has(track)){
      const semantic=nearestSemantic(track,anchors,artistKeys,semanticNeighbours,anchorArtists);
      const roots=(track.relatedTo||[]).filter(id=>(profile.weights.get(id)||0)>0&&state.tracks[id]&&!anchors.some(a=>a.track.id===id)).map(id=>({track:state.tracks[id],weight:profile.weights.get(id)}));
      neighbourhoods.set(track,neighbourhood(track,[...anchors,...roots].filter(a=>!genresOf(track).values.length||!genresOf(a.track).values.length||genreRelation(track,a.track)>0),()=>0,profile.weights,semantic.fit,semantic));
    }
    const neighbourhoodFit=neighbourhoods.get(track),language=languageEvidence(track,settings.languagePreference);
    const metadata=genresOf(track).values.length||track.mood||track.tags?.length?1:0;
    const genreFit=anchors.length?Math.max(0,...anchors.map(a=>genreRelation(track,a.track))):0;
    const trustedGenre=genresOf(track).values.length>0, comparable=trustedGenre&&anchors.some(a=>genresOf(a.track).values.length);
    const sameArtist=keys.some(key=>anchorArtists.has(key));
    // A mood word, Russian title or a search label cannot establish musical relevance.
    // Related-video edges are useful only while they do not contradict known genres.
    const direct=neighbourhoodFit.direct>0;
    const audible=!comparable&&audioAffinity!==null&&audioAffinity>=.92;
    const utilityMatch=utilitySeeds.has(track.id)||(track.directRelatedTo||[]).some(id=>utilitySeeds.has(id));
    // Choosing concentration is an explicit request for quiet instrumentals.
    // Confirmed piano/ambient recordings can serve that context even if the
    // ordinary Pulse is vocal pop; they never become global taste by exposure.
    const focusMatch=context?.mood==='focus'&&moodEvidence(track,context)>=.75&&genresOf(track).values.some(g=>['Ambient','Lo-Fi','Jazz','Classical'].includes(g));
    const artistNeighbour=track.retrievalSources?.includes('artist-neighbour')&&(track.relatedTo||[]).some(id=>(profile.weights.get(id)||0)>0&&state.tracks[id]&&(!comparable||genreRelation(track,state.tracks[id])>0));
    const personal=sameArtist||direct||audible||artistNeighbour;
    const referenceAllowed=!anchors.length||!track.retrievalSources?.includes('mood-reference')||known||personal||focusMatch;
    const eligible=referenceAllowed&&(!utilityRecording(track)||utilityMatch)&&!disliked.has(track.id)&&(!anchors.length||known||sameArtist||genreFit>0||(!comparable&&direct)||audible||artistNeighbour||focusMatch);
    const nearby=focusMatch||audible||known||sameArtist||direct||artistNeighbour||genreFit===1||(genreFit>0&&audioAffinity!==null&&audioAffinity>=.85);
    const freshness=releaseFreshness(track,now);
    // Novel candidates still need a taste match: exploration is not random genre drift.
    const novelty = !known ? discovery * (0.2 + affinity * 0.45) : (1 - discovery) * 0.12;
    const preference=preferenceAffinity(track,settings);
    const predicted=predictFeedback(track,feedback,context?.mood||settings.mood);
    const learning=(predicted.mean-.5)*1.6;
    const moodFit=context?.mood?moodEvidence(track,context):Math.max(0,...MOOD_MIXES.map(m=>Math.min(moodEvidence(track,m.context),moodTaste[m.id]||0)));
    const snapshotFeatures=contextFeatures({taste:affinity,nearby:neighbourhoodFit.fit,session,newArtist,known,language:language.fit,context:Math.max(0,contextScore),metadata,genre:genreFit,artist:sameArtist?1:0,mood:moodFit,sound:audioAffinity??0});
    const learned=predictContext(contextual,snapshotFeatures);
    const exploration=discovery*((predicted.uncertainty+learned.uncertainty)/2)*(.08+neighbourhoodFit.fit*.35);
    let score = 2.2 * affinity - 1.65 * avoidance + novelty + session + learning+exploration+noise*.03+contextScore+preference.score+neighbourhoodFit.fit*.65+learned.correction*1.4+language.fit*.15;
    if(!known&&personal)score+=freshness.score*(newReleaseTarget-.4)*3;
    if(!known&&!personal&&personalDiscoveryAvailable&&!focusMatch)score-=.8;
    // A broad Pop/Rock label must not outrank a genuine saved-track neighbour
    // merely because the neighbour has sparse recording metadata.
    if(direct)score+=1.5+Math.min(.3,Math.max(0,neighbourhoodFit.corroboration-1)*.15);
    score+=genreFit*.15+(sameArtist?.3:0)+moodFit*.2;
    if(seedTrack)score+=4*trackPulseFit(track,seedTrack);
    if(!nearby&&anchors.length)score-=settings.explorationStyle==='nearby'?.35:settings.explorationStyle==='balanced'?.15:0;
    const ownWeight = profile.weights.get(track.id) || 0;
    if(disliked.has(track.id))score-=1000;
    score-=Math.max(0,audio.avoidance-.75)*2;
    if (ownWeight < 0) score -= Math.min(1.8, Math.abs(ownWeight) * 0.3);
    let reason = track.source==='local'?'Из твоей локальной музыки':'Новое из YouTube';
    if (contextScore) reason = track.mood||track.genre?`Под настроение · ${track.mood || track.genre}`:'Найдено в направлении подборки';
    else if (liked.has(track.id)) reason = 'Из твоих любимых';
    else if (profile.positive[`artist:${track.artistId}`]) reason = 'Ты слушаешь этого исполнителя';
    else if (profile.positive[`genre:${track.genre}`]) reason = `В твоём вкусе · ${track.genre}`;
    else if (affinity > 0.1) reason = 'Похоже на музыку в твоей библиотеке';
    if(track.relatedTo?.some(id=>profile.weights.get(id)>0))reason='Рядом с музыкой, которую ты сохраняешь';
    if(session>.35)reason='В ритме твоих последних прослушиваний';
    if(predicted.mean>.6&&predicted.evidence>=2)reason='Ты часто дослушиваешь похожую музыку';
    if(preference.reason)reason=preference.reason;
    if(context?.mood)reason=focusMatch&&!known&&!sameArtist&&genreFit===0?'Инструментальная музыка для концентрации':moodEvidence(track,context)>=.8?'Под настроение · и в твоём вкусе':'В направлении этой подборки';
    if(context?.playlistId&&affinity>.1)reason=`По мотивам «${context.playlistName||'плейлиста'}»`;
    if(newArtist&&affinity>.1&&!context?.playlistId&&!context?.mood)reason=`Новый исполнитель · ${genresOf(track).values.find(g=>settings.genres.includes(g))||'в твоём вкусе'}`;
    if(audioAffinity!==null&&audioAffinity>=.78)reason='Похожее звучание · анализ аудио';
    if(newArtist&&direct&&neighbourhoodFit.match&&neighbourhoodFit.fit>=.24&&!context?.playlistId&&!context?.mood)reason=`Новый исполнитель · рядом с ${neighbourhoodFit.match.artist}`;
    const lane=known?'familiar':nearby?'nearby':'stretch';
    if(lane==='stretch'&&anchors.length&&!context?.mood&&!context?.playlistId)reason='Небольшой шаг в новое направление';
    if(seedTrack)reason='Похоже на «'+seedTrack.title+'»';
    if(!known&&personal&&freshness.recent&&!context?.mood&&!seedTrack)reason=freshness.verified?'Свежий релиз · рядом с твоим вкусом':'Свежая публикация · близкий исполнитель';
    return {eligible,track,score,reason,vector,known,newArtist,nearby,freshness,languageFit:language.fit,artistKeys:keys,recording:recordingKey(track,artistKeys),genres:genresOf(track).values,signals:{taste:affinity,neighbourhood:neighbourhoodFit.fit,corroboration:neighbourhoodFit.corroboration,session,predictedEnjoyment:predicted.mean,learnedContext:learned.mean,learningConfidence:learned.confidence,uncertainty:predicted.uncertainty,context:contextScore,language:language.source},lane,exposure:{version:CONTEXT_VERSION,features:snapshotFeatures,lane}};
  });
  ranked=ranked.filter(item=>item.eligible);
  // Deduplicate recordings across uploads before MMR; keep the best playable match.
  ranked.sort((a,b)=>b.score-a.score||a.track.id.localeCompare(b.track.id));
  const recordings=new Set();
  for(let i=0;i<ranked.length;){if(recordings.has(ranked[i].recording))ranked.splice(i,1);else{recordings.add(ranked[i].recording);i++;}}
  // Bound MMR work by keeping strong candidates from every artist, including minority interests.
  // A narrow pool retains enough songs to fill the requested queue.
  if(settings.artistDiversity){
    const distinct=new Set(ranked.flatMap(r=>r.artistKeys)).size,perArtist=Math.max(4,Math.ceil(limit/Math.max(1,distinct))*2);
    const counts=new Map(),pool=[];
    for(const item of ranked){if(!item.known&&item.artistKeys.some(key=>(counts.get(key)||0)>=perArtist))continue;pool.push(item);for(const key of item.artistKeys)counts.set(key,(counts.get(key)||0)+1);}
    if(pool.length>=Math.min(limit,ranked.length))ranked.splice(0,ranked.length,...pool);
  }
  const result = [], artistCounts = new Map(),genreCounts=new Map();
  const targets=Object.entries(profile.positive).filter(([k,v])=>k.startsWith('genre:')&&v>0&&!settings.excludedGenres.includes(k.slice(6)));
  const totalGenre=targets.reduce((sum,[,v])=>sum+v,0);
  const rolling=history.slice(),sessionCounts=new Map();
  for(const item of rolling)for(const key of item.keys)sessionCounts.set(key,(sessionCounts.get(key)||0)+1);
  const freshTarget=settings.artistDiversity?discovery*(.65+settings.artistDiversity*.3):0;
  let newCount=policy.newTrackCount,freshCount=policy.freshTrackCount,newArtistCount=history.filter(h=>h.newArtist).length,surprises=policy.surprises,languageCount=policy.preferredLanguageCount;
  const sessionSize=history.length;
  while (ranked.length && result.length < limit) {
    const recentVectors=result.slice(-4).map(r=>r.vector);
    const discoveryDeficit=discovery*(policy.discoveryExposureCount+result.length+1)-newCount;
    const freshDeficit=freshTarget*(sessionSize+result.length+1)-newArtistCount;
    const lastArtists=new Set(rolling.slice(-spacing.gap).flatMap(h=>h.keys));
    const bestTaste=Math.max(0,...ranked.map(r=>r.signals.taste));
    const tasteFloor=Math.min(.2,bestTaste*.55);
    const relevant=item=>item.known||item.signals.taste>=tasteFloor;
    const withinGap=item=>item.artistKeys.every(key=>!lastArtists.has(key));
    const withinCap=item=>item.artistKeys.every(key=>(sessionCounts.get(key)||0)<spacing.maxPerWindow);
    // Enforce spacing when suitable alternatives exist, and relax gracefully for small catalogues.
    let pool=ranked.map((_,i)=>i);
    // Reserve a familiar slot from the *whole* eligible library before language
    // or artist novelty can shrink it to the same few favourites again.
    const familiarSlot=discoveryDeficit<.5;
    if(familiarSlot){
      const saved=pool.filter(i=>ranked[i].known),favourites=saved.filter(i=>familiarPool.has(ranked[i].track.id));
      const own=favourites.length?favourites:saved,spaced=own.filter(i=>withinGap(ranked[i])&&withinCap(ranked[i]));
      const allowed=spaced.length?spaced:settings.artistDiversity&&pool.some(i=>withinGap(ranked[i])&&withinCap(ranked[i]))?[]:own;
      if(allowed.length){const oldest=Math.min(...allowed.map(i=>rotation.get(ranked[i].track.id)||0));pool=allowed.filter(i=>(rotation.get(ranked[i].track.id)||0)===oldest);}
    }
    const preferred=pool.filter(i=>!disliked.has(ranked[i].track.id));
    if(preferred.length)pool=preferred;
    // Reserve the requested language before novelty/artist filters narrow the
    // pool. Weak search genres must not erase supported Russian discoveries.
    if(!familiarSlot&&settings.languagePreference!=='any'&&.75*(policy.exposureCount+result.length+1)-languageCount>=.5){
      const languagePool=pool.filter(i=>ranked[i].languageFit>=.6&&relevant(ranked[i])&&(ranked[i].nearby||ranked[i].signals.neighbourhood>=.15||!anchors.length));
      const spaced=i=>relevant(ranked[i])&&withinGap(ranked[i])&&withinCap(ranked[i]);
      if(languagePool.length&&(!settings.artistDiversity||languagePool.some(spaced)||!pool.some(spaced)))pool=languagePool;
    }
    // Discovery of new artists and distance from taste are independent. Most
    // slots use a supported neighbourhood; occasional stretch slots are budgeted
    // against real started playback so repeated single-track ranking cannot reset it.
    const mayStretch=policy.surpriseRate*(policy.exposureCount+result.length+1)-surprises>=1;
    if(anchors.length&&!mayStretch){
      const close=pool.filter(i=>ranked[i].nearby);
      if(close.length)pool=close;
      else break;
    }
    if(settings.artistDiversity){
      const diverse=pool.filter(i=>relevant(ranked[i])&&withinGap(ranked[i])&&withinCap(ranked[i]));
      const spaced=pool.filter(i=>relevant(ranked[i])&&withinGap(ranked[i]));
      const belowCap=pool.filter(i=>relevant(ranked[i])&&withinCap(ranked[i]));
    pool=diverse.length?diverse:spaced.length?spaced:belowCap.length?belowCap:pool;
    }
    // Calibrate novelty after relevance, language and spacing: never fill a quota
    // with an excluded or unrelated song. Keep the selection-time classification.
    const novelSlot=discoveryDeficit>=.5;
    const balanced=pool.filter(i=>ranked[i].known!==novelSlot&&ranked[i].nearby&&relevant(ranked[i]));
    if(balanced.length)pool=balanced;
    if(novelSlot&&newReleaseTarget*(newCount+1)-freshCount>=.5){const recent=pool.filter(i=>!ranked[i].known&&ranked[i].nearby&&ranked[i].freshness.recent);if(recent.length)pool=recent;}
    if(settings.artistDiversity&&freshDeficit>=.5&&novelSlot){const fresh=pool.filter(i=>ranked[i].newArtist&&relevant(ranked[i]));if(fresh.length)pool=fresh;}
    const rotateFamiliar=pool.every(i=>ranked[i].known);
    let best = -1, bestScore = -Infinity;
    for (const i of pool) {
      const item = ranked[i];
      if(rotateFamiliar){
        if(best<0||compareFamiliar(item.track.id,ranked[best].track.id,rotation,seed)<0)best=i;
        continue;
      }
      const count = Math.max(0,...item.artistKeys.map(key=>artistCounts.get(key)||0));
      const heardCount=Math.max(0,...item.artistKeys.map(key=>sessionCounts.get(key)||0));
      let similarity=0;for(const vector of recentVectors)similarity=Math.max(similarity,cosine(item.vector,vector));
      const calibration=totalGenre&&!context?.mood?Math.max(0,...targets.filter(([k])=>item.genres.includes(k.slice(6))).map(([k,v])=>(v/totalGenre-(genreCounts.get(k.slice(6))||0)/Math.max(1,result.length))*.3)):0;
      const balance=(item.known?-1:1)*clamp(discoveryDeficit,-1,1)*.16;
      const languageBalance=settings.languagePreference!=='any'?item.languageFit*clamp(.75*(policy.exposureCount+result.length+1)-languageCount,-1,1)*.2:0;
      const adjusted = item.score+calibration+balance+languageBalance+(item.newArtist?settings.artistDiversity*discovery*.25:0)
        -similarity*(.05+settings.artistDiversity*.5+discovery*.25)-count*settings.artistDiversity*1.4
        -heardCount*settings.artistDiversity*.5-(item.artistKeys.some(k=>lastArtists.has(k))?settings.artistDiversity*1.6:0);
      if (adjusted > bestScore) { bestScore = adjusted; best = i; }
    }
    const [item] = ranked.splice(best, 1);
    result.push(item);if(!item.known){newCount++;if(item.freshness.recent)freshCount++;}if(item.newArtist)newArtistCount++;if(item.lane==='stretch')surprises++;if(item.languageFit>=.6)languageCount++;
    for(const key of item.artistKeys){artistCounts.set(key,(artistCounts.get(key)||0)+1);sessionCounts.set(key,(sessionCounts.get(key)||0)+1);}
    rolling.push({keys:item.artistKeys});
    if(rolling.length>spacing.window){const removed=rolling.shift();for(const key of removed.keys)sessionCounts.set(key,sessionCounts.get(key)-1);}
    for(const g of item.genres)genreCounts.set(g,(genreCounts.get(g)||0)+1);
  }
  return result.map(({ vector, genres, artistKeys, recording, nearby, languageFit, eligible, ...item }) => item);
}

export function moodRecommendations(candidates,state,{now=Date.now(),limit=25,prepared:shared=null}={}){
  const prepared=shared||prepareRanking(state,now,null,candidates);
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
