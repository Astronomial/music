import {feedbackReward} from './feedback.mjs';
// Shared linear ridge/UCB model over *selection-time* context. Unlike independent
// artist arms it generalises feedback to unseen artists with similar circumstances.
// This is an on-device adaptation of the contextual-bandit principle, not a neural
// model or calibrated probability of enjoyment. No logged random-policy data exists.
export const CONTEXT_VERSION=1;
export const CONTEXT_SIZE=10;
const PRIOR=[.5,.12,0,0,0,0,0,0,0,0],RIDGE=4,DAY=86400000;
const clamp=x=>Math.max(0,Math.min(1,x));
export function contextFeatures({taste,nearby,session,newArtist,known,language,context,metadata}){
  return [1,taste,nearby,Math.max(0,session),Math.max(0,-session),newArtist?1:0,known?1:0,language,context,metadata].map(clamp);
}
export function validContext(snapshot){
  return snapshot?.version===CONTEXT_VERSION&&Array.isArray(snapshot.features)&&snapshot.features.length===CONTEXT_SIZE&&snapshot.features.every(x=>Number.isFinite(x)&&x>=0&&x<=1)&&snapshot.features[0]===1;
}
function inverse(matrix){
  const d=CONTEXT_SIZE,rows=matrix.map((row,i)=>[...row,...Array.from({length:d},(_,j)=>i===j?1:0)]);
  for(let i=0;i<d;i++){
    const pivot=rows[i][i];
    for(let j=0;j<2*d;j++)rows[i][j]/=pivot;
    for(let k=0;k<d;k++)if(k!==i){const factor=rows[k][i];for(let j=0;j<2*d;j++)rows[k][j]-=factor*rows[i][j];}
  }
  return rows.map(row=>row.slice(d));
}
export function buildContextualModel(state,now=Date.now()){
  const d=CONTEXT_SIZE,matrix=Array.from({length:d},(_,i)=>Array.from({length:d},(_,j)=>i===j?RIDGE:0));
  const target=PRIOR.map(x=>x*RIDGE),seen=new Set();let evidence=0,samples=0;
  for(const event of state.events.slice(-3000).slice().sort((a,b)=>b.at-a.at)){
    const reward=feedbackReward(event);
    if(reward===null||!Number.isFinite(event.at)||event.at>now||!validContext(event.recommendation))continue;
    const key=event.trackId+':'+Math.floor(event.at/DAY);if(seen.has(key))continue;seen.add(key);
    const weight=Math.pow(.5,(now-event.at)/(30*DAY))*(event.type==='skip'&&state.settings.skipSensitivity==='soft'?.35:1);
    const x=event.recommendation.features;
    for(let i=0;i<d;i++){target[i]+=weight*reward*x[i];for(let j=0;j<d;j++)matrix[i][j]+=weight*x[i]*x[j];}
    evidence+=weight;samples++;
  }
  const covariance=inverse(matrix),coefficients=covariance.map(row=>row.reduce((sum,x,j)=>sum+x*target[j],0));
  return {coefficients,covariance,evidence,samples,confidence:evidence/(12+evidence)};
}
export function predictContext(model,x){
  const baseline=PRIOR.reduce((sum,v,i)=>sum+v*x[i],0);
  if(!model.samples)return {mean:baseline,correction:0,uncertainty:.5,confidence:0};
  const mean=clamp(model.coefficients.reduce((sum,v,i)=>sum+v*x[i],0));
  let variance=0;for(let i=0;i<CONTEXT_SIZE;i++)for(let j=0;j<CONTEXT_SIZE;j++)variance+=x[i]*model.covariance[i][j]*x[j];
  return {mean,correction:(mean-baseline)*model.confidence,uncertainty:clamp(Math.sqrt(Math.max(0,variance))),confidence:model.confidence};
}
