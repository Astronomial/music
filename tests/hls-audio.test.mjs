import test from 'node:test';
import assert from 'node:assert/strict';
import {YouTubeAudio,streamURL} from '../electron/youtube-audio.cjs';
import {audioVariants} from '../electron/hls-audio.cjs';
const id='abcdefghijk',audio=new Uint8Array([0,0,0,24,102,116,121,112,77,52,65,32]);
async function client(streaming){const {Innertube}=await import('youtubei.js');return Innertube.create({retrieve_player:false,generate_session_locally:true,fetch:async()=>Response.json({playabilityStatus:{status:'OK'},videoDetails:{videoId:id,title:'Fixture',author:'Artist'},streamingData:streaming})});}
const master='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\naudio.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="avc1.42e01e,mp4a.40.2",RESOLUTION=256x144\nvideo.m3u8\n';
const playlist='#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3,\npart00.m4s\n#EXT-X-ENDLIST\n';
test('real SDK audio MIME without optional audioQuality/audioBitrate remains playable in either format list',async()=>{
 for(const key of ['adaptiveFormats','formats']){
  const api=await client({[key]:[{itag:140,mimeType:'audio/mp4; codecs="mp4a.40.2"',url:'https://r1.googlevideo.com/audio',contentLength:'12'}]});
  const parsed=await api.getBasicInfo(id,{client:'VISIONOS'});assert.equal((key==='adaptiveFormats'?parsed.streaming_data.adaptive_formats:parsed.streaming_data.formats)[0].has_audio,false);
  const a=new YouTubeAudio(async()=>new Response(audio,{headers:{'Content-Type':'audio/mp4'}}),()=>api);
  try{assert.equal((await a.resolve(id)).client,'VISIONOS');}finally{a.close();}
 }
});
test('HLS-only player response selects audio, proxies init/segments and never exposes signed CDN URLs',async()=>{
 const api=await client({hlsManifestUrl:'https://manifest.googlevideo.com/hls/master.m3u8?token=secret',adaptiveFormats:[{itag:140,mimeType:'audio/mp4; codecs="mp4a.40.2"',audioQuality:'AUDIO_QUALITY_MEDIUM'}]});
 const seen=[];const a=new YouTubeAudio(async url=>{const path=new URL(url).pathname;seen.push(path);if(path.endsWith('/master.m3u8'))return new Response(master);if(path.endsWith('/audio.m3u8'))return new Response(playlist);if(path.endsWith('/init.mp4')||path.endsWith('/part00.m4s'))return new Response(audio);throw Error('unexpected resource');},()=>api);
 try{
  const source=await a.resolve(id);assert.equal(source.kind,'hls');
  const root=await a.respondHls(id,'index.m3u8',new Request('https://forma.test'));assert.equal(root.status,200);const text=await root.text();assert.ok(!text.includes('googlevideo.com'));assert.ok(!text.includes('secret'));assert.ok(text.includes('forma-stream://youtube/'+id+'/hls/'));
  for(const uri of [text.match(/URI="([^"]+)"/)[1],text.split('\n').find(l=>l.startsWith('forma-stream:'))]){const key=new URL(uri).pathname.split('/').at(-1);const r=await a.respondHls(id,key,new Request(uri));assert.equal(r.status,200);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),audio);}
  assert.ok(!seen.some(s=>s.includes('video.m3u8')));
  assert.equal(seen.filter(s=>s.endsWith('/audio.m3u8')).length,1,'a prepared VOD manifest must not be downloaded again on playback');
  assert.equal((await a.respondHls('12345678901',[...a.hls.resources.keys()][0],new Request('https://forma.test'))).status,410);
 }finally{a.close();}
});
test('HLS rejects video-only masters, non-CDN URIs, oversized manifests and unsupported encryption',async()=>{
 assert.deepEqual(audioVariants('#EXTM3U\n#EXT-X-STREAM-INF:CODECS="avc1.42,mp4a.40.2"\nvideo.m3u8','https://r1.googlevideo.com/a',streamURL),[]);
 for(const bad of ['https://evil.test/audio.m3u8','http://r1.googlevideo.com/audio','https://u:p@r1.googlevideo.com/a'])assert.throws(()=>audioVariants('#EXTM3U\n#EXT-X-STREAM-INF:CODECS="mp4a.40.2"\n'+bad,'https://r1.googlevideo.com/a',streamURL));
 for(const text of [playlist.replace('part00.m4s','https://evil.test/steal'),playlist.replace('#EXT-X-MAP:', '#EXT-X-KEY:METHOD=SAMPLE-AES,'),'#EXTM3U\n'+' '.repeat(1024*1024)]){
  const a=new YouTubeAudio(async url=>new Response(new URL(url).pathname.endsWith('/master.m3u8')?master:text),()=>({getBasicInfo:async()=>({basic_info:{id},playability_status:{status:'OK'},streaming_data:{hls_manifest_url:'https://r1.googlevideo.com/hls/master.m3u8'}})}),{createPlayer:async()=>({})});
  try{await assert.rejects(a.resolve(id));}finally{a.close();}
 }
});
test('failure reports preserve each client result instead of hiding useful errors behind the last fallback',async()=>{
 const a=new YouTubeAudio(async()=>new Response(null,{status:403}),()=>({getBasicInfo:async(_id,{client})=>({basic_info:{id},playability_status:{status:'OK'},streaming_data:{adaptive_formats:client==='WEB'?[]:[{mime_type:'audio/mp4',url:'https://r1.googlevideo.com/audio'}]}})}),{createPlayer:async()=>({})});
 try{await assert.rejects(a.resolve(id),e=>e.message.includes('VISIONOS: CDN_HTTP_403')&&e.message.includes('ANDROID_VR: CDN_HTTP_403')&&e.message.includes('WEB: NO_AUDIO_FORMAT'));}finally{a.close();}
});
test('configured native session is a fallback when locally generated sessions have no usable URLs',async()=>{
 let configured=0;
 const empty={getBasicInfo:async()=>({basic_info:{id},playability_status:{status:'OK'},streaming_data:{adaptive_formats:[]}})},ready=await client({adaptiveFormats:[{itag:140,url:'https://r1.googlevideo.com/audio',mimeType:'audio/mp4'}]});
 const a=new YouTubeAudio(async()=>new Response(audio,{headers:{'Content-Type':'audio/mp4'}}),()=>empty,{createPlayer:async()=>({}),createConfiguredClient:async()=>{configured++;return ready;}});
 try{assert.equal((await a.resolve(id)).client,'VISIONOS');assert.equal(configured,1);await a.resolve(id,{force:true});assert.equal(configured,1);}finally{a.close();}
});
test('public API/config requests remove unsafe raw referrer and cookies while retaining SDK headers',async()=>{
 let captured;
 const a=new YouTubeAudio(async(_input,options)=>{captured=options;return new Response('{}');});
 await a.youtubeFetch('https://www.youtube.com/sw.js_data',{headers:{Referer:'https://www.youtube.com/',Cookie:'PREF=example','X-Youtube-Client-Name':'101','User-Agent':'Test-UA'}});
 assert.equal(captured.headers.has('referer'),false);assert.equal(captured.headers.has('cookie'),false);assert.equal(captured.headers.get('x-youtube-client-name'),'101');assert.equal(captured.headers.get('user-agent'),'Test-UA');assert.equal(captured.credentials,'omit');a.close();
});
