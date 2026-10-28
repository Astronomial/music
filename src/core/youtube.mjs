import {publicationAgeDays} from './search.mjs';
import {normalizeTrack} from './model.mjs';
import {matchRecordingGenre,artistIdentity} from './genre-evidence.mjs';
import {recentSongPublication} from './release-discovery.mjs';

export const validVideoID=id=>typeof id==='string'&&/^[\w-]{11}$/.test(id);
export function youtubeTrack(item,relatedTo=[]) {
  const videoId=item.video_id||item.id;
  if(!validVideoID(videoId)||!item.title)return null;
  const artists=item.artists||item.authors||[];
  const artist=artists.map(a=>a.name).filter(Boolean).join(', ')||item.author?.name||item.author||'Неизвестный исполнитель';
  const pictures=item.thumbnails||item.thumbnail||[];
  const artwork=Array.isArray(pictures)?pictures.at(-1)?.url||'':pictures.contents?.at(-1)?.url||'';
  const age=publicationAgeDays(item.published?.text);
  return normalizeTrack({id:`yt_${videoId}`,videoId,source:'youtube',title:String(item.title),artist:String(artist),artistId:(artists[0]?.channel_id||item.author?.id)?`yt_${artists[0]?.channel_id||item.author.id}`:`name_${String(artist).toLowerCase()}`,duration:item.duration?.seconds||0,publishedAt:Number.isFinite(age)?Date.now()-age*86400000:null,playCount:Number(String(item.view_count?.text||'').replace(/[^0-9]/g,''))||0,artwork,album:item.album?.name||'',relatedTo,permalink:`https://www.youtube.com/watch?v=${videoId}`,downloadable:false});
}
export function youtubeArtist(item) {
  const id=item.id||item.endpoint?.payload?.browseId;
  if(!id||!/^UC[\w-]{10,80}$/.test(id))return null;
  return {id:`yt_${id}`,name:String(item.name||item.title||'Исполнитель'),handle:'',profile_picture:item.thumbnails?.at(-1)?.url||item.thumbnail?.at(-1)?.url||'',source:'youtube'};
}
function nodes(page){return [...(page.contents||[])].flatMap(s=>s.contents||[]);}

// Public catalogue metadata. Native audio playback is handled in the main process.
export class YouTubeCatalog {
  constructor(createClient,{releaseLookup=async()=>[],neighbourLookup=()=>[]}={}){this.createClient=createClient;this.releaseLookup=releaseLookup;this.neighbourLookup=neighbourLookup;this.client=null;this.searches=new Map();this.artists=new Map();this.relatedCache=new Map();}
  async neighbours(artist){
    const names=this.neighbourLookup(artist).slice(0,2),found=new Map();
    const pages=await Promise.allSettled(names.map(a=>this.search(a.name,'song')));
    for(let i=0;i<pages.length;i++)if(pages[i].status==='fulfilled'){
      for(const track of pages[i].value.items.filter(t=>artistIdentity(t.artist)===artistIdentity(names[i].name)).slice(0,12))found.set(track.id,{...track,retrievalSources:[...new Set([...track.retrievalSources,'listenbrainz-neighbour'])]});
    }
    return {items:[...found.values()],hasMore:false};
  }
  async releases(artist,offset=0){
    const rows=await this.releaseLookup(artist),found=[];
    const pages=await Promise.allSettled(rows.slice(0,2).map(row=>this.search(row.artistName+' '+row.trackName,'song')));
    for(const result of pages)if(result.status==='fulfilled')for(const track of result.value.items){const evidence=matchRecordingGenre(track,rows);if(evidence.releasedAt&&evidence.recordingId){found.push({...track,genreEvidence:evidence,retrievalSources:['release-catalog']});break;}}
    if(found.length)return {items:found,hasMore:false};
    const fallback=await this.orderedSearch(artist,'recent',offset);
    return {...fallback,items:fallback.items.filter(t=>recentSongPublication(t,artist)).map(t=>({...t,retrievalSources:['recent-upload']}))};
  }
  async music(){if(!this.client)this.client=Promise.resolve(this.createClient()).catch(e=>{this.client=null;throw e;});return (await this.client).music;}
  async search(query,type,offset=0){
    const key=`${type}:${query}`;let entry=this.searches.get(key);
    if(!entry||Date.now()-entry.at>300000){
      entry={at:Date.now(),pages:[],promise:(async()=>{const music=await this.music();return music.search(query,{type});})()};
      this.searches.set(key,entry);if(this.searches.size>60)this.searches.delete(this.searches.keys().next().value);
    }
    const pageIndex=Math.floor(offset/40);
    if(pageIndex>20)throw new Error('Достигнут предел страниц поиска. Уточни запрос.');
    if(!entry.pages.length){try{const result=await entry.promise;entry.pages[0]={result,items:nodes(result)};}catch(e){this.searches.delete(key);throw e;}}
    while(entry.pages.length<=pageIndex){const last=entry.pages.at(-1);if(!last.result.has_continuation)return {items:[],hasMore:false};const result=await (entry.nextPromise||(entry.nextPromise=last.result.getContinuation()));if(entry.pages.at(-1)===last){entry.pages.push({result,items:result.contents?.contents||[]});entry.nextPromise=null;}}
    const page=entry.pages[pageIndex];
    const result=page.items.map(i=>type==='artist'?youtubeArtist(i):youtubeTrack(i)).filter(Boolean);
    // Attach pagination metadata to the array for IPC-safe adapters (also represented in the result envelope).
    return {items:result,hasMore:page.result.has_continuation};
  }
  async orderedSearch(query,order,offset=0){
    const key=`ordered:${order}:${query}`;let entry=this.searches.get(key);
    if(!entry||Date.now()-entry.at>300000){
      entry={at:Date.now(),pages:[],promise:(async()=>{const client=await (this.client||(await this.music(),this.client));const {YT}=await import('youtubei.js');return new YT.Search(client.actions,await client.actions.execute('/search',{query,params:order==='recent'?'EgQIBBAB':'CAMSAhAB',client:'WEB'}));})()};
      this.searches.set(key,entry);if(this.searches.size>60)this.searches.delete(this.searches.keys().next().value);
    }
    const pageIndex=Math.floor(offset/40);
    try{
      if(!entry.pages.length)entry.pages.push(await entry.promise);
      while(entry.pages.length<=pageIndex){const last=entry.pages.at(-1);if(!last.has_continuation)return {items:[],hasMore:false};entry.nextPromise||=last.getContinuation();const next=await entry.nextPromise;if(entry.pages.at(-1)===last){entry.pages.push(next);entry.nextPromise=null;}}
      const page=entry.pages[pageIndex];return {items:(order==='recent'?[...page.videos].sort((a,b)=>publicationAgeDays(a.published?.text)-publicationAgeDays(b.published?.text)):page.videos).map(i=>youtubeTrack(i)).filter(t=>t&&t.duration>0&&t.duration<=1200),hasMore:page.has_continuation};
    }catch(error){this.searches.delete(key);throw error;}
  }
  async artist(id,offset=0){
    if(!/^yt_UC[\w-]{10,80}$/.test(id))throw new Error('Некорректный исполнитель.');
    let entry=this.artists.get(id);
    if(!entry||Date.now()-entry.at>300000){
      const music=await this.music(),artist=await music.getArtist(id.slice(3));
      let shelf;try{shelf=await artist.getAllSongs();}catch{}
      const items=shelf?.contents||artist.sections.flatMap(s=>s.contents||[]);
      entry={at:Date.now(),items:items.map(i=>youtubeTrack(i)).filter(Boolean)};this.artists.set(id,entry);if(this.artists.size>40)this.artists.delete(this.artists.keys().next().value);
    }
    return {items:entry.items.slice(offset,offset+40),hasMore:offset+40<entry.items.length};
  }
  async related(videoId){
    if(!validVideoID(videoId))throw new Error('Некорректный трек YouTube.');
    let entry=this.relatedCache.get(videoId);
    if(!entry||Date.now()-entry.at>300000){
      const promise=(async()=>{const music=await this.music(),panel=await music.getUpNext(videoId,true);return panel.contents.map(i=>youtubeTrack(i.primary||i,[`yt_${videoId}`])).filter(Boolean);})();
      entry={at:Date.now(),promise};this.relatedCache.set(videoId,entry);
      if(this.relatedCache.size>60)this.relatedCache.delete(this.relatedCache.keys().next().value);
      promise.catch(()=>{if(this.relatedCache.get(videoId)===entry)this.relatedCache.delete(videoId);});
    }
    return entry.promise;
  }
  async request(route,params={}){
    const query=String(params.query||params.genre||'').trim().slice(0,160),offset=Math.max(0,Math.min(800,Number(params.offset)||0));
    try{
      if(route==='/tracks/neighbours'&&query)return await this.neighbours(query);
      if(route==='/tracks/releases'&&query)return await this.releases(query,offset);
      if(route==='/tracks/search'&&query&&['recent','popular'].includes(params.sort_method))return await this.orderedSearch(query,params.sort_method,offset);
      if(route==='/tracks/search'&&query)return await this.search(query,'song',offset);
      if(route==='/users/search'&&query)return await this.search(query,'artist',0);
      const artist=/^\/users\/(yt_UC[\w-]{10,80})\/tracks$/.exec(route);if(artist)return await this.artist(artist[1],offset);
      const related=/^\/related\/([\w-]{11})$/.exec(route);if(related)return {items:await this.related(related[1]),hasMore:false};
      throw new Error('Недопустимый запрос к каталогу YouTube.');
    }catch(e){if(e.message.startsWith('Недопустимый')||e.message.startsWith('Некорректный'))throw e;throw new Error('Каталог YouTube сейчас недоступен. Проверь интернет; публичный поиск иногда ограничивается сервисом. Локальные файлы остаются доступны.');}
  }
}
