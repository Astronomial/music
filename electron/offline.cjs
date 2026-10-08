const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { Readable } = require('node:stream');
const { Store } = require('./storage.cjs');
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9]{1,40}$/.test(id);
function audioMime(buffer) {
  if (buffer.subarray(0,3).toString() === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (buffer.subarray(0,4).toString() === 'fLaC') return 'audio/flac';
  if (buffer.subarray(0,4).toString() === 'OggS') return 'audio/ogg';
  if (buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WAVE') return 'audio/wav';
  if (buffer.subarray(4,8).toString() === 'ftyp') return 'audio/mp4';
  return null;
}
class OfflineLibrary {
  constructor(dir) { this.dir = dir; this.store = new Store(dir); this.manifest = {}; this.active = new Map(); this.reserved = new Map(); }
  async init() {
    await fs.mkdir(this.dir,{recursive:true});
    this.manifest = await this.store.read('downloads.json',{});
    for (const id of Object.keys(this.manifest)) {
      if (!validId(id)) { delete this.manifest[id]; continue; }
      try { await fs.access(this.file(id)); } catch { delete this.manifest[id]; }
    }
    for (const name of await fs.readdir(this.dir)) if (name.endsWith('.part')) await fs.rm(path.join(this.dir,name),{force:true});
  }
  file(id) { if (!validId(id)) throw new Error('Некорректный ID трека'); return path.join(this.dir,id+'.audio'); }
  list() { return { ...this.manifest }; }
  persist() { return this.store.write('downloads.json', this.manifest); }
  cancel(id) { this.active.get(id)?.abort(); }
  async download(track, fetchAudio, notify = () => {}) {
    const id = track.id; this.file(id);
    if (!track.downloadable) throw new Error('Автор не разрешил свободное скачивание этого трека.');
    if (this.manifest[id]) return this.manifest[id];
    if (this.active.has(id)) throw new Error('Трек уже загружается');
    if (this.active.size >= 2) throw new Error('Дождись завершения текущих загрузок');
    const used = Object.values(this.manifest).reduce((sum,m)=>sum+m.bytes,0);
    if (used >= 10 * 1024**3) throw new Error('Хранилище заполнено (10 ГБ). Удали несколько загрузок.');
    const controller = new AbortController(); this.active.set(id,controller);
    this.reserved.set(id,0);
    const timer = setTimeout(()=>controller.abort(),180000);
    const temp = this.file(id)+'.part'; let handle;
    try {
      const response = await fetchAudio(controller.signal);
      if (!response.ok || !response.body) throw new Error('Audius не разрешил загрузку или файл недоступен');
      const total = Number(response.headers.get('content-length')) || 0;
      if (total > 350 * 1024**2) throw new Error('Размер файла превышает 350 МБ');
      handle = await fs.open(temp,'w');
      let bytes = 0, head = Buffer.alloc(0), lastNotification = 0;
      for await (const chunk of response.body) {
        controller.signal.throwIfAborted();
        const buffer = Buffer.from(chunk);
        if (head.length < 32) head = Buffer.concat([head,buffer]).subarray(0,32);
        bytes += buffer.length;
        this.reserved.set(id,bytes);
        const committed = Object.values(this.manifest).reduce((sum,m)=>sum+m.bytes,0);
        const pending = [...this.reserved.values()].reduce((sum,n)=>sum+n,0);
        if (bytes > 350*1024**2 || committed + pending > 10*1024**3) throw new Error('Недостаточно места в хранилище');
        await handle.write(buffer);
        if (Date.now()-lastNotification > 200) { notify({ id, bytes, total }); lastNotification = Date.now(); }
      }
      const mime = audioMime(head);
      if (!bytes || !mime || (total && bytes !== total)) throw new Error('Файл не является полным аудиотреком');
      await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temp,this.file(id));
      this.manifest[id] = { track, bytes, mime, savedAt: Date.now() };
      this.reserved.delete(id);
      await this.persist(); notify({id,bytes,total:bytes,done:true});
      return this.manifest[id];
    } catch (error) {
      await handle?.close(); await fs.rm(temp,{force:true});
      throw new Error(controller.signal.aborted ? 'Загрузка отменена или превышено время ожидания' : error.message);
    } finally { clearTimeout(timer); this.active.delete(id); this.reserved.delete(id); }
  }
  async remove(id) {
    this.file(id);
    if (this.active.has(id)) throw new Error('Сначала отмени загрузку');
    await fs.rm(this.file(id),{force:true}); delete this.manifest[id]; await this.persist(); return this.list();
  }
  async respond(id, range) {
    if (!validId(id) || !this.manifest[id]) return new Response('Not found',{status:404});
    let size;
    try { size = (await fs.stat(this.file(id))).size; } catch { return new Response('Not found',{status:404}); }
    let start = 0, end = size-1;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (!m[1]&&!m[2])) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});
      if (m[1]) { start=Number(m[1]); end=m[2]?Math.min(Number(m[2]),end):end; }
      else start=Math.max(0,size-Number(m[2]));
      if (start>end || start>=size) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});
    }
    const headers = { 'Content-Type':this.manifest[id].mime, 'Accept-Ranges':'bytes', 'Content-Length':String(end-start+1) };
    if (range) headers['Content-Range']=`bytes ${start}-${end}/${size}`;
    return new Response(Readable.toWeb(createReadStream(this.file(id),{start,end})),{status:range?206:200,headers});
  }
}
module.exports = { OfflineLibrary, audioMime, validId };
