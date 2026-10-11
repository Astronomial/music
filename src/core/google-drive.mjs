// Drive v3 appDataFolder: each device writes only its own document. Concurrent
// devices never PUT the same file. The CRDT merges their independently saved edits.
const API='https://www.googleapis.com/drive/v3',UPLOAD='https://www.googleapis.com/upload/drive/v3';
const maxBytes=12*1024*1024;
export class GoogleDriveLibrary {
  constructor(request){this.request=request;}
  async json(url,options={}){const r=await this.request(url,{...options,redirect:'error',signal:options.signal||AbortSignal.timeout(18000)});if(!r.ok){await r.body?.cancel();throw new Error(`Google Drive: ${r.status}`);}return boundedJSON(r);}
  async files(){let page='',result=[];do{const q=new URLSearchParams({spaces:'appDataFolder',q:"trashed = false and appProperties has { key='formaSchema' and value='2' }",fields:'nextPageToken,files(id,name,appProperties)',pageSize:'100',...(page?{pageToken:page}:{})});const r=await this.json(API+'/files?'+q);if(!Array.isArray(r.files))throw new Error('Некорректный ответ Google Drive');result.push(...r.files);if(result.length>100)throw new Error('Слишком много устройств в облачной библиотеке');page=r.nextPageToken||'';}while(page);return result.filter(f=>typeof f.id==='string'&&/^[\w-]{5,200}$/.test(f.id));}
  async download(id){return this.json(API+'/files/'+encodeURIComponent(id)+'?alt=media');}
  async upload(document,files){const body=JSON.stringify(document);if(new TextEncoder().encode(body).length>maxBytes)throw new Error('Облачная библиотека превышает 12 МБ');const own=files.find(f=>f.appProperties?.actor===document.actor);if(own){await this.json(UPLOAD+'/files/'+encodeURIComponent(own.id)+'?uploadType=media&fields=id',{method:'PATCH',headers:{'Content-Type':'application/json'},body});return own.id;}
    const boundary='forma_'+document.actor.replace(/[^\w]/g,''),metadata={name:'forma-device-'+document.actor+'.json',parents:['appDataFolder'],appProperties:{formaSchema:'2',actor:document.actor}};
    const data=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--\r\n`;
    return (await this.json(UPLOAD+'/files?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body:data})).id;
  }
}
export async function boundedJSON(response,limit=maxBytes){if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw new Error('Слишком большой ответ');}const reader=response.body.getReader(),parts=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error('Слишком большой ответ');parts.push(value);}const all=new Uint8Array(size);let at=0;for(const p of parts){all.set(p,at);at+=p.length;}return JSON.parse(new TextDecoder().decode(all));}catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}}
