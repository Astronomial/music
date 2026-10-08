import React, {useEffect,useRef,useState} from 'react';
import {Search, Users, Music2, Play, ArrowLeft, LoaderCircle, RefreshCw, Disc3, BadgeCheck} from 'lucide-react';
import {searchCatalog} from '../core/search.mjs';
import {normalizeTrack,GENRES} from '../core/model.mjs';

function ArtistPicture({artist}) {const [broken,setBroken]=useState(false);return <div className="artist-picture">{artist.picture&&!broken?<img src={artist.picture} alt="" onError={()=>setBroken(true)}/>:<Users size={32} strokeWidth={1.2}/>}</div>;}
export default function SearchPage({query,setQuery,request,tracks,offline,renderTracks,onTracks,onPlay,provider='youtube'}) {
  const [result,setResult]=useState({tracks:[],artists:[],hasMore:false}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[tab,setTab]=useState('all'),[artist,setArtist]=useState(null),[artistTracks,setArtistTracks]=useState([]),[offset,setOffset]=useState(0),[retry,setRetry]=useState(0);
  const local=useRef(tracks),merge=useRef(onTracks),active=useRef(null);local.current=tracks;merge.current=onTracks;
  useEffect(()=>{
    const controller=new AbortController();active.current=controller;setArtist(null);setResult({tracks:[],artists:[],hasMore:false});setOffset(0);setError('');setBusy(Boolean(query.trim()));
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
      if(artist){const raw=await request(`/users/${artist.id}/tracks`,{limit:40,offset:next,filter_tracks:'public',sort_method:'plays',sort_direction:'desc'});if(controller.signal.aborted)return;const ts=raw.map(normalizeTrack).filter(t=>t.streamable);setArtistTracks(old=>[...new Map([...old,...ts].map(t=>[t.id,t])).values()]);setResult(old=>({...old,hasMore:raw.hasMore??raw.length===40}));merge.current(ts);}
      else{const found=await searchCatalog(query,request,{offset:next,signal:controller.signal});if(controller.signal.aborted)return;setResult(old=>({...found,tracks:[...new Map([...old.tracks,...found.tracks].map(t=>[t.id,t])).values()]}));merge.current(found.tracks);}
      setOffset(next);
    }catch(e){if(!controller.signal.aborted)setError(e.message);}finally{if(!controller.signal.aborted)setBusy(false);}
  }
  async function openArtist(a){
    active.current?.abort();const controller=new AbortController();active.current=controller;setArtist(a);setArtistTracks([]);setOffset(0);setBusy(true);setError('');
    try{const raw=offline?local.current.filter(t=>t.artistId===a.id):await request(`/users/${a.id}/tracks`,{limit:40,offset:0,filter_tracks:'public',sort_method:'plays',sort_direction:'desc'});if(controller.signal.aborted)return;const ts=offline?raw:raw.map(normalizeTrack).filter(t=>t.streamable);setArtistTracks(ts);setResult(old=>({...old,hasMore:!offline&&(raw.hasMore??raw.length===40)}));merge.current(ts);}
    catch(e){if(!controller.signal.aborted)setError(e.message);}finally{if(!controller.signal.aborted)setBusy(false);}
  }
  useEffect(()=>()=>active.current?.abort(),[]);
  if(artist)return <><button className="text-link search-back" onClick={()=>{active.current?.abort();setRetry(x=>x+1);}}><ArrowLeft size={17}/>К результатам поиска</button><div className="artist-hero"><ArtistPicture artist={artist}/><div><span className="eyebrow">ИСПОЛНИТЕЛЬ {artist.verified&&<BadgeCheck size={15}/>}</span><h1>{artist.name}</h1><p>{offline?'Скачанные треки':`${provider==='youtube'?'YouTube':'Audius'}${artist.handle?' · @'+artist.handle:''}`}</p><button className="button button-primary" disabled={!artistTracks.length} onClick={()=>onPlay(artistTracks)}><Play size={17} fill="currentColor"/>Слушать</button></div></div><div className="section-heading"><h2>Треки исполнителя</h2></div>{artistTracks.length?renderTracks(artistTracks):!busy&&!error&&<div className="empty"><Music2 size={32}/><h3>Пока нет доступных треков</h3></div>}{error&&<div className="network-banner" role="alert">{error}<button onClick={()=>openArtist(artist)}>Повторить</button></div>}{busy&&<div className="search-loading" role="status"><LoaderCircle className="spin" size={20}/>Загружаем музыку…</div>}{result.hasMore&&!busy&&<button className="button button-outline load-more" onClick={more}>Ещё треки</button>}</>;
  const best=result.tracks[0],showTracks=tab!=='artists',showArtists=tab!=='tracks';
  return <>
    <div className="page-intro"><div><span className="eyebrow">ОТКРЫВАЙ НОВОЕ</span><h1>{query.trim()?`Поиск «${query.trim()}»`:'Найди свой звук.'}</h1><p>{offline?'Поиск среди скачанной музыки.':`Треки и исполнители ${provider==='youtube'?'YouTube':'Audius'}. Одно название — и ты уже ближе.`}</p></div><Search className="intro-icon" size={44} strokeWidth={1}/></div>
    {!query.trim()?<><div className="search-welcome"><Search size={28}/><h2>Что сегодня на повторе?</h2><p>Начни вводить название трека или имя исполнителя в строке наверху. Результаты появятся сами.</p></div><div className="section-heading"><h2>Попробуй новое направление</h2></div><div className="genre-grid">{GENRES.map(g=><button key={g} onClick={()=>setQuery(g)}>{g}<Disc3 size={64} className="genre-disc"/></button>)}</div></>:<>
      <div className="search-tabs" aria-label="Тип результатов">{[['all','Всё'],['tracks','Треки'],['artists','Исполнители']].map(([id,label])=><button key={id} aria-pressed={tab===id} className={tab===id?'selected':''} onClick={()=>setTab(id)}>{label}</button>)}</div>
      {busy&&<div className="search-loading" role="status"><LoaderCircle className="spin" size={20}/>Ищем музыку…</div>}
      {error&&<div className="network-banner" role="alert">{error}<button onClick={()=>setRetry(x=>x+1)}>Повторить <RefreshCw size={15}/></button></div>}
      {result.partial&&<p className="settings-note">Часть результатов временно недоступна. Попробуй повторить поиск.</p>}
      {tab==='all'&&best&&<section className="best-match"><span className="eyebrow">ЛУЧШЕЕ СОВПАДЕНИЕ</span><div><div className="best-cover">{best.artwork?<img src={best.artwork} alt=""/>:<Disc3 size={50} strokeWidth={1}/>}</div><div><h2>{best.title}</h2><p>{best.artist} <span>· Трек</span></p></div><button className="big-play" aria-label={`Слушать лучшее совпадение ${best.title}`} onClick={()=>onPlay(result.tracks)}><Play size={22} fill="currentColor"/></button></div></section>}
      {showArtists&&result.artists.length>0&&<><div className="section-heading"><h2>Исполнители</h2><span className="small-caption">{result.artists.length} В РЕЗУЛЬТАТАХ</span></div><div className="artist-grid">{result.artists.map(a=><button key={a.id} className="artist-card" onClick={()=>openArtist(a)}><ArtistPicture artist={a}/><strong>{a.name}{a.verified&&<BadgeCheck size={15}/>}</strong><small>{a.trackCount?`${a.trackCount} треков`:'Исполнитель'}</small></button>)}</div></>}
      {showTracks&&result.tracks.length>0&&<><div className="section-heading"><h2>Треки</h2><span className="small-caption">{result.tracks.length}{result.hasMore?'+':''} В РЕЗУЛЬТАТАХ</span></div>{renderTracks(result.tracks)}</>}
      {!busy&&!error&&((tab==='artists'&&!result.artists.length)||(tab==='tracks'&&!result.tracks.length)||(tab==='all'&&!result.tracks.length&&!result.artists.length))&&<div className="empty"><Search size={34}/><h3>Пока ничего не нашлось</h3><p>Проверь название или попробуй имя исполнителя. Каталог источника отличается от других сервисов.</p></div>}
      {showTracks&&result.hasMore&&!busy&&<button className="button button-outline load-more" onClick={more}>Показать ещё</button>}
    </>}
  </>;
}
