const {AsyncLocalStorage}=require('node:async_hooks');
const validVideoID=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{11}$/.test(id);
function streamURL(value){
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||!/(^|\.)googlevideo\.com$/.test(u.hostname))throw new Error('Недопустимый адрес аудиопотока.');
  return u;
}

// Public audio only. No cookies, login, private video access or durable stream URLs.
// Each extractor operation owns its abort scope, including concurrent preloads.
class YouTubeAudio {
  constructor(fetch,createClient){this.fetch=fetch;this.createClient=createClient;this.client=null;this.cache=new Map();this.scope=new AsyncLocalStorage();this.controllers=new Set();}
  async musicClient(){
    if(!this.client)this.client=Promise.resolve().then(async()=>{
      if(this.createClient)return this.createClient();
      const {Innertube}=await import('youtubei.js');
      return Innertube.create({retrieve_player:false,generate_session_locally:true,fetch:(input,options={})=>{
        const u=new URL(typeof input==='string'?input:input.url||input.href);
        if(u.protocol!=='https:'||!(/(^|\.)youtube\.com$/.test(u.hostname)||u.hostname==='youtubei.googleapis.com'))throw new Error('Недопустимый запрос аудио.');
        const signals=[AbortSignal.timeout(12000),options.signal,this.scope.getStore()?.signal].filter(Boolean);
        return this.fetch(input,{...options,credentials:'omit',redirect:'error',signal:AbortSignal.any(signals)});
      }});
    }).catch(e=>{this.client=null;throw e;});
    return this.client;
  }
  async lookup(id,client,signal){
    const api=await this.musicClient();signal.throwIfAborted();
    const info=await this.scope.run({signal},()=>api.getBasicInfo(id,{client}));signal.throwIfAborted();
    if(info.basic_info?.id&&info.basic_info.id!==id)throw new Error('Источник вернул другой трек.');
    if(info.playability_status?.status!=='OK')throw new Error('Этот трек недоступен для воспроизведения.');
    const formats=(info.streaming_data?.adaptive_formats||[]).filter(f=>f.has_audio&&!f.has_video&&f.url&&/^audio\/(mp4|webm)/.test(f.mime_type||'')&&f.audio_track?.audio_is_default!==false);
    // Prefer AAC for predictable Windows decoding and a modest mobile-sized stream.
    formats.sort((a,b)=>Number(b.mime_type.includes('audio/mp4'))-Number(a.mime_type.includes('audio/mp4'))||Math.abs((a.bitrate||128000)-128000)-Math.abs((b.bitrate||128000)-128000));
    if(!formats.length)throw new Error('YouTube не предоставил доступный аудиопоток.');
    return streamURL(formats[0].url).href;
  }
  async resolve(id,{force=false}={}){
    if(!validVideoID(id))throw new Error('Некорректный трек YouTube.');
    const old=this.cache.get(id);
    if(old?.pending||!force&&old?.expires>Date.now())return old.promise;
    const controller=new AbortController();this.controllers.add(controller);
    let wake;
    const entry={pending:true,promise:null,expires:0};
    entry.promise=(async()=>{
      const primary=this.lookup(id,'IOS',controller.signal).catch(e=>{wake?.();throw e;});
      const secondary=(async()=>{await new Promise(r=>{const timer=setTimeout(r,250);wake=()=>{clearTimeout(timer);r();};controller.signal.addEventListener('abort',wake,{once:true});});controller.signal.throwIfAborted();return this.lookup(id,'ANDROID_VR',controller.signal);})();
      try{
        const url=await Promise.any([primary,secondary]);
        const expiry=Number(new URL(url).searchParams.get('expire'))*1000;
        entry.expires=Math.min(Date.now()+10*60000,expiry>Date.now()?expiry-60000:Infinity);entry.pending=false;
        return url;
      }catch{if(this.cache.get(id)===entry)this.cache.delete(id);throw new Error('Не удалось получить аудио YouTube. Проверь доступ к сервису и попробуй ещё раз.');}
      finally{controller.abort();wake?.();this.controllers.delete(controller);}
    })();
    this.cache.set(id,entry);
    if(this.cache.size>48)for(const [key,value]of this.cache)if(!value.pending&&key!==id){this.cache.delete(key);if(this.cache.size<=48)break;}
    return entry.promise;
  }
  async prepare(ids){return Promise.allSettled([...new Set(ids.filter(validVideoID))].slice(0,3).map(id=>this.resolve(id)));}
  async respond(id,request){
    if(!validVideoID(id))return new Response(null,{status:404});
    const range=request.headers.get('range');
    if(range&&!/^bytes=(\d+-\d*|-\d+)$/.test(range))return new Response(null,{status:416});
    try{
      for(let attempt=0;attempt<2;attempt++){
        const url=streamURL(await this.resolve(id,{force:attempt>0}));
        request.signal?.throwIfAborted();
        const connect=new AbortController(),timer=setTimeout(()=>connect.abort(),18000);
        let response;
        try{response=await this.fetch(url.href,{credentials:'omit',redirect:'error',signal:AbortSignal.any([connect.signal,...(request.signal?[request.signal]:[])]),headers:range?{Range:range}:{}});}
        finally{clearTimeout(timer);}
        if([401,403,410].includes(response.status)&&attempt===0){await response.body?.cancel();continue;}
        if(response.status===416){await response.body?.cancel();return new Response(null,{status:416,headers:response.headers.has('content-range')?{'Content-Range':response.headers.get('content-range')}:{}});}
        if(![200,206].includes(response.status)||!response.body||!/^audio\//i.test(response.headers.get('content-type')||'')){await response.body?.cancel();throw new Error('Поток недоступен');}
        const headers={'Cache-Control':'no-store'};
        for(const key of ['content-type','content-length','content-range','accept-ranges'])if(response.headers.has(key))headers[key]=response.headers.get(key);
        return new Response(response.body,{status:response.status,headers});
      }
    }catch{ return new Response(null,{status:request.signal?.aborted?499:502}); }
    return new Response(null,{status:502});
  }
  close(){for(const c of this.controllers)c.abort();this.cache.clear();}
}
module.exports={YouTubeAudio,streamURL,validVideoID};
