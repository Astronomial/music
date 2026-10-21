import fs from 'node:fs';
import {initialState,normalizeTrack,recordEvent} from '../src/core/model.mjs';
import {rankTracks} from '../src/core/recommender.mjs';
import {releaseFreshness} from '../src/core/release-discovery.mjs';
const day=86400000,start=Date.now(),count=Math.max(1100,Number(process.argv[2])||1100);
const song=(n,extra={})=>normalizeTrack({id:'yt_'+String(n).padStart(11,'0'),videoId:String(n).padStart(11,'0'),source:'youtube',title:'Песня '+n,artist:'Артист '+n,genre:'Pop',duration:200,language:'ru',...extra});
const saved=[0,1].map(g=>Array.from({length:160},(_,i)=>song(g*10000+i)));
const groups=[0,1].map(g=>Array.from({length:1600},(_,i)=>song(100000+g*10000+i,{...(i%7===0?{artist:saved[g][i%160].artist}:{}),relatedTo:[saved[g][i%160].id],directRelatedTo:[saved[g][i%160].id],genreEvidence:{version:1,source:'itunes',values:['Pop'],confidence:.95,checkedAt:start,recordingId:String(100000+g*10000+i),releasedAt:start-(i<800?10:900)*day}})));
const hits=Array.from({length:180},(_,i)=>song(500000+i,{favoriteCount:1e12,playCount:1e14,genreEvidence:{version:1,source:'itunes',values:['Pop'],confidence:.95,checkedAt:start,recordingId:String(i),releasedAt:start-900*day},...(i<60?{retrievalSources:['mood-reference']}:{})}));
const all=[...saved.flat(),...groups.flat(),...hits];
const runs=[];
for(let g=0;g<2;g++){
 let state={...initialState(),tracks:Object.fromEntries(all.map(t=>[t.id,t])),likes:saved[g].slice(0,80).map(t=>t.id),playlists:[{id:'import',name:'Synthetic',trackIds:saved[g].slice(80).map(t=>t.id)}]};
 const own=new Set([...saved[g],...groups[g]].map(t=>t.id)),seen=new Set();const result={profile:g,requested:g?100:count,selected:0,candidateCount:all.length,familiar:0,discoveries:0,recentDiscoveries:0,verifiedFreshDiscoveries:0,offProfile:0,globalHits:0,distinctSaved:0};const drawn=new Set(),began=performance.now();
 for(let i=0;i<result.requested;i++){
  const now=start+i*210000,item=rankTracks(all,state,{now,limit:1,exclude:[...seen]})[0];if(!item)break;
  result.selected++;if(item.known){result.familiar++;drawn.add(item.track.id);}else{result.discoveries++;const fresh=releaseFreshness(item.track,now);if(fresh.recent)result.recentDiscoveries++;if(fresh.recent&&fresh.verified)result.verifiedFreshDiscoveries++;}
  if(!own.has(item.track.id))result.offProfile++;if(hits.some(t=>t.id===item.track.id))result.globalHits++;
  // No invented likes/listens: only started playback changes exposure quotas.
  if(!item.known)seen.add(item.track.id);state=recordEvent(state,item.track.id,'play',{surface:'pulse',recommendation:item.exposure,newArtist:item.newArtist},now);
  if(i%100===99)process.stderr.write(`profile ${g}: ${i+1}/${result.requested}\n`);
 }
 result.distinctSaved=drawn.size;result.elapsedSeconds=(performance.now()-began)/1000;result.passed=result.selected===result.requested&&result.offProfile===0&&result.globalHits===0&&result.verifiedFreshDiscoveries/result.discoveries>=.55;runs.push(result);
}
const report={kind:'synthetic-counterfactual-freshness',subjectiveTasteMeasured:false,liveYouTubeUsed:false,simulatedRewards:false,warning:'Same broad genre and same candidate pool; profile roots define independent synthetic relevance labels. Not a user-library or listening-based evaluation.',runs};
const output=JSON.stringify(report,null,2)+'\n';if(process.argv[3])fs.writeFileSync(process.argv[3],output);else process.stdout.write(output);if(!runs.every(r=>r.passed))process.exitCode=1;
