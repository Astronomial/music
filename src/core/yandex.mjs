import { parseYandexPlaylistURL, parseYandexPlaylist, IMPORT_LIMIT } from './library-import.mjs';

// Yandex has no supported public developer API. Only public playlist metadata is read.
export async function requestPublicYandexPlaylist(input,fetcher=fetch,{signal}={}) {
  const link=parseYandexPlaylistURL(input);
  const controller=new AbortController();
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)controller.abort();
  const timer=setTimeout(abort,60000);
  async function read(route,options={}) {
    const response=await fetcher(`https://api.music.yandex.net${route}`,{...options,signal:controller.signal,redirect:'error'});
    if(!response.ok){await response.body?.cancel();throw new Error(response.status===401||response.status===403?'Яндекс не разрешил читать этот плейлист. Проверь публичность; если сервис ограничивает доступ, используй файл экспорта.':response.status===404?'Плейлист не найден. Проверь ссылку.':`Яндекс Музыка временно недоступна (${response.status}). Повтори позже.`);}
    if(Number(response.headers.get('content-length'))>15*1024**2)throw new Error('Слишком большой ответ сервиса.');
    const body=await response.text();if(body.length>15*1024**2)throw new Error('Слишком большой ответ сервиса.');
    try{return JSON.parse(body);}catch{throw new Error('Сервис не вернул состав плейлиста. Используй файл экспорта.');}
  }
  try{
    const data=await read(link.path);
    const result=data.result||data,p=result.playlist||result;
    if(!Array.isArray(p.tracks))throw new Error('Плейлист недоступен. Проверь, что он публичный.');
    if(p.tracks.length>IMPORT_LIMIT||Number(p.trackCount)>IMPORT_LIMIT)throw new Error(`Поддерживается до ${IMPORT_LIMIT} треков в одном плейлисте.`);
    const missing=p.tracks.filter(t=>!(t.track||t).title);
    const metadata=new Map();
    for(let i=0;i<missing.length;i+=100){
      const batch=missing.slice(i,i+100);
      const ids=batch.map(t=>{const id=String(t.id||'');if(!/^\d{1,20}$/.test(id))throw new Error('Сервис вернул некорректный идентификатор трека.');return id;});
      const details=await read('/tracks',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({'track-ids':ids.join(','),'with-positions':'false'}).toString()});
      if(!Array.isArray(details.result))throw new Error('Не удалось получить названия треков. Используй файл экспорта.');
      for(const t of details.result)metadata.set(String(t.id),t);
    }
    p.tracks=p.tracks.map(t=>(t.track||t).title?t:{...t,track:metadata.get(String(t.id))});
    const parsed=parseYandexPlaylist(data,link.url);
    if(parsed.tracks.length!==p.tracks.length)throw new Error('Часть треков недоступна в ответе Яндекса. Используй полный файл экспорта.');
    return parsed;
  }catch(error){
    if(controller.signal.aborted)throw new Error(signal?.aborted?'Импорт отменён.':'Яндекс не ответил за минуту. Повтори загрузку.');
    if(error instanceof TypeError)throw new Error('Не удалось связаться с Яндекс Музыкой. Проверь интернет или используй файл экспорта.');
    throw error;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
