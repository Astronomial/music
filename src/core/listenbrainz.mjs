// Public MusicBrainz / ListenBrainz APIs; independent implementation, no Troi code.
import {artistIdentity,genresOf,genreRelation} from './genre-evidence.mjs';
import {semanticSimilarity} from './semantic-audio.mjs';

const mbid=value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function resolveArtist(data,name){
 if(!object(data)||!Array.isArray(data.artists))return {status:'invalid_response'};
 if(data.artists.some(a=>!object(a)||!mbid(a.id)||typeof a.name!=='string'||(a.aliases!==undefined&&(!Array.isArray(a.aliases)||a.aliases.some(x=>!object(x)||typeof x.name!=='string')))))return {status:'invalid_response'};
 const key=artistIdentity(name);
 const matches=new Map(data.artists.filter(a=>[a.name,...(a.aliases||[]).map(x=>x.name)].some(n=>artistIdentity(n)===key)).map(a=>[a.id.toLowerCase(),a]));
 if(matches.size>1)return {status:'ambiguous',candidates:[...matches.values()].map(a=>({mbid:a.id,name:a.name,disambiguation:a.disambiguation||''}))};
 if(!matches.size)return {status:'not_found'};
 const a=[...matches.values()][0];return {status:'resolved',mbid:a.id.toLowerCase(),name:a.name};
}

export function summariseRadio(data,seedMbid){
 if(!object(data))return {status:'invalid_response'};
 const recordings=new Set(),own=new Set(),neighbours=new Set(),artists=new Set();
 for(const [id,rows] of Object.entries(data)){
  if(!mbid(id)||!Array.isArray(rows))return {status:'invalid_response'};
  for(const row of rows){
   if(!object(row)||!mbid(row.recording_mbid)||!mbid(row.similar_artist_mbid)||row.similar_artist_mbid.toLowerCase()!==id.toLowerCase()||typeof row.similar_artist_name!=='string'||!Number.isFinite(row.total_listen_count)||row.total_listen_count<0)return {status:'invalid_response'};
   const key=row.recording_mbid.toLowerCase();recordings.add(key);
   if(id.toLowerCase()===seedMbid.toLowerCase())own.add(key);
   else {neighbours.add(key);artists.add(id.toLowerCase());}
  }
 }
 return {status:recordings.size?'ok':'empty',recordings:recordings.size,seedRecordings:own.size,neighbourRecordings:neighbours.size,neighbourArtists:artists.size,genreCoverage:null,relevance:null};
}

export function similarArtists(data,seed){
 if(!['ok','empty'].includes(summariseRadio(data,seed).status))return [];
 const seen=new Set(),result=[];
 for(const [id,rows] of Object.entries(data)){
  if(id.toLowerCase()===seed.toLowerCase()||!rows.length)continue;
  const name=rows[0].similar_artist_name.trim(),key=artistIdentity(name);
  if(!key||name.length>160||seen.has(key))continue;
  // Inconsistent credits cannot be resolved by guessing the first name.
  if(rows.some(row=>artistIdentity(row.similar_artist_name)!==key))continue;
  seen.add(key);result.push({mbid:id.toLowerCase(),name});
 }
 return result.slice(0,8);
}

export function collaborativeMatch(track,seed){
 const similarity=semanticSimilarity(track.soundProfile?.semantic,seed.soundProfile?.semantic);
 if(similarity!==null&&similarity<.65)return false;
 const x=genresOf(track).values,y=genresOf(seed).values;
 if(x.length&&y.length)return genreRelation(track,seed)>0;
 // A search query and DSP rhythm alone do not establish musical compatibility.
 return similarity!==null&&similarity>=.85;
}

async function boundedJSON(fetcher,url){
 const response=await fetcher(url,{headers:{'User-Agent':'Forma/1.20 (https://github.com/Astronomial/music)','Accept':'application/json'},signal:AbortSignal.timeout(15000),redirect:'error',credentials:'omit'});
 if(!response.ok){await response.body?.cancel();throw new Error('Optional catalogue unavailable');}
 const declared=Number(response.headers.get('content-length'));
 if(declared>2*1024*1024){await response.body?.cancel();throw new Error('Optional catalogue too large');}
 const chunks=[];let bytes=0;
 for await(const chunk of response.body){bytes+=chunk.length;if(bytes>2*1024*1024)throw new Error('Optional catalogue too large');chunks.push(chunk);}
 const data=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
 return JSON.parse(new TextDecoder().decode(data));
}

// peek never awaits the optional network. First refill warms the cache; a later
// refill can use it. One in-flight artist and a global cooldown bound traffic.
export class SimilarArtistCache {
 constructor(fetcher=fetch,{now=()=>Date.now()}={}){this.fetch=fetcher;this.now=now;this.cache=new Map();this.inflight=new Map();this.lastProbe=-Infinity;}
 peek(name){
  if(typeof name!=='string'||!name.trim()||name.length>160)return [];
  const hit=this.cache.get(artistIdentity(name));
  if(hit&&hit.until>this.now())return hit.names;
  void this.prefetch(name);return [];
 }
 prefetch(name){
  if(typeof name!=='string'||!name.trim()||name.length>160)return Promise.resolve([]);
  const key=artistIdentity(name),hit=this.cache.get(key);
  if(!key)return Promise.resolve([]);
  if(hit&&hit.until>this.now())return Promise.resolve(hit.names);
  if(this.inflight.has(key))return this.inflight.get(key);
  if(this.inflight.size||this.now()-this.lastProbe<30000)return Promise.resolve([]);
  this.lastProbe=this.now();
  const task=(async()=>{
   let names=[],ttl=600000;
   try{
    const search=new URL('https://musicbrainz.org/ws/2/artist/');search.search=new URLSearchParams({query:'artist:"'+name.replace(/[\\"]/g,'\\$&')+'"',fmt:'json',limit:'100'});
    const match=resolveArtist(await boundedJSON(this.fetch,search.href),name);
    if(match.status==='resolved'){
     const radio=new URL('https://api.listenbrainz.org/1/lb-radio/artist/'+match.mbid);radio.search=new URLSearchParams({mode:'easy',max_similar_artists:'8',max_recordings_per_artist:'5',pop_begin:'0',pop_end:'100'});
     const data=await boundedJSON(this.fetch,radio.href);
     if(!['ok','empty'].includes(summariseRadio(data,match.mbid).status))throw new Error('Invalid optional catalogue');
     names=similarArtists(data,match.mbid).filter(a=>artistIdentity(a.name)!==key);ttl=names.length?7*86400000:86400000;
    }else if(match.status==='not_found')ttl=86400000;
   }catch{/* Optional enrichment; never reject playback or classify a transport error as missing music. */}
   this.cache.delete(key);this.cache.set(key,{until:this.now()+ttl,names});
   while(this.cache.size>64)this.cache.delete(this.cache.keys().next().value);
   return names;
  })();
  this.inflight.set(key,task);void task.finally(()=>this.inflight.delete(key));return task;
 }
}

