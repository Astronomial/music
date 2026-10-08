import {fold,genresOf} from './wave-settings.mjs';
const DAY=86400000;
export function feedbackReward(event){
  if(event.type==='listen'&&event.ratio>=.8)return 1;
  if(event.type==='listen'&&event.ratio>=.5)return .7;
  if(event.type==='skip'&&event.seconds>=3&&event.seconds<30&&event.ratio<.25)return 0;
  if(event.type==='skip'&&event.seconds>=3&&event.ratio<.65)return .25;
  return null;
}
function arms(track){
  const artist=fold(track.artist);
  return [...(artist?[[`artist:${artist}`,1.5]]:[]),...genresOf(track).values.map(g=>[`genre:${g}`,.6]),...(track.relatedTo||[]).slice(0,5).map(id=>[`seed:${id}`,.8])];
}
// A local Beta posterior: only actual consumption trains it, never a generated shelf.
// This is a small online-learning approximation, not Spotify's production RL model.
export function buildFeedbackModel(state,now=Date.now()){
  const global=new Map(),contexts=new Map(),seen=new Set();
  function update(map,key,reward,weight){const arm=map.get(key)||{positive:0,negative:0};arm.positive+=reward*weight;arm.negative+=(1-reward)*weight;map.set(key,arm);}
  for(const e of [...state.events].reverse()){
    const reward=feedbackReward(e),track=state.tracks[e.trackId];if(reward===null||!track)continue;
    const token=`${e.trackId}:${Math.floor(e.at/DAY)}`;if(seen.has(token))continue;seen.add(token);
    const weight=Math.pow(.5,Math.max(0,now-e.at)/(30*DAY));
    for(const [key] of arms(track)){update(global,key,reward,weight);if(e.mood)update(contexts,`${e.mood}:${key}`,reward,weight);}
  }
  return {global,contexts};
}
export function predictFeedback(track,model,mood=''){
  let mean=0,evidence=0,total=0;
  for(const [key,importance] of arms(track)){
    const g=model.global.get(key)||{positive:0,negative:0},c=model.contexts.get(`${mood}:${key}`);
    const positive=g.positive+(c?.positive||0),negative=g.negative+(c?.negative||0),n=positive+negative;
    mean+=importance*(2+positive)/(4+n);evidence+=importance*n;total+=importance;
  }
  const count=total?evidence/total:0;
  return {mean:total?mean/total:.5,evidence:count,uncertainty:1/Math.sqrt(4+count)};
}
