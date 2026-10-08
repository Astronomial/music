import {rankTracks,moodRecommendations,prepareRanking} from './recommender.mjs';
export function runRecommendationJob({kind,candidates,state,options={}}){
  if(kind==='rank')return rankTracks(candidates,state,options);
  if(kind!=='analyze')throw new Error('Неизвестный расчёт рекомендаций.');
  const now=options.now??Date.now(),prepared=prepareRanking(state,now);
  return {
    recommendations:rankTracks(candidates,state,{now,prepared}),
    mixes:moodRecommendations(candidates,state,{now,prepared}),
    taste:Object.entries(prepared.profile.positive).filter(([key])=>key.startsWith('genre:')).sort((a,b)=>b[1]-a[1]).slice(0,3)
  };
}
