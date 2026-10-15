import test from 'node:test';
import assert from 'node:assert/strict';
import {YouTubeAudio} from '../electron/youtube-audio.cjs';
const id='abcdefghijk';
const audio=new Uint8Array([0,0,0,24,102,116,121,112,77,52,65,32]);
const info=(client)=>({basic_info:{id},cpn:'abcdefghijklmnop',playability_status:{status:'OK'},streaming_data:{adaptive_formats:[{has_audio:true,has_video:false,mime_type:'audio/mp4',url:'https://r1.googlevideo.com/'+client,bitrate:128000,content_length:12}]}});
test('a successful player response with a rejected CDN stream must not win playback',async()=>{
 const seen=[];
 const a=new YouTubeAudio(async url=>{seen.push(new URL(url).pathname);return new URL(url).pathname==='/VISIONOS'?new Response(audio,{headers:{'content-type':'audio/mp4'}}):new Response(null,{status:403});},()=>({getBasicInfo:async(_,opts)=>info(opts.client)}));
 try{const r=await a.respond(id,new Request('https://forma.test/audio'));assert.equal(r.status,200);assert.deepEqual([...new Uint8Array(await r.arrayBuffer())],[...audio]);assert.ok(seen.includes('/VISIONOS'));}finally{a.close();}
});

test('the selected client must pass a media probe; an HTTP 403 races against a usable alternative',async()=>{
 const attempts=[];
 const a=new YouTubeAudio(async url=>new URL(url).pathname==='/VISIONOS'?new Response(null,{status:403}):new Response(audio,{headers:{'content-type':'audio/mp4'}}),()=>({getBasicInfo:async(_,opts)=>{attempts.push(opts.client);return info(opts.client);}}));
 try{const source=await a.resolve(id);assert.equal(source.client,'ANDROID_VR');assert.deepEqual(attempts,['VISIONOS','ANDROID_VR']);}finally{a.close();}
});

test('trusted CDN redirects and query byte ranges retain native seeking semantics',async()=>{
 const seen=[];
 const a=new YouTubeAudio(async(url,options)=>{
  const u=new URL(url);seen.push({u,headers:options.headers,redirect:options.redirect});
  if(u.hostname==='r1.googlevideo.com')return new Response(null,{status:302,headers:{location:'https://r2.googlevideo.com/audio'}});
  const range=u.searchParams.get('range');return new Response(range==='3-5'?audio.slice(3,6):audio,{headers:{'content-type':'application/octet-stream','content-length':String(range==='3-5'?3:12)}});
 },()=>({getBasicInfo:async()=>info('audio')}));
 try{const r=await a.respond(id,new Request('https://forma.test',{headers:{Range:'bytes=3-5'}}));assert.equal(r.status,206);assert.equal(r.headers.get('content-type'),'audio/mp4');assert.equal(r.headers.get('content-range'),'bytes 3-5/12');assert.deepEqual([...new Uint8Array(await r.arrayBuffer())],[...audio.slice(3,6)]);assert.equal(seen.at(-1).u.searchParams.get('range'),'3-5');assert.equal(seen.at(-1).headers.Origin,'https://www.youtube.com');assert.ok(seen.at(-1).headers['User-Agent'].includes('Safari'));assert.ok(seen.every(r=>r.redirect==='manual'));}finally{a.close();}
});

test('a CDN redirect must never send requests to an arbitrary host or return HTML as audio',async()=>{
 let calls=0;
 const a=new YouTubeAudio(async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://evil.invalid/steal'}});},()=>({getBasicInfo:async()=>info('audio')}),{createPlayer:async()=>({})});
 try{await assert.rejects(a.resolve(id));assert.equal(calls,3);}finally{a.close();}
 const b=new YouTubeAudio(async()=>new Response('<html>Forbidden</html>',{headers:{'content-type':'application/octet-stream'}}),()=>({getBasicInfo:async()=>info('audio')}),{createPlayer:async()=>({})});
 try{await assert.rejects(b.resolve(id));assert.equal(b.error(id).includes('CDN_NOT_AUDIO'),true);}finally{b.close();}
});

test('n/signature transformation and cpn are applied before any media request',async()=>{
 const {Player,Platform}=await import('youtubei.js');const {evaluateSignature}=await import('../electron/signature-runtime.cjs');Platform.shim.eval=evaluateSignature;
 const player=await Player.fromSource('fixture',{signature_timestamp:123,data:{output:`const exportedVars={nsigFunction:()=>new (class {get(key){return key==='n'?'decoded-n':'decoded-s';}})()};`}});
 const seen=[];
 const a=new YouTubeAudio(async url=>{const u=new URL(url);seen.push(u);if(u.searchParams.get('n')!=='decoded-n'||u.searchParams.get('cpn')!=='abcdefghijklmnop')return new Response(null,{status:403});return new Response(audio,{headers:{'content-type':'audio/mp4'}});},()=>({getBasicInfo:async()=>{
  const data=info('audio');const f=data.streaming_data.adaptive_formats[0];f.url+='?n=raw';f.decipher=p=>p.decipher(f.url);return data;
 }}),{createPlayer:async()=>player});
 try{await a.resolve(id);assert.equal(seen.length,1);assert.equal(seen[0].searchParams.get('n'),'decoded-n');}finally{a.close();}
 const isolation=await evaluateSignature({output:'return {n:typeof process+":"+typeof require+":"+typeof fetch};'});assert.equal(isolation.n,'undefined:undefined:undefined');
 await assert.rejects(evaluateSignature({output:'while(true){}'}),/evaluation failed/);
});

test('real YouTube.js parsing decrypts a signatureCipher audio format with no direct URL',async()=>{
 const {Innertube,Player,Platform}=await import('youtubei.js');const {evaluateSignature}=await import('../electron/signature-runtime.cjs');Platform.shim.eval=evaluateSignature;
 const player=await Player.fromSource('fixture',{signature_timestamp:123,data:{output:`const exportedVars={nsigFunction:()=>new (class {get(key){return key==='n'?'decoded-n':'decoded-s';}})()};`}});
 const cipher=new URLSearchParams({url:'https://r1.googlevideo.com/audio?n=raw',s:'encrypted',sp:'sig'}).toString();
 const client=await Innertube.create({retrieve_player:false,generate_session_locally:true,fetch:async()=>Response.json({playabilityStatus:{status:'OK'},videoDetails:{videoId:id,title:'Fixture',author:'Artist',lengthSeconds:'1'},streamingData:{adaptiveFormats:[{itag:140,signatureCipher:cipher,mimeType:'audio/mp4; codecs="mp4a.40.2"',audioQuality:'AUDIO_QUALITY_MEDIUM',bitrate:128000,contentLength:'12'}]}})});
 const a=new YouTubeAudio(async url=>{const u=new URL(url);assert.equal(u.searchParams.get('sig'),'decoded-s');assert.equal(u.searchParams.get('n'),'decoded-n');assert.match(u.searchParams.get('cpn'),/^[\w-]{16}$/);return new Response(audio,{headers:{'content-type':'audio/mp4'}});},()=>client,{createPlayer:async()=>player});
 try{const source=await a.resolve(id);assert.equal(source.client,'VISIONOS');}finally{a.close();}
});
