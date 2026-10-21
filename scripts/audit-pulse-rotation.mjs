import fs from 'node:fs';
import {initialState,normalizeTrack,recordEvent} from '../src/core/model.mjs';
import {rankTracks} from '../src/core/recommender.mjs';
const count=Math.max(1100,Number(process.argv[2])||1100),start=1800000000000;
const song=(i,extra={})=>normalizeTrack({id:'yt_'+String(i).padStart(11,'0'),videoId:String(i).padStart(11,'0'),source:'youtube',title:'Запись '+i,artist:'Артист '+i,artistId:'artist'+i,genre:'Pop',language:'ru',duration:200,...extra});
const likes=Array.from({length:180},(_,i)=>song(i)),saved=Array.from({length:160},(_,i)=>song(200+i));
const fresh=Array.from({length:1100},(_,i)=>song(1000+i,{...(i%7===0?{artist:likes[i%180].artist,artistId:likes[i%180].artistId}:{}),relatedTo:[likes[i%180].id],directRelatedTo:[likes[i%180].id]}));
const junk=Array.from({length:120},(_,i)=>song(4000+i,{genre:i<60?'Jazz':'Pop',title:i<60?'Другая запись '+i:'Energetic Music '+i,relatedTo:[likes[0].id],directRelatedTo:[likes[0].id],discoveryGenres:['Pop']}));
const candidates=[...likes,...saved,...fresh,...junk],favourite=new Set(likes.map(t=>t.id)),bad=new Set(junk.map(t=>t.id));
let state={...initialState(),tracks:Object.fromEntries(candidates.map(t=>[t.id,t])),likes:[...favourite],playlists:[{id:'import',name:'Synthetic import',trackIds:saved.map(t=>t.id)}]};
const seen=new Set(),familiar=new Set(),histogram={},artists=[],stats={kind:'synthetic-sequential-regression',platform:'Windows actual ranker',subjectiveTasteMeasured:false,liveYouTubeUsed:false,requested:count,candidates:candidates.length,eligibleFavourites:likes.length,played:0,familiar:0,discoveries:0,newRecordingsByFamiliarArtists:0,unrelatedOrUtility:0,modelFeatures:14,distinctFavourites:0,allFavouritesReachedAt:null,maxArtistIn12:0};
const began=performance.now();
for(let i=0;i<count;i++){
 const at=start+i*210000,choice=rankTracks(candidates,state,{now:at,limit:1,seed:Math.floor(at/3600000)})[0];if(!choice)break;
 const t=choice.track;stats.played++;if(choice.known){stats.familiar++;familiar.add(t.id);histogram[t.id]=(histogram[t.id]||0)+1;}else{stats.discoveries++;if(likes.some(s=>s.artist===t.artist))stats.newRecordingsByFamiliarArtists++;}
 if(familiar.size===likes.length&&stats.allFavouritesReachedAt===null)stats.allFavouritesReachedAt=i+1;
 if(bad.has(t.id))stats.unrelatedOrUtility++;
 seen.add(t.id);artists.push(t.artist);if(artists.length>12)artists.shift();stats.maxArtistIn12=Math.max(stats.maxArtistIn12,...artists.map(a=>artists.filter(b=>a===b).length));
 const extra={surface:'pulse',newArtist:choice.newArtist,recommendation:choice.exposure};
 state=recordEvent(state,t.id,'play',extra,at);state=recordEvent(state,t.id,'listen',{...extra,seconds:190,ratio:.95},at+190000);
 if(i%100===99)process.stderr.write(`${i+1}/${count}\n`);
}
stats.distinctFavourites=familiar.size;stats.favouriteDrawRange=[Math.min(...Object.values(histogram)),Math.max(...Object.values(histogram))];stats.uniqueTracks=seen.size;stats.elapsedSeconds=(performance.now()-began)/1000;
stats.passed=stats.played===count&&stats.distinctFavourites===likes.length&&stats.unrelatedOrUtility===0&&stats.familiar/count>=.27&&stats.familiar/count<=.33&&stats.newRecordingsByFamiliarArtists>0;
const output=JSON.stringify(stats,null,2)+'\n';if(process.argv[3])fs.writeFileSync(process.argv[3],output);else process.stdout.write(output);if(!stats.passed)process.exitCode=1;
