import test from 'node:test';
import assert from 'node:assert/strict';
import {YouTubeAudio,streamURL} from '../electron/youtube-audio.cjs';
import {initialState} from '../src/core/model.mjs';
import {likedTracksNewestFirst,retireLegacyCatalog} from '../src/core/library-order.mjs';
const id='abcdefghijk';
const audio=()=>new Response(new Uint8Array([0,0,0,24,102,116,121,112,77,52,65,32]),{headers:{'content-type':'audio/mp4'}});
const format=(url='https://r1.googlevideo.com/audio',extra={})=>({has_audio:true,has_video:false,mime_type:'audio/mp4',url,bitrate:128000,...extra});
const info=(formats=[format()])=>({basic_info:{id},playability_status:{status:'OK'},streaming_data:{adaptive_formats:formats}});
test('native audio resolves and shares cached public audio without allowing video or non-default language',async()=>{
 let calls=0;const a=new YouTubeAudio(async()=>audio(),()=>({getBasicInfo:async()=>{calls++;return info([format(undefined,{has_video:true}),format('https://r1.googlevideo.com/dub',{audio_track:{audio_is_default:false}}),format()]);}}));
 assert.deepEqual((await Promise.all([a.resolve(id),a.resolve(id)])).map(s=>s.url),['https://r1.googlevideo.com/audio','https://r1.googlevideo.com/audio']);assert.equal(calls,1);
 await a.prepare([id,id,'bad']);assert.equal(calls,1);a.cache.get(id).expires=0;await a.resolve(id);assert.equal(calls,2);a.close();
});
test('audio fallback wins a stalled primary; one failing client can recover without a cached rejection',async()=>{
 const a=new YouTubeAudio(async()=>audio(),()=>({getBasicInfo:async(_,options)=>options.client==='VISIONOS'?await new Promise(r=>setTimeout(()=>r(info()),600)):info()}));
 const start=performance.now();await a.resolve(id);assert.ok(performance.now()-start<550);a.close();
 let fail=true;const b=new YouTubeAudio(async()=>audio(),()=>({getBasicInfo:async()=>{if(fail)throw Error('network');return info();}}));
 await assert.rejects(b.resolve(id),/Не удалось получить аудио/);fail=false;await b.resolve(id);b.close();
});
test('restricted or mismatched videos and arbitrary stream hosts cannot enter playback',async()=>{
 for(const data of [{...info(),playability_status:{status:'LOGIN_REQUIRED'}},{...info(),basic_info:{id:'12345678901'}},info([format('https://evil.invalid/x')]),info([format(undefined,{has_video:true})])]){
  const a=new YouTubeAudio(()=>{throw Error('must not fetch');},()=>({getBasicInfo:async()=>data}));await assert.rejects(a.resolve(id));a.close();
 }
 for(const url of ['http://r1.googlevideo.com/a','https://googlevideo.com.evil.test/a','https://user@r1.googlevideo.com/a','https://r1.googlevideo.com:444/a'])assert.throws(()=>streamURL(url));
});
test('native protocol streams byte ranges, refreshes expired access once, and keeps tokens out of response headers',async()=>{
 const requests=[];let extracts=0,failed=false;
 const a=new YouTubeAudio(async(url,options)=>{const range=new URL(url).searchParams.get('range');requests.push({range,...options});if(range==='0-1023')return audio();if(!failed){failed=true;return new Response(null,{status:403});}return new Response(new Uint8Array([4,5,6]),{status:206,headers:{'Content-Type':'audio/mp4','Content-Range':'bytes 3-5/12','Content-Length':'3','Accept-Ranges':'bytes','set-cookie':'secret'}});},()=>({getBasicInfo:async()=>{extracts++;return info([format(undefined,{content_length:12})]);}}));
 const r=await a.respond(id,new Request('https://forma.test/audio',{headers:{Range:'bytes=3-5'}}));assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 3-5/12');assert.equal(r.headers.get('set-cookie'),null);assert.deepEqual([...new Uint8Array(await r.arrayBuffer())],[4,5,6]);assert.equal(extracts,2);assert.equal(requests.at(-1).range,'3-5');assert.equal(requests.at(-1).redirect,'manual');a.close();
});
test('native protocol rejects malformed ranges, aborted requests and non-audio responses',async()=>{
 const a=new YouTubeAudio(async()=>new Response('<html/>',{headers:{'content-type':'text/html'}}),()=>({getBasicInfo:async()=>info()}));
 assert.equal((await a.respond(id,new Request('https://forma.test',{headers:{Range:'bytes=0-1,2-3'}}))).status,416);
 assert.equal((await a.respond(id,new Request('https://forma.test'))).status,502);
 const controller=new AbortController();controller.abort();assert.equal((await a.respond(id,new Request('https://forma.test',{signal:controller.signal}))).status,499);a.close();
});
test('liked music is newest first after sync and re-like; old libraries fall back to insertion order',()=>{
 const s=initialState();s.likes=['old','new','middle'];s.tracks=Object.fromEntries(s.likes.map(id=>[id,{id}]));s.events=[{type:'like',trackId:'new',at:300},{type:'like',trackId:'old',at:100},{type:'like',trackId:'middle',at:200}];
 assert.deepEqual(likedTracksNewestFirst(s).map(t=>t.id),['new','middle','old']);
 s.events.push({type:'like',trackId:'old',at:400});assert.equal(likedTracksNewestFirst(s)[0].id,'old');assert.deepEqual(s.likes,['old','new','middle']);
 s.events=[];assert.deepEqual(likedTracksNewestFirst(s).map(t=>t.id),['middle','new','old']);
 const legacy={...s,settings:{provider:'audius',apiKey:'secret',volume:.35}};const next=retireLegacyCatalog(legacy);assert.equal(next.settings.provider,'youtube');assert.equal(next.settings.apiKey,undefined);assert.equal(next.settings.volume,.35);assert.equal(legacy.settings.apiKey,'secret');assert.deepEqual(next.likes,s.likes);
});
