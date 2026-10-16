import React, {useEffect,useRef,useState} from 'react';
import {Search, Users, Music2, Play, ArrowLeft, LoaderCircle, RefreshCw, Disc3, BadgeCheck} from 'lucide-react';
import Cover from './TrackArtwork.jsx';
import {searchColumns as searchCatalog} from '../core/search.mjs';
import {GENRES} from '../core/model.mjs';

function ArtistPicture({artist}) {const [broken,setBroken]=useState(false);useEffect(()=>setBroken(false),[artist.picture]);return <div className="artist-picture">{artist.picture&&!broken?<img src={artist.picture} alt="" onError={()=>setBroken(true)}/>:<Users size={32} strokeWidth={1.2}/>}</div>;}
export default function SearchPage({backRef,query,setQuery,request,tracks,offline,renderTracks,onTracks,onPlay,onArtist,provider='youtube'}) {
  const [result,setResult]=useState({tracks:[],artists:[],hasMore:false}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[tab,setTab]=useState('all'),[offset,setOffset]=useState(0),[retry,setRetry]=useState(0);
  const local=useRef(tracks),merge=useRef(onTracks),active=useRef(null);local.current=tracks;merge.current=onTracks;
  useEffect(()=>{
    const controller=new AbortController();active.current=controller;setResult({tracks:[],artists:[],hasMore:false});setOffset(0);setError('');setBusy(Boolean(query.trim()));
    if(!query.trim()){setBusy(false);return()=>controller.abort();}
    const timer=setTimeout(async()=>{
      try{const found=await searchCatalog(query,request,{localTracks:local.current,offline,signal:controller.signal});if(controller.signal.aborted)return;setResult(found);merge.current(found.tracks);}
      catch(e){if(!controller.signal.aborted)setError(e.message);}
      finally{if(!controller.signal.aborted)setBusy(false);}
    },300);
    return()=>{clearTimeout(timer);controller.abort();};
  },[query,offline,retry,request]);
  async function more(){
    const controller=active.current;setBusy(true);setError('');
    try{
      const next=offset+40;
      const found=await searchCatalog(query,request,{offset:next,signal:controller.signal});if(controller.signal.aborted)return;setResult(old=>({...found,...Object.fromEntries(['tracks','recent','popular'].map(key=>[key,[...new Map([...(old[key]||[]),...(found[key]||[])].map(t=>[t.id,t])).values()]]))}));merge.current(found.tracks);
      setOffset(next);
    }catch(e){if(!controller.signal.aborted)setError(e.message);}finally{if(!controller.signal.aborted)setBusy(false);}
  }
  useEffect(()=>()=>active.current?.abort(),[]);
  useEffect(()=>{if(backRef)backRef.current=null;},[backRef]);
  const best=result.tracks[0],showTracks=tab!=='artists',showArtists=tab!=='tracks';
  return <>
    <div className="page-intro"><div><h1>{query.trim()?`Поиск «${query.trim()}»`:'Поиск'}</h1>{offline&&<p>Скачанная музыка</p>}</div><Search className="intro-icon" size={44} strokeWidth={1}/></div>
    {!query.trim()?<><div className="search-welcome"><Search size={28}/><h2>Треки и исполнители</h2><p>Введи название в строке поиска.</p></div><div className="section-heading"><h2>Жанры</h2></div><div className="genre-grid">{GENRES.map(g=><button key={g} onClick={()=>setQuery(g)}>{g}<Disc3 size={64} className="genre-disc"/></button>)}</div></>:<>
      <div className="search-tabs" role="group" aria-label="Тип результатов">{[['all','Всё'],['tracks','Треки'],['artists','Исполнители']].map(([id,label])=><button key={id} aria-pressed={tab===id} className={tab===id?'selected':''} onClick={()=>setTab(id)}>{label}</button>)}</div>
      {busy&&<div className="search-loading" role="status"><LoaderCircle className="spin" size={20}/>Ищем музыку…</div>}
      {error&&<div className="network-banner" role="alert">{error}<button onClick={()=>setRetry(x=>x+1)}>Повторить <RefreshCw size={15}/></button></div>}
      {result.partial&&<p className="settings-note">Часть результатов временно недоступна. Попробуй повторить поиск.</p>}
      {tab==='all'&&best&&<section className="best-match"><span className="eyebrow">Лучшее совпадение</span><div><div className="best-cover"><Cover track={best}/></div><div><h2>{best.title}</h2><button className="artist-link" onClick={()=>onArtist({id:best.artistId,name:best.artist})}>{best.artist}</button></div><button className="big-play" aria-label={`Слушать лучшее совпадение ${best.title}`} onClick={()=>onPlay(result.tracks)}><Play size={22} fill="currentColor"/></button></div></section>}
      {showArtists&&result.artists.length>0&&<><div className="section-heading"><h2>Исполнители</h2><span className="small-caption">{result.artists.length} найдено</span></div><div className="artist-grid">{result.artists.map(a=><button key={a.id} className="artist-card" onClick={()=>onArtist(a)}><ArtistPicture artist={a}/><strong>{a.name}{a.verified&&<BadgeCheck size={15}/>}</strong><small>{a.trackCount?`${a.trackCount} треков`:'Исполнитель'}</small></button>)}</div></>}
      {showTracks&&result.tracks.length>0&&<div className="search-columns">{[["recent","Свежие релизы"],["popular","Популярные"]].map(([key,title])=><section key={key} aria-label={title}><div className="section-heading"><h2>{title}</h2><span className="small-caption">{key==="recent"?"За месяц":"По просмотрам"}</span></div>{result[key]?.length?renderTracks(result[key]):<p className="settings-note">{busy?"Загружаем…":"Нет результатов"}</p>}</section>)}</div>}
      {!busy&&!error&&((tab==='artists'&&!result.artists.length)||(tab==='tracks'&&!result.tracks.length)||(tab==='all'&&!result.tracks.length&&!result.artists.length))&&<div className="empty"><Search size={34}/><h2>Ничего не найдено</h2><p>Попробуй другое название или имя исполнителя.</p></div>}
      {showTracks&&result.hasMore&&!busy&&<button className="button button-outline load-more" onClick={more}>Показать ещё</button>}
    </>}
  </>;
}
