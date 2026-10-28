import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveArtist, summariseRadio, auditSeed, auditCoverage} from '../scripts/lib/listenbrainz-audit.mjs';

const seed='3c1b6453-a4a0-4801-9e33-af590e33b875';
const neighbour='b2e4a44e-e105-4325-a085-75d608753f0e';
const recording='401c1a5d-56e7-434d-b07e-a14d4e7eb83c';
const row=(artist=neighbour)=>({recording_mbid:recording,similar_artist_mbid:artist,similar_artist_name:'Artist',total_listen_count:12});
const ok=data=>({status:'ok',httpStatus:200,data});

test('artist lookup accepts punctuation, case and exact aliases but never a fuzzy first hit',()=>{
 assert.deepEqual(resolveArtist({'artists':[{id:seed,name:'ксюшенька.'}]},'ксюшенька'),{status:'resolved',mbid:seed,name:'ксюшенька.'});
 assert.equal(resolveArtist({'artists':[{id:seed,name:'Other',aliases:[{name:'MARKUL'}]}]},'markul').status,'resolved');
 assert.equal(resolveArtist({'artists':[{id:seed,name:'бэя cover',score:100}]},'бэя').status,'not_found');
});
test('same-name artists are ambiguous and duplicate appearances of one MBID are not',()=>{
 assert.equal(resolveArtist({artists:[{id:seed,name:'бэя'},{id:neighbour,name:'бэя'}]},'бэя').status,'ambiguous');
 assert.equal(resolveArtist({artists:[{id:seed,name:'MARKUL'},{id:seed,name:'markul'}]},'MARKUL').status,'resolved');
});
test('invalid search responses cannot become a legitimate empty catalogue',()=>{
 for(const data of [null,{},[],{artists:'oops'},{artists:[{name:'MARKUL',id:'not-mbid'}]}])assert.equal(resolveArtist(data,'MARKUL').status,'invalid_response');
 assert.equal(resolveArtist({artists:[]},'MARKUL').status,'not_found');
});
test('radio coverage deduplicates recordings and separates seed songs from discoveries',()=>{
 const r=summariseRadio({[seed]:[row(seed)],[neighbour]:[row(),row(),{...row(),recording_mbid:'5b44c236-cbb0-4e54-a8b1-c344b76e1b8f'}]},seed);
 assert.equal(r.status,'ok');assert.equal(r.recordings,2);assert.equal(r.seedRecordings,1);assert.equal(r.neighbourRecordings,2);assert.equal(r.neighbourArtists,1);
 assert.equal(r.genreCoverage,null);assert.equal(r.relevance,null);
});
test('radio errors, malformed artists and missing recording identities are not discoveries',()=>{
 for(const data of [{error:'upstream unavailable'},[],null,{[seed]:{}},{[seed]:[row()]},{[seed]:[{...row(seed),recording_mbid:'bad'}]}])assert.equal(summariseRadio(data,seed).status,'invalid_response');
 assert.equal(summariseRadio({},seed).status,'empty');
 assert.equal(summariseRadio({[seed]:[]},seed).status,'empty');
});
test('unreachable artist lookups stay unavailable, not absent, and do not query radio',async()=>{
 const calls=[];
 const result=await auditSeed('MARKUL',async url=>{calls.push(url);return {status:'http_error',httpStatus:403,error:'network policy'};});
 assert.equal(result.status,'lookup_unavailable');assert.equal(result.lookup.status,'http_error');assert.equal(calls.length,1);
 const report=auditCoverage([result]);assert.equal(report.resolvedArtists,0);assert.equal(report.artistsNotFound,0);assert.equal(report.unavailableArtists,1);
 assert.equal(report.decision,'do_not_replace_yet');assert.equal(report.personalTasteAccuracy,null);
});
test('radio outage is not reported as zero similar artists',async()=>{
 const result=await auditSeed('MARKUL',async url=>url.includes('/ws/2/artist/')?ok({artists:[{id:seed,name:'MARKUL'}]}):{status:'timeout',error:'timeout'});
 assert.equal(result.status,'radio_unavailable');assert.equal(result.mbid,seed);assert.equal(result.radioSummary,undefined);
 assert.equal(auditCoverage([result]).availableRadioArtists,0);
});
test('successful public API reads retain provenance without inventing metadata or personal quality',async()=>{
 const calls=[];
 const result=await auditSeed('MARKUL',async url=>{calls.push(url);return url.includes('/ws/2/artist/')?ok({artists:[{id:seed,name:'MARKUL'}]}):ok({[neighbour]:[row()]});});
 assert.equal(result.status,'ok');assert.equal(result.radioSummary.neighbourArtists,1);
 const query=new URL(calls[1]);assert.equal(query.origin,'https://api.listenbrainz.org');assert.equal(query.searchParams.get('mode'),'easy');assert.equal(query.searchParams.get('pop_end'),'100');
 const report=auditCoverage([result]);assert.equal(report.availableRadioArtists,1);assert.equal(report.decision,'do_not_replace_yet');assert.equal(report.personalTasteAccuracy,null);
});
test('rate limits and API error bodies remain distinct from absent artists',async()=>{
 for(const response of [{status:'http_error',httpStatus:429},{status:'invalid_json',httpStatus:200},{status:'ok',data:{error:'bad query'}}]){
  const result=await auditSeed('бэя',async()=>response);assert.equal(result.status,'lookup_unavailable');
 }
});
