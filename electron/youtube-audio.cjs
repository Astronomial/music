const {AsyncLocalStorage}=require('node:async_hooks');
const {evaluateSignature}=require('./signature-runtime.cjs');
const validVideoID=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{11}$/.test(id);
function streamURL(value){
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||!/(^|\.)googlevideo\.com$/.test(u.hostname))throw new Error('Недопустимый адрес аудиопотока.');
  return u;
}
const fail=(code)=>Object.assign(new Error(code),{playbackCode:code});
const safeCode=e=>e?.playbackCode|| (e?.name==='AbortError'?'CANCELLED':'NETWORK');
const mediaType=s=>String(s||'').split(';')[0].trim().toLowerCase();
const isAudioHeader=(type,bytes)=>type.startsWith('audio/')||type==='application/octet-stream'&&(
  bytes?.length>=8&&String.fromCharCode(...bytes.slice(4,8))==='ftyp'||
  bytes?.length>=4&&bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3);

class YouTubeAudio {
  constructor(fetch,createClient,{createPlayer}={}){this.fetch=fetch;this.createClient=createClient;this.createPlayer=createPlayer;this.client=null;this.player=null;this.cache=new Map();this.diagnostics=new Map();this.scope=new AsyncLocalStorage();this.controllers=new Set();}
  youtubeFetch(input,options={}){
    const u=new URL(typeof input==='string'?input:input.url||input.href);
    if(u.protocol!=='https:'||!(/(^|\.)youtube\.com$/.test(u.hostname)||u.hostname==='youtubei.googleapis.com'))throw fail('INVALID_API_HOST');
    const signals=[AbortSignal.timeout(12000),options.signal,this.scope.getStore()?.signal].filter(Boolean);
    return this.fetch(input,{...options,credentials:'omit',redirect:'error',signal:AbortSignal.any(signals)});
  }
  async musicClient(){
    if(!this.client)this.client=Promise.resolve().then(async()=>{
      if(this.createClient)return this.createClient();
      const {Innertube,Platform}=await import('youtubei.js');Platform.shim.eval=evaluateSignature;
      return Innertube.create({retrieve_player:false,generate_session_locally:true,fetch:(input,options)=>this.youtubeFetch(input,options)});
    }).catch(e=>{this.client=null;throw e;});return this.client;
  }
  async signaturePlayer(){
    if(!this.player||this.player.expires<Date.now()){
      const controller=new AbortController();this.controllers.add(controller);
      const entry={expires:Date.now()+15*60000,promise:null};
      entry.promise=this.scope.run({signal:controller.signal},async()=>{
        if(this.createPlayer)return this.createPlayer();
        const {Player,Platform}=await import('youtubei.js');Platform.shim.eval=evaluateSignature;
        return Player.create(undefined,(input,options)=>this.youtubeFetch(input,options));
      }).catch(e=>{if(this.player===entry)this.player=null;throw e;}).finally(()=>this.controllers.delete(controller));
      this.player=entry;
    }
    return this.player.promise;
  }
  async mediaFetch(source,range,signal){
    let url=streamURL(source.url);if(range)url.searchParams.set('range',range);
    const headers={Accept:'*/*','Accept-Encoding':'identity',Origin:'https://www.youtube.com',Referer:'https://www.youtube.com/',...(source.userAgent?{'User-Agent':source.userAgent}:{})};
    for(let redirects=0;redirects<=3;redirects++){
      signal?.throwIfAborted();
      const connect=new AbortController(),timer=setTimeout(()=>connect.abort(),15000);let response;
      try{response=await this.fetch(url.href,{credentials:'omit',redirect:'manual',signal:AbortSignal.any([connect.signal,...(signal?[signal]:[])]),headers});}finally{clearTimeout(timer);}
      if([301,302,303,307,308].includes(response.status)){
        const location=response.headers.get('location');await response.body?.cancel();
        if(!location||redirects===3)throw fail('CDN_REDIRECT');
        url=streamURL(new URL(location,url).href);if(range)url.searchParams.set('range',range);continue;
      }
      return response;
    }
    throw fail('CDN_REDIRECT');
  }
  async probe(source,signal){
    const r=await this.mediaFetch(source,'0-1023',AbortSignal.any([signal,AbortSignal.timeout(12000)]));
    if(![200,206].includes(r.status)){await r.body?.cancel();throw fail('CDN_HTTP_'+r.status);}
    const reader=r.body?.getReader();if(!reader)throw fail('CDN_EMPTY');
    try{
      let head=new Uint8Array();
      while(head.length<12){const {value,done}=await reader.read();if(done)break;const next=new Uint8Array(head.length+Math.min(value.length,12-head.length));next.set(head);next.set(value.slice(0,next.length-head.length),head.length);head=next;}
      if(!head.length)throw fail('CDN_EMPTY');
      if(!isAudioHeader(mediaType(r.headers.get('content-type')),head))throw fail('CDN_NOT_AUDIO');
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  async lookup(id,client,signal){
    const api=await this.musicClient();signal.throwIfAborted();
    if(client==='WEB'){const player=await this.signaturePlayer();if(api.session)api.session.player=player;}
    const info=await this.scope.run({signal},()=>api.getBasicInfo(id,{client}));signal.throwIfAborted();
    if(info.basic_info?.id!==id)throw fail('WRONG_VIDEO');
    if(info.playability_status?.status!=='OK')throw fail('VIDEO_UNAVAILABLE');
    const formats=(info.streaming_data?.adaptive_formats||[]).filter(f=>f.has_audio&&!f.has_video&&(f.url||f.signature_cipher||f.cipher)&&/^audio\/(mp4|webm)/.test(f.mime_type||'')&&f.audio_track?.audio_is_default!==false);
    formats.sort((a,b)=>Number(b.mime_type.includes('audio/mp4'))-Number(a.mime_type.includes('audio/mp4'))||Math.abs((a.bitrate||128000)-128000)-Math.abs((b.bitrate||128000)-128000));
    if(!formats.length)throw fail('NO_AUDIO_FORMAT');
    const {Constants}=await import('youtubei.js');let last;
    for(const f of formats.slice(0,2))try{
      const raw=f.url&&new URL(f.url),needsSignature=f.signature_cipher||f.cipher||raw?.searchParams.has('n');
      let url=f.url;
      if(needsSignature){
        const player=await this.signaturePlayer();signal.throwIfAborted();
        if(typeof f.decipher!=='function')throw fail('SIGNATURE_UNAVAILABLE');
        try{url=await f.decipher(player);}catch{throw fail('SIGNATURE_FAILED');}
      }
      const u=streamURL(url);if(typeof info.cpn==='string'&&/^[\w-]{16}$/.test(info.cpn))u.searchParams.set('cpn',info.cpn);
      const source={url:u.href,mime:mediaType(f.mime_type),length:Number(f.content_length)||0,client,userAgent:Constants.CLIENTS[client]?.USER_AGENT||api.session?.user_agent};
      await this.probe(source,signal);signal.throwIfAborted();return source;
    }catch(e){signal.throwIfAborted();last=e;}
    throw last;
  }
  async resolve(id,{force=false}={}){
    if(!validVideoID(id))throw fail('INVALID_VIDEO');
    const old=this.cache.get(id);if(old?.pending||!force&&old?.expires>Date.now())return old.promise;
    if(force&&this.player)this.player.expires=0;
    const controller=new AbortController();this.controllers.add(controller);const failures=[];
    const entry={pending:true,promise:null,expires:0};
    entry.promise=(async()=>{
      let wake;
      const attempt=async client=>{try{return await this.lookup(id,client,controller.signal);}catch(e){controller.signal.throwIfAborted();failures.push({client,code:safeCode(e)});throw e;}};
      const primary=attempt('VISIONOS').catch(e=>{wake?.();throw e;});
      const secondary=(async()=>{await new Promise(r=>{const timer=setTimeout(r,250);wake=()=>{clearTimeout(timer);r();};controller.signal.addEventListener('abort',wake,{once:true});});controller.signal.throwIfAborted();return attempt('ANDROID_VR');})();
      try{
        let source;
        try{source=await Promise.any([primary,secondary]);}
        catch{controller.signal.throwIfAborted();source=await attempt('WEB');}
        const expiry=Number(new URL(source.url).searchParams.get('expire'))*1000;
        entry.expires=Math.min(Date.now()+10*60000,expiry>Date.now()?expiry-60000:Infinity);entry.pending=false;
        this.diagnostics.delete(id);return source;
      }catch(e){
        if(this.cache.get(id)===entry)this.cache.delete(id);this.diagnostics.set(id,{code:safeCode(e),attempts:failures});
        if(this.diagnostics.size>48)this.diagnostics.delete(this.diagnostics.keys().next().value);
        throw Object.assign(new Error('Аудиопоток YouTube недоступен ('+safeCode(e)+'). Нажми воспроизведение, чтобы повторить.'),{playbackCode:safeCode(e)});
      }finally{controller.abort();wake?.();this.controllers.delete(controller);}
    })();
    this.cache.set(id,entry);if(this.cache.size>48)for(const [key,value]of this.cache)if(!value.pending&&key!==id){this.cache.delete(key);if(this.cache.size<=48)break;}
    return entry.promise;
  }
  async prepare(ids){const results=await Promise.allSettled([...new Set(ids.filter(validVideoID))].slice(0,3).map(id=>this.resolve(id)));return results.filter(r=>r.status==='fulfilled').length;}
  error(id){const e=this.diagnostics.get(id);return e?'Не удалось запустить аудио YouTube ('+e.code+'). Попробуй повторить воспроизведение.':'';}
  async respond(id,request){
    if(!validVideoID(id))return new Response(null,{status:404});
    const requested=request.headers.get('range');if(requested&&!/^bytes=(\d+-\d*|-\d+)$/.test(requested))return new Response(null,{status:416});
    try{
      request.signal?.throwIfAborted();
      for(let attempt=0;attempt<2;attempt++){
        const source=await this.resolve(id,{force:attempt>0});request.signal?.throwIfAborted();
        let range=requested?.slice(6);let start=0,end=source.length-1;
        if(range&&source.length){const [a,b]=range.split('-');start=a?Number(a):Math.max(0,source.length-Number(b));end=a&&b?Math.min(Number(b),source.length-1):source.length-1;if(start>end||start>=source.length)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${source.length}`}});range=`${start}-${end}`;}
        const r=await this.mediaFetch(source,range,request.signal);
        if([401,403,410].includes(r.status)&&attempt===0){await r.body?.cancel();continue;}
        if(r.status===416){await r.body?.cancel();return new Response(null,{status:416,headers:source.length?{'Content-Range':`bytes */${source.length}`}:{}});}
        if(![200,206].includes(r.status)||!r.body){await r.body?.cancel();throw fail('CDN_HTTP_'+r.status);}
        const type=mediaType(r.headers.get('content-type'));if(!type.startsWith('audio/')&&type!=='application/octet-stream'){await r.body.cancel();throw fail('CDN_NOT_AUDIO');}
        const headers={'Cache-Control':'no-store','Content-Type':source.mime,'Accept-Ranges':'bytes'};
        for(const key of ['content-length','content-range'])if(r.headers.has(key))headers[key]=r.headers.get(key);
        // Google Video query ranges can arrive as HTTP 200; expose proper byte semantics to Chromium.
        if(requested&&range&&source.length&&!r.headers.has('content-range')){
          const bytes=Number(r.headers.get('content-length'));
          if(bytes&&bytes!==end-start+1){await r.body.cancel();throw fail('CDN_RANGE_MISMATCH');}
          headers['Content-Range']=`bytes ${start}-${end}/${source.length}`;headers['Content-Length']=String(end-start+1);
        }
        return new Response(r.body,{status:requested&&source.length?206:r.status,headers});
      }
    }catch(e){if(!request.signal?.aborted)this.diagnostics.set(id,{code:safeCode(e)});return new Response(null,{status:request.signal?.aborted?499:502});}
    return new Response(null,{status:502});
  }
  close(){for(const c of this.controllers)c.abort();this.cache.clear();}
}
module.exports={YouTubeAudio,streamURL,validVideoID};
