import React,{useEffect,useRef} from 'react';
import {ArrowRightLeft,RefreshCw,Check,LoaderCircle,X} from 'lucide-react';
import {applyLibraryImport,matchLibrary} from '../core/library-import.mjs';
export function useRequestedPlaylistImport({request,bridge,enabled,onChange}){
  const active=useRef(null),latest=useRef({onChange});latest.current={onChange};
  const update=patch=>latest.current.onChange(s=>({...s,importRequests:s.importRequests.map(r=>r.id===request.id?{...r,...patch}:r)}));
  useEffect(()=>{
    if(!request)return;
    if(request.status==='dismissed'||!enabled){if(active.current){active.current.abort();active.current=null;if(request.status==='loading')update({status:'pending'});}return;}
    if(request.status!=='pending'||active.current)return;
    const controller=new AbortController();active.current=controller;
    (async()=>{
      update({status:'loading',error:'',completed:0});
      try{
        const library=request.library||await bridge.yandexPlaylist(request.sourceURL);
        if(controller.signal.aborted)return;
        const waiting=library.tracks.map(source=>({source,candidates:[],selectedId:null,status:'missing'}));
        latest.current.onChange(s=>{const next=applyLibraryImport(s,library,waiting,{id:request.id,name:request.name,preserveUnmatched:true});return {...next,importRequests:next.importRequests.map(r=>r.id===request.id?{...r,library,total:library.tracks.length,phase:'matching'}:r)};});
        const items=await matchLibrary(library,bridge.request,{signal:controller.signal,onProgress:p=>{if(!controller.signal.aborted)update({completed:p.completed,total:p.total});}});
        if(controller.signal.aborted)return;
        latest.current.onChange(s=>{const next=applyLibraryImport(s,library,items,{id:request.id,name:request.name,preserveUnmatched:true});return {...next,importRequests:next.importRequests.map(r=>r.id===request.id?{...r,status:items.every(i=>i.selectedId)?'complete':'review',items,completed:items.length,total:items.length,error:''}:r)};});
      }catch(e){if(!controller.signal.aborted)update({status:'error',error:e.message});}
      finally{if(active.current===controller)active.current=null;}
    })();
    // The task is owned by this mounted component, not by its transient status props.
  },[enabled,request?.status]);
  useEffect(()=>()=>{active.current?.abort();},[]);
}
export default function RequestedPlaylistBanner({request,enabled,onChange,onReview,onOpen}){
  const update=patch=>onChange(s=>({...s,importRequests:s.importRequests.map(r=>r.id===request.id?{...r,...patch}:r)}));
  if(!request||['dismissed','complete'].includes(request.status))return null;
  const loading=request.status==='loading';
  return <section className="requested-playlist-banner"><div className="requested-icon">{loading?<LoaderCircle size={23} className="spin"/>:<ArrowRightLeft size={23}/>}</div><div><strong>{loading?'Переносим «Мне нравится» из Яндекса':request.status==='review'?'Твой плейлист уже в библиотеке':'Твой плейлист из Яндекса'}</strong><p>{loading?(request.phase==='matching'?`Находим версии в YouTube · ${request.completed||0} / ${request.total}`:'Читаем названия и исполнителей…'):request.status==='error'?request.error:request.status==='review'?`Названия всех треков сохранены. Совпадений: ${request.items.filter(i=>i.selectedId).length} из ${request.total}. Проверь оставшиеся версии.`:'Перенесём его при подключении к YouTube. Он станет основой Пульса.'}</p></div><div className="requested-actions">{request.status==='error'&&<button className="button button-outline" disabled={!enabled} onClick={()=>update({status:'pending'})}><RefreshCw size={15}/>Повторить перенос</button>}{request.status==='review'&&<><button className="button button-primary" onClick={()=>onReview(request)}><Check size={16}/>Проверить версии</button><button className="text-link" onClick={()=>onOpen(request.id)}>Открыть плейлист</button></>}<button className="icon-button" aria-label="Скрыть перенос плейлиста" onClick={()=>{update({status:'dismissed'});}}><X size={17}/></button></div></section>;
}
