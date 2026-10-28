// Read-only coverage audit. This module is deliberately outside the app bundle.
// MusicBrainz identities and public LB Radio pools are not personal relevance labels.
import {artistIdentity} from '../../src/core/genre-evidence.mjs';

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

export async function auditSeed(name,request){
 const search=new URL('https://musicbrainz.org/ws/2/artist/');
 // Quote as a Lucene literal so spaces, punctuation and operators are not queries.
 search.search=new URLSearchParams({query:'artist:"'+name.replace(/[\\"]/g,'\\$&')+'"',fmt:'json',limit:'100'});
 const lookup=await request(search.href),result={artist:name,lookup};
 if(lookup.status!=='ok')return {...result,status:'lookup_unavailable'};
 const match=resolveArtist(lookup.data,name);result.match=match;
 if(match.status==='invalid_response')return {...result,status:'lookup_unavailable'};
 if(match.status!=='resolved')return {...result,status:match.status};
 const radio=new URL('https://api.listenbrainz.org/1/lb-radio/artist/'+match.mbid);
 radio.search=new URLSearchParams({mode:'easy',max_similar_artists:'8',max_recordings_per_artist:'25',pop_begin:'0',pop_end:'100'});
 result.mbid=match.mbid;result.radio=await request(radio.href);
 if(result.radio.status!=='ok')return {...result,status:'radio_unavailable'};
 const summary=summariseRadio(result.radio.data,match.mbid);
 if(summary.status==='invalid_response')return {...result,status:'radio_unavailable',schemaError:true};
 return {...result,status:summary.status,radioSummary:summary};
}

export function auditCoverage(results){
 return {
  kind:'public-catalogue-coverage-not-personal-quality',
  requestedArtists:results.length,
  resolvedArtists:results.filter(r=>r.mbid).length,
  availableRadioArtists:results.filter(r=>r.status==='ok').length,
  emptyRadioArtists:results.filter(r=>r.status==='empty').length,
  artistsNotFound:results.filter(r=>r.status==='not_found').length,
  ambiguousArtists:results.filter(r=>r.status==='ambiguous').length,
  unavailableArtists:results.filter(r=>['lookup_unavailable','radio_unavailable'].includes(r.status)).length,
  personalTasteAccuracy:null,
  decision:'do_not_replace_yet',
  reason:'Coverage alone does not demonstrate better personal recommendations. A matched baseline, independent relevance feedback, genre evidence and playable recording resolution are required.',
  results
 };
}
