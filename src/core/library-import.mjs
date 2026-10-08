import { normalizeText, textSimilarity } from './search.mjs';
import { normalizeTrack, mergeTracks } from './model.mjs';
export const IMPORT_LIMIT=5000;
export function parseYandexPlaylistURL(value) {
  let url;
  try {url=new URL(String(value).trim());}catch{throw new Error('Вставь полную ссылку на публичный плейлист Яндекс Музыки.');}
  if(url.protocol!=='https:'||url.username||url.password||url.port||!/^music\.yandex\.(ru|com|kz|by|uz)$/.test(url.hostname))throw new Error('Нужна ссылка вида https://music.yandex.ru/playlists/…');
  const modern=/^\/playlists\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i.exec(url.pathname);
  if(modern)return {path:`/playlist/${modern[1]}`,url:`${url.origin}${url.pathname}`};
  const legacy=/^\/users\/([^/]{1,100})\/playlists\/(\d{1,12})\/?$/.exec(url.pathname);
  if(legacy){const owner=decodeURIComponent(legacy[1]);if(!/^[\p{L}\p{N}_.@-]+$/u.test(owner))throw new Error('Некорректная ссылка на плейлист.');return {path:`/users/${encodeURIComponent(owner)}/playlists/${legacy[2]}`,url:`${url.origin}${url.pathname}`};}
  throw new Error('Скопируй ссылку через «Поделиться» у публичного плейлиста. Ссылки на альбомы и треки не подходят.');
}
export function externalTrack(raw) {
  const t=raw.track||raw;
  const title=String(t.title||t.name||t['Track name']||t['Название']||'').trim();
  let artists=t.artists||t.artist||t['Artist name']||t['Исполнитель']||[];
  if(!Array.isArray(artists))artists=String(artists).split(/\s*;\s*/);
  artists=artists.map(a=>String(typeof a==='object'?a.name||a.title||'':a).trim()).filter(Boolean);
  if(!title)return null;
  const duration=Number(t.duration ?? (t.durationMs? t.durationMs/1000:t.duration_ms? t.duration_ms/1000:0))||0;
  return {title:title.slice(0,300),artists:artists.slice(0,10),duration,yandexId:String(t.id||''),source:'yandex',key:normalizeText(`${artists.join(' ')} ${title}`)};
}
export function parseYandexPlaylist(data,sourceURL='') {
  const result=data.result||data,playlist=result.playlist||result;
  const raw=playlist.tracks||[];
  if(!Array.isArray(raw))throw new Error('Сервис вернул плейлист без списка треков.');
  if(raw.length>IMPORT_LIMIT||Number(playlist.trackCount)>IMPORT_LIMIT)throw new Error(`В одном импорте поддерживается до ${IMPORT_LIMIT} треков.`);
  const tracks=raw.map(externalTrack).filter(Boolean);
  if(!tracks.length)throw new Error('Плейлист пуст или его состав недоступен. Проверь, что он публичный.');
  if(Number(playlist.trackCount)>tracks.length)throw new Error('Сервис вернул неполный состав плейлиста. Импорт остановлен, чтобы не потерять треки. Можно использовать файл экспорта.');
  return {name:String(playlist.title||'Из Яндекс Музыки').slice(0,100),sourceURL,tracks};
}
function parseDelimited(text,delimiter) {
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(c===delimiter&&!quoted){row.push(cell.trim());cell='';}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell.trim());if(row.some(Boolean))rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  if(quoted)throw new Error('В CSV есть незакрытые кавычки. Проверь файл экспорта.');
  row.push(cell.trim());if(row.some(Boolean))rows.push(row);return rows;
}
export function parseImportFile(text,filename='library.json') {
  text=String(text).replace(/^\uFEFF/,'').trim();
  if(!text)throw new Error('Файл пуст.');
  if(text.length>10*1024**2)throw new Error('Файл должен быть меньше 10 МБ.');
  let name=filename.replace(/\.[^.]+$/,''),raw=[];
  if(text.startsWith('{')||text.startsWith('[')){
    let data;try{data=JSON.parse(text);}catch{throw new Error('Не удалось прочитать JSON. Проверь формат экспорта.');}
    const p=data.result?.playlist||data.result||data.playlist||data;
    name=p.title||p.name||name;raw=Array.isArray(p)?p:p.tracks||p.likedTracks||p.likes;
    if(!Array.isArray(raw))throw new Error('В JSON нужен массив tracks с названиями и исполнителями.');
  }else{
    const line=text.split(/\r?\n/)[0];
    const delimiter=['\t',';',','].sort((a,b)=>line.split(b).length-line.split(a).length)[0];
    const rows=parseDelimited(text,delimiter),headers=rows[0].map(normalizeText);
    const titleIndex=headers.findIndex(h=>['title','track name','track','название','название трека','name'].includes(h));
    const artistIndex=headers.findIndex(h=>['artist','artists','artist name','исполнитель','артист'].includes(h));
    if(titleIndex>=0)raw=rows.slice(1).map(r=>({title:r[titleIndex],artist:r[artistIndex]}));
    else raw=text.split(/\r?\n/).filter(Boolean).map(line=>{const match=/^(.+?)\s+[—–-]\s+(.+)$/.exec(line);if(!match)throw new Error('В текстовом списке нужна строка «Исполнитель — Название».');return {artist:match[1],title:match[2]};});
  }
  if(raw.length>IMPORT_LIMIT)throw new Error(`В одном импорте поддерживается до ${IMPORT_LIMIT} треков.`);
  const tracks=raw.map(externalTrack).filter(Boolean);if(!tracks.length)throw new Error('Не найдены названия треков в файле.');
  return {name:String(name).slice(0,100),sourceURL:'',tracks};
}
const versionWords=['remix','cover','live','instrumental','sped up','slowed','karaoke','acoustic'];
export function matchConfidence(source,candidate) {
  const title=textSimilarity(source.title,candidate.title);
  const artist=source.artists.length?Math.max(...source.artists.map(a=>textSimilarity(a,candidate.artist))):0;
  const left=normalizeText(source.title),right=normalizeText(candidate.title);
  const versionMismatch=versionWords.some(w=>left.includes(w)!==right.includes(w));
  const duration=source.duration&&candidate.duration?Math.max(0,1-Math.abs(source.duration-candidate.duration)/30):0.5;
  const score=title*0.55+artist*0.4+duration*0.05-(versionMismatch?0.3:0);
  return {score,title,artist,automatic:title>=0.94&&artist>=0.9&&score>=0.94&&!versionMismatch};
}
export async function matchLibrary(library,request,{signal,onProgress=()=>{},localTracks=[]}={}) {
  const items=[],cache=new Map();
  for(let i=0;i<library.tracks.length;i++){
    signal?.throwIfAborted();const source=library.tracks[i];let candidates=cache.get(source.key),requestFailed=false;
    if(!candidates){
      const query=`${source.artists[0]||''} ${source.title}`.trim();
      try{const raw=await request('/tracks/search',{query,limit:12,sort_method:'relevant'});signal?.throwIfAborted();candidates=raw.map(normalizeTrack).filter(t=>t.streamable);}
      catch(error){signal?.throwIfAborted();requestFailed=true;candidates=[];}
      // A title-only fallback helps catalogues where combined artist/title queries are restrictive.
      if(!requestFailed&&!candidates.some(t=>matchConfidence(source,t).automatic)){
        try{const raw=await request('/tracks/search',{query:source.title,limit:15,sort_method:'relevant'});signal?.throwIfAborted();candidates.push(...raw.map(normalizeTrack).filter(t=>t.streamable));}catch{signal?.throwIfAborted();requestFailed=true;}
      }
      const unique=new Map([...localTracks,...candidates].map(t=>[t.id,t]));
      candidates=[...unique.values()].map(track=>({track,...matchConfidence(source,track)})).filter(c=>c.score>=0.5&&c.title>=0.6).sort((a,b)=>b.score-a.score).slice(0,4);
      if(!requestFailed)cache.set(source.key,candidates);
    }
    const best=candidates[0],automatic=best?.automatic&&!requestFailed;
    items.push({source,candidates,selectedId:automatic?best.track.id:null,status:requestFailed?'error':automatic?'matched':best?'review':'missing'});
    onProgress({completed:i+1,total:library.tracks.length,current:source.title});
    if(requestFailed&&items.slice(-3).length===3&&items.slice(-3).every(item=>item.status==='error'))throw new Error('Музыкальный каталог не отвечает. Список плейлиста сохранён в мастере; повтори сопоставление позже.');
  }
  return items;
}
export function applyLibraryImport(state,library,items,{id,at=Date.now(),name=library.name}={}) {
  const selected=[];
  for(const item of items){const candidate=item.candidates.find(c=>c.track.id===item.selectedId);if(candidate)selected.push(candidate.track);}
  const tracks=[...new Map(selected.map(t=>[t.id,t])).values()];
  if(!tracks.length)throw new Error('Сначала подтверди хотя бы одно совпадение.');
  const playlistId=id||crypto.randomUUID();
  const report={id:playlistId,name,source:'yandex',sourceURL:library.sourceURL,at,entries:items.map(item=>({source:item.source,trackId:item.selectedId||null,status:item.selectedId?'matched':item.status}))};
  const next=mergeTracks(state,tracks);
  return {...next,playlists:[...state.playlists,{id:playlistId,name,trackIds:tracks.map(t=>t.id),createdAt:at,source:'yandex',sourceURL:library.sourceURL}],imports:[...(state.imports||[]),report].slice(-30)};
}
