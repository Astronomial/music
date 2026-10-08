const fs=require('node:fs/promises');
const {createReadStream}=require('node:fs');
const {Readable}=require('node:stream');
const {createHash}=require('node:crypto');
const path=require('node:path');
const supported=new Set(['.mp3','.flac','.ogg','.opus','.wav','.m4a','.mp4']);
async function folderFiles(dir,files=[],depth=0){
  if(depth>12)return files;
  for(const entry of await fs.readdir(dir,{withFileTypes:true})){
    if(files.length>=2000)throw new Error('В одной папке поддерживается до 2000 музыкальных файлов. Выбери папку поменьше.');
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())await folderFiles(full,files,depth+1);
    else if(entry.isFile()&&supported.has(path.extname(entry.name).toLowerCase()))files.push(full);
  }
  return files;
}
async function importLocalFile(file,offline){
  if(!supported.has(path.extname(file).toLowerCase()))throw new Error('Этот формат не поддерживается.');
  const stat=await fs.stat(file);if(!stat.isFile()||stat.size>350*1024**2)throw new Error('Файл должен быть меньше 350 МБ.');
  const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
  const id='local'+hash.digest('hex').slice(0,32);if(offline.manifest[id])return offline.manifest[id];
  const {parseFile}=await import('music-metadata'),{normalizeTrack}=await import('../src/core/model.mjs');
  const metadata=await parseFile(file,{duration:true,skipCovers:false});
  const common=metadata.common,basename=path.basename(file,path.extname(file)),parts=/^(.+?)\s+[—–-]\s+(.+)$/.exec(basename);
  const artist=common.artist||common.artists?.join(', ')||parts?.[1]||'Неизвестный исполнитель';
  const picture=common.picture?.find(p=>['image/jpeg','image/png'].includes(p.format)&&p.data.length<=2*1024**2);
  const track=normalizeTrack({id,source:'local',title:common.title||parts?.[2]||basename,artist,artistId:`local_${artist.toLowerCase().trim()}`,genre:common.genre?.[0]||'',album:common.album||'',duration:metadata.format.duration||0,bpm:common.bpm||0,artwork:picture?`forma-audio://art/${id}`:'',downloadable:true});
  const stored=await offline.download(track,async()=>new Response(Readable.toWeb(createReadStream(file)),{headers:{'content-length':String(stat.size)}}));
  if(picture){try{await fs.writeFile(offline.file(id)+'.cover',picture.data);stored.coverMime=picture.format;await offline.persist();}catch{stored.track.artwork='';await offline.persist();}}
  return stored;
}
module.exports={folderFiles,importLocalFile};
