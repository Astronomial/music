const LIMIT=6*1024*1024;
class SoundAudio {
  constructor(fetch,createClient,{resolveSource,fetchSource}={}){this.fetch=fetch;this.createClient=createClient;this.resolveSource=resolveSource;this.fetchSource=fetchSource;this.client=null;this.active=null;}
  cancel(){this.active?.abort();}
  async load(videoID){if(!/^[A-Za-z0-9_-]{11}$/.test(videoID))throw new Error('Некорректный трек');this.cancel();const controller=new AbortController();this.active=controller;
    try{let source,resolved;
      if(this.resolveSource){
        // Share the player's deciphered/probed source. Analysis cancellation must
        // never abort the shared extraction or invalidate its playback cache.
        resolved=await this.resolveSource(videoID);controller.signal.throwIfAborted();
        if(resolved.kind==='hls'||!/^audio\/(mp4|webm)(?:;|$)/i.test(resolved.mime||''))throw new Error('Аудио для анализа пока недоступно');
        if(resolved.length>LIMIT)throw new Error('Трек превышает лимит анализа');
        source=resolved.url;
      }else{if(!this.client&&this.createClient)this.client=await this.createClient();
      if(!this.client){const {Innertube}=await import('youtubei.js');this.client=await Innertube.create({retrieve_player:false,generate_session_locally:true,fetch:(input,options={})=>{const u=new URL(typeof input==='string'?input:input.url||input.href);if(u.protocol!=='https:'||!(/(^|\.)youtube\.com$/.test(u.hostname)||u.hostname==='youtubei.googleapis.com'))throw new Error('Недопустимый адрес анализа');return this.fetch(input,{...options,signal:AbortSignal.any([this.active?.signal||AbortSignal.timeout(20000),AbortSignal.timeout(20000)]),redirect:'error'});}});}
      controller.signal.throwIfAborted();
      for(const client of ['IOS','ANDROID_VR']){try{const info=await this.client.getBasicInfo(videoID,{client});controller.signal.throwIfAborted();const formats=info.streaming_data?.adaptive_formats||[];const f=formats.filter(f=>f.has_audio&&!f.has_video&&f.mime_type?.includes('audio/mp4')&&f.url&&(!f.content_length||Number(f.content_length)<=LIMIT)).sort((a,b)=>a.bitrate-b.bitrate)[0];if(f){source=f.url;break;}}catch(e){if(controller.signal.aborted)throw e;}}
      }
      if(!source)throw new Error('Аудио для анализа пока недоступно');const u=new URL(source);if(u.protocol!=='https:'||u.username||u.password||u.port||!/(^|\.)googlevideo\.com$/.test(u.hostname))throw new Error('Недопустимый поток анализа');
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(25000)]);
      const r=await(resolved?this.fetchSource(resolved,signal):this.fetch(u.href,{signal,redirect:'error'}));if(!r.ok){await r.body?.cancel();throw new Error('Аудио для анализа пока недоступно');}if(Number(r.headers.get('content-length'))>LIMIT){await r.body?.cancel();throw new Error('Трек превышает лимит анализа');}
      const reader=r.body.getReader(),parts=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>LIMIT)throw new Error('Трек превышает лимит анализа');parts.push(value);}const result=new Uint8Array(size);let at=0;for(const p of parts){result.set(p,at);at+=p.length;}return result;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    }finally{if(this.active===controller)this.active=null;}
  }
}
module.exports={SoundAudio};
