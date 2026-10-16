import React,{useEffect,useRef,useState} from 'react';
import {ArrowLeft,Users,Play,LoaderCircle} from 'lucide-react';
import {artistTracks} from '../core/artist-catalog.mjs';
export default function ArtistPage({artist,request,tracks,offline,onTracks,onPlay,onBack,renderTracks}){
  const [items,setItems]=useState([]),[busy,setBusy]=useState(true),[error,setError]=useState(''),[offset,setOffset]=useState(0),[more,setMore]=useState(false),[retry,setRetry]=useState(0);
  const latest=useRef({tracks,onTracks});latest.current={tracks,onTracks};
  useEffect(()=>{const controller=new AbortController();setBusy(true);setError('');if(offset===0)setItems([]);
    artistTracks(artist,request,{tracks:latest.current.tracks,offline,offset,signal:controller.signal}).then(result=>{if(controller.signal.aborted)return;setItems(old=>[...new Map([...(offset?old:[]),...result.tracks].map(t=>[t.id,t])).values()]);setMore(result.hasMore);latest.current.onTracks(result.tracks);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return()=>controller.abort();
  },[artist.id,request,offline,offset,retry]);
  return <><button className="text-link search-back" onClick={onBack}><ArrowLeft size={17}/>Вернуться</button><div className="artist-hero"><div className="artist-picture"><Users size={48}/></div><div><span className="eyebrow">Исполнитель</span><h1>{artist.name}</h1><button className="button button-primary" disabled={!items.length} onClick={()=>onPlay(items)}><Play size={17}/>Слушать</button></div></div><h2>Треки</h2>{items.length>0&&renderTracks(items)}{busy&&<p role="status"><LoaderCircle size={18} className="spin"/> Загружаем…</p>}{error&&<div className="network-banner" role="alert">{error}<button onClick={()=>setRetry(x=>x+1)}>Повторить</button></div>}{!busy&&!error&&!items.length&&<p>Треки исполнителя пока не найдены.</p>}{more&&!busy&&<button className="button button-outline" onClick={()=>setOffset(x=>x+40)}>Ещё треки</button>}</>;
}
