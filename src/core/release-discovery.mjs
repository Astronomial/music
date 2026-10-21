import {artistIdentity,recordingIdentity,validateGenreEvidence,genreFold} from './genre-evidence.mjs';
import {feedbackReward} from './feedback.mjs';
import {utilityRecording} from './recording-quality.mjs';
const DAY=86400000;
export function recentSongPublication(track,artist){
  const title=' '+genreFold(track.title)+' ';
  return artistIdentity(track.artist)===artistIdentity(artist)&&track.duration>=60&&track.duration<=1200&&!utilityRecording(track)&&!/(?:^| )(?:teaser|trailer|snippet|shorts|interview|reaction|podcast|preview|vlog|тизер|трейлер|интервью|превью|подкаст|отрывок|бэкстейдж|сниппет|закулисье)(?: |$)/.test(title);
}
// A publication date is weak evidence; a matched older catalogue release wins.
export function releaseFreshness(track,now=Date.now()){
  const evidence=validateGenreEvidence(track.genreEvidence),released=evidence?.releasedAt;
  const date=Number.isFinite(released)?released:track.publishedAt;
  if(!Number.isFinite(date)||date<=0||date>now+DAY)return {score:0,recent:false,verified:false};
  const age=Math.max(0,(now-date)/DAY),recent=age<=120;
  return {score:recent?Math.exp(-age/60)*(released?1:.35):0,recent,verified:Boolean(released)};
}
export function recentReleaseRows(rows,artist,now=Date.now(),limit=3){
  const groups=new Map();
  for(const row of rows||[]){
    if(row.kind!=='song'||artistIdentity(row.artistName)!==artistIdentity(artist)||!recordingIdentity(row.trackName))continue;
    const at=Date.parse(row.releaseDate);if(!Number.isFinite(at)||at<=0||at>now+DAY)continue;
    const key=recordingIdentity(row.trackName),old=groups.get(key);
    if(!old||at<Date.parse(old.releaseDate))groups.set(key,row);
  }
  return [...groups.values()].filter(r=>now-Date.parse(r.releaseDate)<=120*DAY).sort((a,b)=>Date.parse(b.releaseDate)-Date.parse(a.releaseDate)||a.trackName.localeCompare(b.trackName)).slice(0,limit);
}
// New-release appetite is independent of general genre affinity.
export function freshReleaseTarget(state,now=Date.now()){
  let positive=3,negative=2,samples=0;const seen=new Set();
  for(const event of state.events.slice(-160).reverse()){
    const age=now-event.at,track=state.tracks[event.trackId],reward=feedbackReward(event),key=event.trackId+':'+Math.floor(event.at/DAY);
    if(age<0||age>90*DAY||!['pulse','mood'].includes(event.surface)||reward===null||!track||seen.has(key))continue;
    const fresh=releaseFreshness(track,event.at);if(!fresh.recent||!fresh.verified)continue;
    seen.add(key);samples++;const weight=Math.pow(.5,age/(30*DAY));positive+=reward*weight;negative+=(1-reward)*weight;
  }
  return samples<3?.6:Math.max(.25,Math.min(.8,positive/(positive+negative)));
}
