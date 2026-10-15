const {createHash}=require('node:crypto');
const invalid=code=>Object.assign(new Error(code),{playbackCode:code});
const MAX_MANIFEST=1024*1024;
function attrs(line){const result={};for(const m of line.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,\s]*))/g))result[m[1]]=m[2]??m[3];return result;}
function onlyAudio(codecs){return /(?:mp4a|aac|opus|vorbis|ac-3|ec-3)/i.test(codecs||'')&&!/(?:avc|hev|hvc|vp0?[89]|av01|dvh|dvhe)/i.test(codecs);}
function audioVariants(text,base,validate){
  const lines=text.split(/\r?\n/),out=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i].trim(),a=attrs(line);
    if(line.startsWith('#EXT-X-MEDIA:')&&a.TYPE==='AUDIO'&&a.URI&&a.DEFAULT!=='NO')out.push({url:validate(new URL(a.URI,base).href).href,bitrate:128000,default:a.DEFAULT==='YES'});
    if(line.startsWith('#EXT-X-STREAM-INF:')&&onlyAudio(a.CODECS)&&!a.RESOLUTION){
      const uri=lines.slice(i+1).find(s=>s.trim()&&!s.startsWith('#'))?.trim();
      if(uri)out.push({url:validate(new URL(uri,base).href).href,bitrate:Number(a['AVERAGE-BANDWIDTH']||a.BANDWIDTH)||128000});
    }
  }
  return out.sort((a,b)=>Number(b.default)-Number(a.default)||Math.abs(a.bitrate-128000)-Math.abs(b.bitrate-128000));
}
async function manifestText(response){
  if(!response.ok||!response.body){await response.body?.cancel();throw invalid('HLS_HTTP_'+response.status);}
  if(Number(response.headers.get('content-length'))>MAX_MANIFEST){await response.body.cancel();throw invalid('HLS_TOO_LARGE');}
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_MANIFEST)throw invalid('HLS_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const text=Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/,'');if(!text.startsWith('#EXTM3U'))throw invalid('HLS_INVALID_MANIFEST');return text;
}
class HlsAudio {
  constructor(fetch,validate){this.fetch=fetch;this.validate=validate;this.resources=new Map();}
  resource(id,source,url,kind){
    const safe=this.validate(url).href,key=createHash('sha256').update(id+'\0'+safe).digest('hex').slice(0,32);
    this.resources.set(key,{id,source:{...source,url:safe},kind,expires:Date.now()+15*60000});
    if(this.resources.size>2048)for(const k of this.resources.keys()){this.resources.delete(k);if(this.resources.size<=1536)break;}
    return `forma-stream://youtube/${id}/hls/${key}${kind==='manifest'?'.m3u8':''}`;
  }
  async resolve(id,source,signal){
    const master=await this.fetch(source,null,signal),text=await manifestText(master);
    const variants=audioVariants(text,master.url||source.url,this.validate);if(!variants.length)throw invalid('HLS_NO_AUDIO_VARIANT');
    let last;
    for(const variant of variants.slice(0,3))try{
      const response=await this.fetch({...source,url:variant.url},null,signal),playlist=await manifestText(response),selected={...source,url:response.url||variant.url};
      if(!playlist.includes('#EXTINF:'))throw invalid('HLS_NOT_MEDIA_PLAYLIST');
      // Validate every referenced host before exposing the playlist to HLS.js.
      this.rewrite(id,selected,playlist);
      const first=playlist.split(/\r?\n/).map(l=>l.trim()).find(l=>l&&!l.startsWith('#'));if(!first)throw invalid('HLS_EMPTY');
      const probe=await this.fetch({...selected,url:this.validate(new URL(first,selected.url).href).href},'0-1023',signal);
      if(![200,206].includes(probe.status)){await probe.body?.cancel();throw invalid('HLS_SEGMENT_HTTP_'+probe.status);}
      const reader=probe.body?.getReader();if(!reader)throw invalid('HLS_EMPTY');
      try{let head=Buffer.alloc(0);while(head.length<12){const{value,done}=await reader.read();if(done)break;head=Buffer.concat([head,Buffer.from(value.subarray(0,12-head.length))]);}if(!head.length||!(head[0]===0x47||head[0]===0xff&&((head[1]||0)&0xf0)===0xf0||['ftyp','styp','moof'].includes(head.subarray(4,8).toString())||probe.headers.get('content-type')?.startsWith('audio/')))throw invalid('HLS_NOT_AUDIO');}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      return{...selected,kind:'hls',mime:'application/vnd.apple.mpegurl',...(playlist.includes('#EXT-X-ENDLIST')?{playlist}:{})};
    }catch(e){signal?.throwIfAborted();last=e;}
    throw last||invalid('HLS_NO_AUDIO_VARIANT');
  }
  rewrite(id,source,text){
    return text.split(/\r?\n/).map(line=>{
      if(line.startsWith('#EXT-X-KEY:')&&!['NONE','AES-128'].includes(attrs(line).METHOD))throw invalid('HLS_ENCRYPTION_UNSUPPORTED');
      if(line.startsWith('#'))return line.replace(/URI="([^"]+)"/g,(_m,uri)=>'URI="'+this.resource(id,source,new URL(uri,source.url).href,line.startsWith('#EXT-X-MEDIA:')?'manifest':'data')+'"');
      if(!line.trim())return line;
      return this.resource(id,source,new URL(line.trim(),source.url).href,line.includes('.m3u8')?'manifest':'data');
    }).join('\n');
  }
  async respond(id,key,request){
    const entry=this.resources.get(key);if(!entry||entry.id!==id||entry.expires<Date.now())return new Response(null,{status:410});
    const range=request.headers.get('range');if(range&&!/^bytes=\d+-\d*$/.test(range))return new Response(null,{status:416});
    const response=await this.fetch(entry.source,range?.slice(6),request.signal);
    if(entry.kind==='manifest')return new Response(this.rewrite(id,{...entry.source,url:response.url||entry.source.url},await manifestText(response)),{headers:{'Content-Type':'application/vnd.apple.mpegurl','Cache-Control':'no-store'}});
    const headers={'Cache-Control':'no-store'};for(const key of ['content-type','content-length','content-range'])if(response.headers.has(key))headers[key]=response.headers.get(key);
    // A query byte range can be returned as 200 by the CDN. HLS's loader uses
    // the requested range directly; preserve any real Content-Range it provides.
    return new Response(response.body,{status:response.status,headers});
  }
  close(){this.resources.clear();}
}
module.exports={HlsAudio,audioVariants,manifestText,onlyAudio};
