#!/usr/bin/env node
// Run with Node 24+: node --use-env-proxy scripts/audit-listenbrainz.mjs --output /tmp/lb-audit.json
// GET only; no user account, listens, tokens, uploads or app-state changes.
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {auditSeed,auditCoverage} from './lib/listenbrainz-audit.mjs';
import policy from '../src/core/taste-policy.json' with {type:'json'};

const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--output'){
 console.error('Usage: node --use-env-proxy scripts/audit-listenbrainz.mjs --output /path/to/report.json');
 process.exitCode=1;
}else{
 const results=[];
 let lastRequest=0;
 const request=async url=>{
  await delay(Math.max(0,1100-(Date.now()-lastRequest)));lastRequest=Date.now();
  const started=Date.now(),meta={url,checkedAt:new Date().toISOString()};
  try{
   const response=await fetch(url,{headers:{'User-Agent':'FormaRecommendationAudit/1.0 (https://github.com/Astronomial/music)','Accept':'application/json'},signal:AbortSignal.timeout(15000),redirect:'error'});
   meta.httpStatus=response.status;
   if(!response.ok){await response.body?.cancel();return {...meta,status:'http_error',elapsedMs:Date.now()-started};}
   const chunks=[];let bytes=0;
   for await(const chunk of response.body){bytes+=chunk.length;if(bytes>2*1024*1024)throw new RangeError('Response exceeds 2 MiB');chunks.push(chunk);}
   const body=Buffer.concat(chunks),sha256=createHash('sha256').update(body).digest('hex');
   try{return {...meta,status:'ok',elapsedMs:Date.now()-started,bytes,sha256,data:JSON.parse(body.toString('utf8'))};}
   catch{return {...meta,status:'invalid_json',elapsedMs:Date.now()-started,bytes,sha256};}
  }catch(error){
   const status=error.name==='TimeoutError'?'timeout':error instanceof RangeError?'response_too_large':'transport_error';
   // Do not print proxy URLs, headers or credential-bearing error messages.
   return {...meta,status,elapsedMs:Date.now()-started,errorType:error.name,errorCode:typeof error.cause?.code==='string'?error.cause.code:undefined};
  }
 };
 for(const artist of policy.preferredArtists){
  const result=await auditSeed(artist,request);results.push(result);
  console.error(artist+': '+result.status);
 }
 const report={...auditCoverage(results),generatedAt:new Date().toISOString(),troiSource:'044398b5b6c6c99fc301f3417e62570b2a408a40',scope:'Public preferred artists only. Private library and listening history are not read or uploaded.'};
 await writeFile(args[1],JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({output:args[1],decision:report.decision,requestedArtists:report.requestedArtists,availableRadioArtists:report.availableRadioArtists,unavailableArtists:report.unavailableArtists,personalTasteAccuracy:report.personalTasteAccuracy}));
 // An incomplete live check must not be mistaken for a successful benchmark.
 if(report.unavailableArtists||report.ambiguousArtists)process.exitCode=2;
}
