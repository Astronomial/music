import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Home, Search, Heart, ArrowDownToLine, Plus, Settings2, ChevronRight, ArrowUpRight, Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, ListMusic, Shuffle, Repeat, Check, X, Minus, Square, WifiOff, RefreshCw, MoreHorizontal, FolderOpen, SlidersHorizontal, Ban, Music2, ArrowLeft, Trash2, Radio, Disc3, LoaderCircle, ArrowRightLeft } from 'lucide-react';
import WaveSettingsPage from './components/WaveSettingsPage.jsx';
import {waveSettings} from './core/wave-settings.mjs';
import YouTubePlayer from './components/YouTubePlayer.jsx';
import {collectYouTubeCandidates} from './core/catalog.mjs';
import SearchPage from './components/SearchPage.jsx';
import AppearanceSettings from './components/AppearanceSettings.jsx';
import LibraryImportPage from './components/LibraryImportPage.jsx';
import { appearanceVariables } from './core/appearance.mjs';
import { bridge } from './bridge.mjs';
import { initialState, GENRES, mergeTracks, normalizeTrack, recordEvent } from './core/model.mjs';
import { rankTracks, buildProfile } from './core/recommender.mjs';
import { collectCandidates } from './core/audius.mjs';

const fmt = seconds => `${Math.floor((seconds || 0)/60)}:${String(Math.floor((seconds || 0)%60)).padStart(2,'0')}`;
const mixes = [
  { id:'daily', title:'Твой daily mix', subtitle:'Знакомое звучание. Новые имена.', label:'DAILY / 01', className:'mix-sage', context:null },
  { id:'focus', title:'Без лишних мыслей', subtitle:'Музыка, чтобы быть в потоке', label:'FOCUS / 02', className:'mix-sand', context:{genres:['Ambient','Lo-Fi','Jazz'],moods:['Peaceful','Calm']} },
  { id:'night', title:'После полуночи', subtitle:'Глубже в электронную музыку', label:'AFTER HOURS / 03', className:'mix-lilac', context:{genres:['Electronic','House','Techno'],moods:['Brooding','Sophisticated']} },
  { id:'discovery', title:'За пределами привычного', subtitle:'Маленькие открытия для тебя', label:'DISCOVER / 04', className:'mix-blue', context:{discovery:0.85} }
];
function IconButton({ title, children, onClick, active, disabled, className='' }) { return <button type="button" className={`icon-button ${active?'active':''} ${className}`} title={title} aria-label={title} aria-pressed={active===undefined?undefined:active} onClick={onClick} disabled={disabled}>{children}</button>; }
function Cover({ track, className='' }) {
  const [broken,setBroken]=useState(false);
  useEffect(()=>setBroken(false),[track?.artwork]);
  const palette = ['#777f68','#a38b76','#77748c','#5f7f87','#9c796c'];
  const hash = [...(track?.id || 'forma')].reduce((a,c)=>a+c.charCodeAt(0),0);
  return <div className={`cover ${className}`} style={{backgroundColor:palette[hash%palette.length]}}>{track?.artwork&&!broken?<img src={track.artwork} alt="" loading="lazy" onError={()=>setBroken(true)}/>:<><span className="cover-orbit"/><Music2 size={22}/></>}</div>;
}
function Empty({ icon:Icon=Music2, title, text, action }) { return <div className="empty"><Icon size={34} strokeWidth={1.2}/><h3>{title}</h3><p>{text}</p>{action}</div>; }

export default function App() {
  const [state,setState]=useState(initialState), [ready,setReady]=useState(false), [page,setPage]=useState('home');
  const [loading,setLoading]=useState(false), [networkError,setNetworkError]=useState(''), [online,setOnline]=useState(navigator.onLine);
  const [downloads,setDownloads]=useState({}), [progress,setProgress]=useState({}), [toast,setToast]=useState('');
  const [query,setQuery]=useState('');
  const [importingLocal,setImportingLocal]=useState(false);
  const youtube=useRef(null);
  const provider=state.settings.provider||'youtube';
  const catalogRequest=useMemo(()=>(route,params)=>bridge.catalogRequest(route,params,provider),[provider]);
  const importBridge=useMemo(()=>({...bridge,request:catalogRequest}),[catalogRequest]);
  const [modal,setModal]=useState(null), [playlistName,setPlaylistName]=useState(''), [playlistTarget,setPlaylistTarget]=useState(null), [context,setContext]=useState(null);
  const [current,setCurrent]=useState(null), [playing,setPlaying]=useState(false), [buffering,setBuffering]=useState(false), [position,setPosition]=useState(0), [duration,setDuration]=useState(0);
  const [queue,setQueue]=useState([]), [wave,setWave]=useState(false), [queueOpen,setQueueOpen]=useState(false), [shuffle,setShuffle]=useState(false), [repeat,setRepeat]=useState(false);
  const audio = useRef(null), stateRef=useRef(state), currentRef=useRef(null), session=useRef({seconds:0,recorded:false}), playToken=useRef(0), queueRef=useRef([]), waveRef=useRef(false), contextRef=useRef(null);
  const toastTimer=useRef(null), refreshBusy=useRef(false), refreshPending=useRef(false), refreshSignature=useRef(null), saveChain=useRef(Promise.resolve()), navHistory=useRef(['home']), playbackHistory=useRef([]), repeatRef=useRef(false), refreshCount=useRef(0);
  const notify = message => { setToast(message);clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(''),4500); };
  function change(fn) { const next=fn(stateRef.current);stateRef.current=next;setState(next);return next; }
  function navigate(next) {navHistory.current.push(next);setPage(next);setQuery('');}
  function goBack(){if(navHistory.current.length>1){navHistory.current.pop();setPage(navHistory.current.at(-1));}}
  const updateSettings = patch => change(s=>({...s,settings:{...s.settings,...patch}}));

  useEffect(()=>{
    let alive=true;
    Promise.all([bridge.load(),bridge.downloads()]).then(([saved,files])=> {
      if(!alive)return;
      let initial=initialState();
      if(saved?.version===1) initial={...initial,...saved,settings:{...initial.settings,...saved.settings,...waveSettings(saved.settings)}};
      for(const [id,file] of Object.entries(files)) initial.tracks[id]=file.track;
      stateRef.current=initial;setState(initial);setDownloads(files);setReady(true);
      if(!initial.onboarded)setModal('onboarding');
    }).catch(e=>{if(alive){notify('Не удалось прочитать библиотеку: '+e.message);setReady(true);}});
    const on=()=>setOnline(true),off=()=>setOnline(false);window.addEventListener('online',on);window.addEventListener('offline',off);
    const unsub=bridge.onProgress(p=>setProgress(old=>({...old,[p.id]:p})));
    return ()=>{alive=false;unsub();window.removeEventListener('online',on);window.removeEventListener('offline',off);};
  },[]);
  useEffect(()=>{
    if(!ready)return;
    const timer=setTimeout(()=>{
      const snapshot=stateRef.current;
      saveChain.current=saveChain.current.catch(()=>{}).then(()=>bridge.save(snapshot)).catch(()=>notify('Не удалось сохранить библиотеку. Проверь свободное место на диске.'));
    },200);
    return ()=>clearTimeout(timer);
  },[state,ready]);
  useEffect(()=>{
    const flush=()=>{if(ready){finalize('listen');bridge.save(stateRef.current).catch(()=>{});}};
    window.addEventListener('beforeunload',flush);return()=>window.removeEventListener('beforeunload',flush);
  },[ready]);
  useEffect(()=>{
    if(!ready)return;
    return bridge.onBeforeClose?.(()=>{finalize('listen');bridge.finishClose(stateRef.current).catch(()=>notify('Не удалось сохранить библиотеку перед закрытием.'));});
  },[ready]);
  useEffect(()=>{
    if(!modal)return;
    const previous=document.activeElement;
    const dialog=document.querySelector('.modal');
    const controls=()=>[...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled)')];
    const focused=dialog.querySelector('input[autofocus]')||controls()[0];focused?.focus();
    const key=event=>{
      if(event.key==='Escape'){if(modal==='onboarding')change(s=>({...s,onboarded:true}));setModal(null);}
      if(event.key==='Tab'){
        const elements=controls(),first=elements[0],last=elements.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);previous?.focus();};
  },[modal]);
  useEffect(()=>{ if(ready&&state.onboarded&&online&&!state.settings.offlineOnly)refresh(); },[ready,state.onboarded,online,state.settings.offlineOnly,provider]);
  const tasteSeed=state.likes.join('|')+';'+state.playlists.map(p=>p.trackIds.join('|')).join(';')+';'+state.events.filter(e=>e.type==='listen'||e.type==='skip').length;
  const retrievalKey=JSON.stringify(['genres','excludedGenres','genreMode','mood','energy','vocals','preferredArtists','blockedArtists','playlistSource','seedPlaylistIds'].map(k=>state.settings[k]));
  useEffect(()=>{if(!ready||!state.onboarded||!online||state.settings.offlineOnly)return;const timer=setTimeout(()=>refresh(),1500);return()=>clearTimeout(timer);},[tasteSeed,retrievalKey]);
  useEffect(()=>{if(audio.current)audio.current.volume=state.settings.volume;},[state.settings.volume]);
  useEffect(()=>{
    let previous=performance.now();
    const timer=setInterval(()=>{
      const now=performance.now(),delta=Math.min(1.5,(now-previous)/1000);previous=now;
      const yt=currentRef.current?.source==='youtube';if(yt?youtube.current?.getPlayerState?.()===1:audio.current&&!audio.current.paused&&!audio.current.seeking&&audio.current.readyState>=3)session.current.seconds+=delta;
    },500);
    return ()=>clearInterval(timer);
  },[]);
  useEffect(()=>{
    if(!current)return;
    if('mediaSession' in navigator){navigator.mediaSession.metadata=new MediaMetadata({title:current.title,artist:current.artist,album:'Forma',artwork:current.artwork?[{src:current.artwork}]:[]});}
  },[current]);
  useEffect(()=>{
    if(!('mediaSession' in navigator))return;
    navigator.mediaSession.setActionHandler('play',()=>{if(currentRef.current?.source==='youtube')youtube.current?.playVideo?.();else audio.current?.play().catch(()=>{});});
    navigator.mediaSession.setActionHandler('pause',()=>{audio.current?.pause();youtube.current?.pauseVideo?.();});
    navigator.mediaSession.setActionHandler('nexttrack',()=>nextTrack('skip'));
    navigator.mediaSession.setActionHandler('previoustrack',()=>previousTrack());
    return ()=>{for(const action of ['play','pause','nexttrack','previoustrack'])navigator.mediaSession.setActionHandler(action,null);};
  },[downloads,repeat]);
  useEffect(()=>{
    const key=e=>{if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable||modal)return;if(e.code==='Space'){e.preventDefault();togglePlayback();}if(e.ctrlKey&&e.code==='ArrowRight'){e.preventDefault();nextTrack('skip');}if(e.ctrlKey&&e.code==='ArrowLeft'){e.preventDefault();previousTrack();}};
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[current,modal]);

  async function refresh() {
    if(!navigator.onLine||stateRef.current.settings.offlineOnly)return;
    const snapshot=stateRef.current;const signature=JSON.stringify([snapshot.settings.provider,['genres','excludedGenres','genreMode','mood','energy','vocals','preferredArtists','blockedArtists','playlistSource','seedPlaylistIds'].map(k=>snapshot.settings[k]),snapshot.likes,snapshot.playlists.map(p=>p.trackIds),snapshot.events.filter(e=>e.type==='listen'||e.type==='skip').length]);
    if(refreshBusy.current){refreshPending.current=signature!==refreshSignature.current;return;}
    refreshSignature.current=signature;refreshBusy.current=true;setLoading(true);setNetworkError('');
    try {const s=stateRef.current;const candidates=s.settings.provider==='audius'?await collectCandidates(s,bridge.request):await collectYouTubeCandidates(s,(route,params)=>bridge.catalogRequest(route,params,'youtube'));change(s=>mergeTracks(s,candidates));refreshCount.current++;}
    catch(e){setNetworkError(e.message);}
    finally{setLoading(false);refreshBusy.current=false;if(refreshPending.current){refreshPending.current=false;refresh();}}
  }
  const allTracks=useMemo(()=>Object.values(state.tracks),[state.tracks]);
  const candidates=useMemo(()=>state.settings.offlineOnly||!online?allTracks.filter(t=>downloads[t.id]):allTracks.filter(t=>t.source==='local'||(t.source||'audius')===provider),[allTracks,state.settings.offlineOnly,online,downloads,provider]);
  const recommendations=useMemo(()=>rankTracks(candidates,state,{limit:30}),[candidates,state]);
  const waveKey=JSON.stringify(waveSettings(state.settings));
  useEffect(()=>{if(!waveRef.current)return;const ctx=contextRef.current;const modified=ctx?.discovery?{...stateRef.current,settings:{...stateRef.current.settings,discovery:ctx.discovery}}:stateRef.current;setPlaybackQueue(rankTracks(candidates,modified,{limit:30,context:ctx,exclude:currentRef.current?[currentRef.current.id]:[]}).map(r=>r.track));},[waveKey,candidates]);
  const taste=useMemo(()=>Object.entries(buildProfile(state).positive).filter(([k])=>k.startsWith('genre:')).sort((a,b)=>b[1]-a[1]).slice(0,3),[state]);
  const personalized=state.likes.length>0||state.events.some(e=>e.type==='listen')||state.playlists.some(p=>p.trackIds.length);

  function finalize(reason) {
    const t=currentRef.current,seconds=session.current.seconds;
    if(!t||!session.current.recorded||seconds<1)return;
    const ratio=Math.min(1,seconds/((t.source==='youtube'?youtube.current?.getDuration?.():audio.current?.duration)||t.duration||Infinity));
    change(s=>recordEvent(s,t.id,reason==='skip'?'skip':'listen',{seconds,ratio}));
    session.current.recorded=false;
  }
  function setPlaybackQueue(items) {queueRef.current=items;setQueue(items);}
  function setWaveMode(value){waveRef.current=value;setWave(value);}
  async function playTrack(track,list=null,{asWave=false,reason='skip',history=true}={}) {
    if(!track)return;
    if((stateRef.current.settings.offlineOnly||!online)&&!downloads[track.id]){notify('Этот трек ещё не скачан. Выбери трек из раздела «Загрузки».');return;}
    finalize(reason);
    if(history&&currentRef.current)playbackHistory.current.push(currentRef.current);
    if(list){const index=list.findIndex(t=>t.id===track.id);setPlaybackQueue(list.slice(index+1));setWaveMode(asWave);}
    const token=++playToken.current;
    youtube.current?.pauseVideo?.();
    const el=audio.current;el.pause();el.removeAttribute('src');el.load();
    currentRef.current=track;setCurrent(track);setPosition(0);setDuration(track.duration);setBuffering(true);session.current={seconds:0,recorded:false};
    if(track.source==='youtube'){if(youtube.current?.getVideoData?.().video_id===track.videoId){youtube.current.seekTo(0,true);youtube.current.playVideo();}return;}
    try{
      const sources=await bridge.sources(track.id);if(token!==playToken.current)return;
      const trySource=index=>{
        if(token!==playToken.current)return;
        if(index>=sources.length){session.current.recorded=false;setBuffering(false);setPlaying(false);el.onerror=null;notify('Не удалось воспроизвести трек. Он может быть недоступен в источнике музыки.');return;}
        el.onerror=()=>trySource(index+1);el.src=sources[index];
        el.play().catch(e=>{if(token===playToken.current&&e.name!=='AbortError'){setBuffering(false);if(e.name==='NotAllowedError')notify('Нажми кнопку воспроизведения, чтобы начать.');}});
      };trySource(0);
    }catch(e){if(token===playToken.current){setBuffering(false);notify(e.message);}}
  }
  function startWave(ctx=null) {
    contextRef.current=ctx;
    const modified=ctx?.discovery?{...stateRef.current,settings:{...stateRef.current.settings,discovery:ctx.discovery}}:stateRef.current;
    const ranked=rankTracks(candidates,modified,{limit:30,context:ctx,exclude:currentRef.current?[currentRef.current.id]:[]});
    if(!ranked.length){notify(loading?'Подожди, загружаем музыкальный каталог.':'Пока нет новых треков для волны. Обнови каталог или выбери музыку в поиске.');return;}
    setWaveMode(true);setPlaybackQueue(ranked.slice(1).map(r=>r.track));playTrack(ranked[0].track,null,{asWave:true});
  }
  function nextTrack(reason='skip') {
    finalize(reason);
    if(reason==='listen'&&repeatRef.current&&currentRef.current){playTrack(currentRef.current,null,{reason:'listen',history:false});return;}
    if(waveRef.current){
      const s=stateRef.current,ctx=contextRef.current;
      const pool=Object.values(s.tracks).filter(t=>(!s.settings.offlineOnly&&online&&(t.source==='local'||(t.source||'audius')===s.settings.provider))||downloads[t.id]);
      const modified=ctx?.discovery?{...s,settings:{...s.settings,discovery:ctx.discovery}}:s;
      const ranked=rankTracks(pool,modified,{limit:30,context:ctx,exclude:currentRef.current?[currentRef.current.id]:[]});
      if(ranked.length){setPlaybackQueue(ranked.slice(1).map(r=>r.track));playTrack(ranked[0].track,null,{reason:'listen'});if(ranked.length<6&&!refreshBusy.current)refresh();return;}
      audio.current.pause();youtube.current?.pauseVideo?.();setPlaying(false);setPlaybackQueue([]);notify('Новые треки закончились. Обнови каталог или запусти плейлист.');return;
    }
    const items=[...queueRef.current];
    const index=shuffle?Math.floor(Math.random()*items.length):0;
    const [next]=items.splice(index,1);setPlaybackQueue(items);
    if(next)playTrack(next,null,{reason:'listen'});else{audio.current.pause();youtube.current?.pauseVideo?.();setPlaying(false);}
  }
  function seekTo(value){if(currentRef.current?.source==='youtube')youtube.current?.seekTo?.(value,true);else audio.current.currentTime=value;setPosition(value);}
  function previousTrack(){if(!currentRef.current)return;const time=currentRef.current.source==='youtube'?youtube.current?.getCurrentTime?.()||0:audio.current.currentTime;if(time>3){seekTo(0);return;}const prev=playbackHistory.current.pop();if(prev){setWaveMode(false);setPlaybackQueue([currentRef.current,...queueRef.current]);playTrack(prev,null,{reason:'listen',history:false});}}
  function togglePlayback(){if(!currentRef.current){startWave();return;}if(currentRef.current.source==='youtube'){if(youtube.current?.getPlayerState?.()===1)youtube.current.pauseVideo();else youtube.current?.playVideo?.();return;}if(audio.current.paused)audio.current.play().catch(()=>notify('Не удалось начать воспроизведение.'));else audio.current.pause();}

  async function importLocal(kind){setImportingLocal(true);try{const result=await bridge.importLocal(kind);setDownloads(result.files);change(s=>mergeTracks(s,Object.values(result.files).map(f=>f.track)));notify(`Добавлено файлов: ${result.added}.${result.errors.length?' Не удалось прочитать: '+result.errors.length+'. '+result.errors[0].file+': '+result.errors[0].error:''}`);}catch(e){notify(e.message);}finally{setImportingLocal(false);}}
  function onPlaying(){setPlaying(true);setBuffering(false);if(!session.current.recorded&&currentRef.current){session.current.recorded=true;change(s=>recordEvent(s,currentRef.current.id,'play'));}}
  function toggleLike(t){change(s=>({...s,likes:s.likes.includes(t.id)?s.likes.filter(id=>id!==t.id):[...s.likes,t.id]}));}
  function hideTrack(t){change(s=>recordEvent({...s,hidden:[...new Set([...s.hidden,t.id])]},t.id,'hide'));notify('Больше не будем рекомендовать этот трек.');if(currentRef.current?.id===t.id)nextTrack('skip');}
  async function downloadTrack(t){
    if(!t.downloadable){notify('Автор не разрешил свободное скачивание этого трека.');return;}
    setProgress(p=>({...p,[t.id]:{id:t.id,bytes:0,total:0}}));
    try{const file=await bridge.download(t.id);setDownloads(d=>({...d,[t.id]:file}));change(s=>mergeTracks(s,[file.track]));notify('Трек сохранён. Можно слушать без интернета.');}
    catch(e){notify(e.message);}
    finally{setProgress(p=>{const n={...p};delete n[t.id];return n;});}
  }
  async function removeDownload(t){try{setDownloads(await bridge.removeDownload(t.id));notify('Файл удалён с диска.');}catch(e){notify(e.message);}}
  function searchTracks(event){event.preventDefault();if(page!=='search'){navHistory.current.push('search');setPage('search');}}
  function typeSearch(value){setQuery(value);if(page!=='search'){navHistory.current.push('search');setPage('search');}}
  function createPlaylist(e){e.preventDefault();const name=playlistName.trim();if(!name)return;const id=crypto.randomUUID();change(s=>({...s,playlists:[...s.playlists,{id,name,trackIds:playlistTarget?[playlistTarget.id]:[],createdAt:Date.now()}]}));setPlaylistName('');setModal(null);setPlaylistTarget(null);navigate(`playlist:${id}`);notify('Плейлист создан.');}
  function addToPlaylist(id){change(s=>({...s,playlists:s.playlists.map(p=>p.id===id?{...p,trackIds:[...new Set([...p.trackIds,playlistTarget.id])]}:p)}));setModal(null);notify('Трек добавлен. Волна учтёт твой выбор.');}
  function openAdd(t){setPlaylistTarget(t);setPlaylistName('');setModal('add');}
  function playList(tracks){if(!tracks.length)return;contextRef.current=null;playTrack(tracks[0],tracks);}

  function rows(tracks,{reasons={},playlist=null,downloaded=false}={}) { return <div className="track-table"><div className="track-table-head"><span>#</span><span>ТРЕК / ИСПОЛНИТЕЛЬ</span><span className="genre-column">{Object.keys(reasons).length?'ДЛЯ ТЕБЯ':'ЖАНР'}</span><span>ВРЕМЯ</span><span/></div>{tracks.map((t,i)=><div className={`track-row ${current?.id===t.id?'is-current':''}`} key={t.id}>
    <button className="track-number" aria-label={`Слушать ${t.title}`} onClick={()=>playTrack(t,tracks)}>{current?.id===t.id&&playing?<AudioLines size={17}/>:<><span>{String(i+1).padStart(2,'0')}</span><Play className="row-play" size={15} fill="currentColor"/></>}</button>
    <button className="track-name" onClick={()=>playTrack(t,tracks)}><Cover track={t}/><span><strong>{t.title}</strong><small>{t.artist}{downloads[t.id]&&<Check size={11} className="download-mark"/>}</small></span></button>
    <span className="genre-column row-reason">{reasons[t.id]||t.genre||'—'}</span><span className="track-time">{fmt(t.duration)}</span>
    <div className="track-actions"><IconButton title={state.likes.includes(t.id)?`Убрать ${t.title} из любимого`:`Нравится ${t.title}`} active={state.likes.includes(t.id)} onClick={()=>toggleLike(t)}><Heart size={17} fill={state.likes.includes(t.id)?'currentColor':'none'}/></IconButton>
      {progress[t.id]?<IconButton title="Отменить загрузку" onClick={()=>bridge.cancelDownload?.(t.id)}><LoaderCircle size={16} className="spin"/></IconButton>:<IconButton title={downloads[t.id]?'Скачано':t.downloadable?`Скачать ${t.title}`:t.source==='youtube'?'Музыка из YouTube слушается онлайн':'Автор отключил скачивание'} disabled={!t.downloadable||!!downloads[t.id]} onClick={()=>downloadTrack(t)}>{downloads[t.id]?<Check size={16}/>:<ArrowDownToLine size={16}/>}</IconButton>}
      <IconButton title={`Действия с треком ${t.title}`} onClick={()=>{setPlaylistTarget(t);setModal({type:'track',playlist,downloaded});}}><MoreHorizontal size={18}/></IconButton>
    </div>
  </div>)}</div>; }

  const selectedPlaylist=state.playlists.find(p=>page===`playlist:${p.id}`);
  const selectedMix=mixes.find(m=>page===`mix:${m.id}`);
  let collectionTracks=[],collectionTitle='',collectionSubtitle='',collectionIcon=Heart;
  if(page==='liked'){collectionTracks=state.likes.map(id=>state.tracks[id]).filter(Boolean);collectionTitle='Любимые треки';collectionSubtitle='То, к чему хочется возвращаться';}
  if(page==='downloads'){collectionTracks=Object.values(downloads).map(d=>d.track);collectionTitle='Всегда с тобой';collectionSubtitle='Локальные файлы и загрузки · доступны без интернета';collectionIcon=ArrowDownToLine;}
  if(selectedPlaylist){collectionTracks=selectedPlaylist.trackIds.map(id=>state.tracks[id]).filter(Boolean);collectionTitle=selectedPlaylist.name;collectionSubtitle='Твой плейлист · влияет на персональную волну';collectionIcon=ListMusic;}
  if(selectedMix){const modified=selectedMix.context?.discovery?{...state,settings:{...state.settings,discovery:0.85}}:state;collectionTracks=rankTracks(candidates,modified,{limit:40,context:selectedMix.context}).map(r=>r.track);collectionTitle=selectedMix.title;collectionSubtitle=selectedMix.subtitle;collectionIcon=Disc3;}
  const CollectionIcon=collectionIcon;

  return <div className="app-shell" style={appearanceVariables(state.settings)} data-palette={state.settings.palette}>
    <audio ref={audio} onPlaying={onPlaying} onPause={()=>setPlaying(false)} onWaiting={()=>setBuffering(true)} onCanPlay={()=>setBuffering(false)} onTimeUpdate={()=>setPosition(audio.current.currentTime)} onDurationChange={()=>{if(Number.isFinite(audio.current.duration))setDuration(audio.current.duration);}} onEnded={()=>nextTrack('listen')}/>
    <aside className="sidebar"><div className="brand"><AudioLines size={27} strokeWidth={2.2}/><span>forma<span className="brand-dot">.</span></span></div>
      <div className="sidebar-label">ТВОЯ МУЗЫКА</div><nav>
        {[['home',Home,'Главная'],['search',Search,'Поиск'],['wave-settings',SlidersHorizontal,'Настройка волны'],['liked',Heart,'Любимые треки'],['downloads',ArrowDownToLine,'Скачанное'],['import',ArrowRightLeft,'Перенос библиотеки']].map(([id,Icon,label])=><button key={id} className={`nav-item ${page===id?'selected':''}`} onClick={()=>navigate(id)}><Icon size={19} strokeWidth={1.7}/><span>{label}</span>{id==='liked'&&state.likes.length>0&&<small>{state.likes.length}</small>}</button>)}
      </nav>
      <div className="playlist-heading"><span className="sidebar-label">ПЛЕЙЛИСТЫ</span><IconButton title="Создать плейлист" onClick={()=>{setPlaylistTarget(null);setPlaylistName('');setModal('create');}}><Plus size={17}/></IconButton></div>
      <div className="sidebar-playlists">{state.playlists.map(p=><button key={p.id} className={`playlist-link ${selectedPlaylist?.id===p.id?'selected':''}`} onClick={()=>navigate(`playlist:${p.id}`)}><span className="playlist-icon"><ListMusic size={17}/></span><span>{p.name}<small>{p.trackIds.length} треков</small></span></button>)}{!state.playlists.length&&<button className="create-playlist-hint" onClick={()=>{setPlaylistTarget(null);setModal('create');}}>Собери свой первый плейлист<Plus size={14}/></button>}</div>
      <div className="sidebar-bottom"><div className="local-note"><span className="status-dot"/>Твой вкус остаётся с тобой<small>Рекомендации хранятся на устройстве</small></div><button className={`nav-item ${page==='settings'?'selected':''}`} onClick={()=>navigate('settings')}><Settings2 size={18}/><span>Настройки</span></button><span className="powered">YOUTUBE + YOUR MUSIC <ArrowUpRight size={11}/></span></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="topbar-left"><IconButton title="Назад" disabled={navHistory.current.length<2} onClick={goBack}><ArrowLeft size={18}/></IconButton><span>{page==='home'?'Для тебя':page==='search'?'Открывай новое':page==='settings'?'Настройки':page==='wave-settings'?'Твоя волна':'Твоя коллекция'}</span></div><form className="search-field" onSubmit={searchTracks}><Search size={17}/><input aria-label="Поиск треков и исполнителей" placeholder="Трек или исполнитель" value={query} onChange={e=>typeSearch(e.target.value)}/><kbd>↵</kbd></form><div className="topbar-right"><span className="online-badge">{online&&!state.settings.offlineOnly?<><span className="status-dot"/>На связи</>:<><WifiOff size={13}/>Офлайн</>}</span><button className="profile-avatar" title="Мой музыкальный профиль" onClick={()=>navigate('settings')}>F</button></div>{bridge.desktop&&<div className="window-controls"><button aria-label="Свернуть" onClick={()=>bridge.windowControl('minimize')}><Minus size={14}/></button><button aria-label="Развернуть" onClick={()=>bridge.windowControl('maximize')}><Square size={11}/></button><button className="window-close" aria-label="Закрыть" onClick={()=>bridge.windowControl('close')}><X size={15}/></button></div>}</header>
    <div className={`main-stage ${current?.source==='youtube'?'with-video':''}`}><main className="content" key={page}>
      {(!online||state.settings.offlineOnly)&&<div className="offline-banner"><WifiOff size={16}/><span>Слушаем без интернета. Волна подбирает музыку из скачанных треков.</span></div>}
      {networkError&&<div className="network-banner"><span>{networkError}</span><button onClick={refresh} disabled={loading}>Повторить <RefreshCw size={13}/></button></div>}
      {page==='home'&&<>
        <div className="page-intro"><div><span className="eyebrow">ТВОЁ ЛИЧНОЕ ПРОСТРАНСТВО</span><h1>Всё начинается с музыки<span>.</span></h1><p>Чуть больше того, что любишь. Чуть ближе к чему-то новому.</p></div><span className="edition">MADE FOR YOU<br/><b>VOL. 01</b></span></div>
        <section className={`wave-hero ${wave&&playing?'wave-playing':''}`}><div className="wave-copy"><div className="hero-eyebrow"><span className="live-dot"/>БЕСКОНЕЧНО. ПЕРСОНАЛЬНО.</div><h2>На твоей волне</h2><p>{personalized?'Твой вкус задаёт направление. Мы находим музыку,\nкоторая откликается — и оставляем место открытиям.':'Выбери любимые треки. Добавляй в плейлисты.\nКаждое прослушивание делает эту волну ближе к тебе.'}</p><div className="hero-buttons"><button className="button button-dark" onClick={()=>wave&&current?togglePlayback():startWave()}>{wave&&buffering?<LoaderCircle size={17} className="spin"/>:wave&&playing?<Pause size={17} fill="currentColor"/>:<Play size={17} fill="currentColor"/>}{wave&&playing?'Приостановить':'Слушать волну'}</button><button className="hero-settings" onClick={()=>navigate('wave-settings')}><SlidersHorizontal size={17}/>Настроить волну</button></div></div><div className="wave-art" aria-hidden="true"><div className="orbit orbit-1"/><div className="orbit orbit-2"/><div className="orbit orbit-3"/><div className="orbit orbit-4"/><div className="orbit orbit-5"/><div className="wave-core"><AudioLines size={56} strokeWidth={1}/></div><span className="orbit-satellite satellite-1"/><span className="orbit-satellite satellite-2"/></div><span className="hero-corner">YOUR OWN FREQUENCY ↗</span></section>
        <div className="section-heading"><div><h2>Другой ритм — тот же ты</h2><p>Подборки, которые меняются вместе с твоим вкусом</p></div><span className="small-caption">СОБРАНО ДЛЯ ТЕБЯ</span></div>
        <div className="mix-grid">{mixes.map((m,i)=><button className="mix-card" key={m.id} onClick={()=>navigate(`mix:${m.id}`)}><div className={`mix-art ${m.className}`}><span>{m.label}</span><div className={`mix-shape shape-${i}`}><i/><i/><i/><i/></div><strong>{['in your\nelement','less noise.\nmore flow.','the quiet\nside of night','something\nunexpected'][i]}</strong><span className="mix-play"><Play size={19} fill="currentColor"/></span></div><h3>{m.title}</h3><p>{m.subtitle}</p></button>)}</div>
        <div className="home-lower"><section className="for-you"><div className="section-heading"><div><h2>{personalized?'Следующее любимое':'Начни с этих треков'}</h2><p>{personalized?'В твоём вкусе, но со свежим звучанием':'Сохраняй то, что откликается. Волна запомнит.'}</p></div><IconButton title="Обновить рекомендации" onClick={refresh} disabled={loading||!online||state.settings.offlineOnly}><RefreshCw size={17} className={loading?'spin':''}/></IconButton></div>{recommendations.length?rows(recommendations.slice(0,6).map(r=>r.track),{reasons:Object.fromEntries(recommendations.map(r=>[r.track.id,r.reason]))}):<Empty icon={loading?LoaderCircle:Radio} title={loading?'Находим музыку для тебя':'Твоя музыка начинается здесь'} text={loading?'Загружаем музыкальный каталог. Это может занять несколько секунд.':'Выбери жанры и подключись к YouTube, чтобы получить первые рекомендации.'} action={!loading&&<button className="button button-outline" onClick={refresh} disabled={!online||state.settings.offlineOnly}>Загрузить музыку <RefreshCw size={15}/></button>}/>}</section><aside className="taste-card"><span className="eyebrow">ТВОЙ МУЗЫКАЛЬНЫЙ ДНК</span><div className="taste-heading"><h3>Волна слушает тебя</h3><AudioLines size={20}/></div><p>Любимые треки и плейлисты задают основу. Дослушивания уточняют её. Пропуски меняют направление.</p><div className="taste-bars">{taste.length?taste.map(([genre,value],i)=><div key={genre}><span>{genre.slice(6)}</span><div><i style={{width:`${Math.max(12,100*value/taste[0][1])}%`,opacity:1-i*0.2}}/></div></div>):<div className="taste-placeholder">Твой профиль ещё впереди.<br/>Начни с пары любимых жанров.</div>}</div><button className="text-link" onClick={()=>navigate('settings')}>Посмотреть свой профиль <ArrowUpRight size={15}/></button></aside></div>
        <div className="home-footer"><span>МЕНЬШЕ ШУМА. БОЛЬШЕ МУЗЫКИ.</span><span>forma / music that finds you</span></div>
      </>}
      {page==='search'&&<SearchPage query={query} setQuery={typeSearch} request={catalogRequest} tracks={candidates} offline={!online||state.settings.offlineOnly} provider={provider} renderTracks={rows} onTracks={ts=>{if(ts.length)change(s=>mergeTracks(s,ts));}} onPlay={playList}/>}
      {page==='wave-settings'&&<WaveSettingsPage settings={state.settings} playlists={state.playlists} onChange={updateSettings} recommendations={recommendations} renderTracks={rows} onRefresh={refresh} loading={loading} canRefresh={online&&!state.settings.offlineOnly} onPlay={()=>startWave()}/>}
      {page==='import'&&<LibraryImportPage bridge={importBridge} provider={provider} state={state} onChange={change} onNavigate={navigate} onNotify={notify} onPreview={t=>{change(s=>mergeTracks(s,[t]));playTrack(t);}}/>}
      {(page==='liked'||page==='downloads'||selectedPlaylist||selectedMix)&&<><div className="collection-hero"><div className={`collection-art ${selectedMix?.className||''}`}><CollectionIcon size={70} strokeWidth={1}/></div><div><span className="eyebrow">{selectedMix?'ПЕРСОНАЛЬНАЯ ПОДБОРКА':page==='downloads'?'ОФЛАЙН-БИБЛИОТЕКА':'ТВОЯ КОЛЛЕКЦИЯ'}</span><h1>{collectionTitle}</h1><p>{collectionSubtitle}</p><span className="collection-meta">{collectionTracks.length} треков <span>·</span> {Math.round(collectionTracks.reduce((sum,t)=>sum+t.duration,0)/60)} мин{page==='downloads'&&<> <span>·</span> {(Object.values(downloads).reduce((s,d)=>s+d.bytes,0)/1024**2).toFixed(1)} МБ</>}</span></div></div><div className="collection-controls"><button className="big-play" aria-label="Слушать подборку" disabled={!collectionTracks.length} onClick={()=>selectedMix?startWave(selectedMix.context):playList(collectionTracks)}><Play size={23} fill="currentColor"/></button><span>{selectedMix?'Подстраивается под твой вкус':'Слушать всё'}</span>{page==='downloads'&&<><button className="button button-primary" disabled={importingLocal} onClick={()=>importLocal('files')}><Plus size={17}/>{importingLocal?'Добавляем файлы…':'Добавить файлы'}</button><button className="button button-outline" disabled={importingLocal} onClick={()=>importLocal('folder')}><FolderOpen size={17}/>Добавить папку</button><button className="button button-outline" onClick={()=>bridge.openFolder()}><FolderOpen size={16}/>Открыть папку</button></>}{selectedPlaylist&&<div className="collection-extra"><IconButton title="Переименовать плейлист" onClick={()=>{setPlaylistName(selectedPlaylist.name);setModal('rename');}}><Settings2 size={18}/></IconButton><IconButton title="Удалить плейлист" onClick={()=>setModal('delete-playlist')}><Trash2 size={18}/></IconButton></div>}</div>{collectionTracks.length?rows(collectionTracks,{playlist:selectedPlaylist?.id,downloaded:page==='downloads'}):<Empty icon={CollectionIcon} title={page==='downloads'?'Музыка, которая всегда рядом':'Здесь будут твои треки'} text={page==='downloads'?'Добавь MP3, FLAC, M4A, OGG или WAV. Forma скопирует файлы в свою библиотеку, прочитает теги и учтёт музыку в рекомендациях.':'Сохраняй треки сердечком или добавляй через меню в плейлист — это помогает волне лучше понимать тебя.'} action={<button className="button button-outline" onClick={()=>navigate('search')}>Найти музыку <Search size={15}/></button>}/>}</>}
      {page==='settings'&&<><div className="page-intro"><div><span className="eyebrow">ТВОЙ ВКУС. ТВОИ ПРАВИЛА.</span><h1>Ближе к тебе<span>.</span></h1><p>Настрой музыку под себя. Всё хранится на этом устройстве.</p></div></div><AppearanceSettings settings={state.settings} onChange={updateSettings}/><div className="settings-grid"><section className="settings-card"><h2>Персональная волна</h2><p>Жанры и исключения, настроение, энергия, вокал, артисты, плейлисты и повторы — собери звучание под себя.</p><div className="wave-settings-summary"><span>{state.settings.genres.length?state.settings.genres.join(' · '):'Любые направления'}</span><span>Открытия: {Math.round(state.settings.discovery*100)}%</span><span>Интервал повторов: {state.settings.repeatCooldown} ч</span></div><button className="button button-primary" onClick={()=>navigate('wave-settings')}><SlidersHorizontal size={17}/>Настроить рекомендации</button></section><section className="settings-card"><h2>Твой профиль</h2><div className="profile-stats"><div><strong>{state.likes.length}</strong><span>любимых треков</span></div><div><strong>{state.playlists.length}</strong><span>плейлистов</span></div><div><strong>{state.events.filter(e=>e.type==='listen'||e.type==='skip').length}</strong><span>прослушиваний</span></div></div><div className="signal-explanation"><p><Heart size={16}/><span><b>Сохранения и плейлисты</b> — самые сильные сигналы интереса.</span></p><p><AudioLines size={16}/><span><b>Дослушивания</b> помогают понять, что подходит сейчас.</span></p><p><SkipForward size={16}/><span><b>Ранние пропуски</b> снижают вероятность похожих рекомендаций.</span></p><p><Shuffle size={16}/><span><b>Разнообразие</b> оставляет место новым артистам и убирает близкие повторы.</span></p></div><p className="settings-note">Старые сигналы постепенно теряют вес. Профиль не отправляется на сервер. Это собственная система рекомендаций Forma.</p><button className="button button-outline" onClick={()=>bridge.exportProfile().then(ok=>ok&&notify('Библиотека экспортирована.')).catch(e=>notify(e.message))}>Экспортировать библиотеку <ArrowUpRight size={15}/></button></section><section className="settings-card"><h2>Без интернета</h2><div className="setting-row"><div><strong>Только скачанная музыка</strong><p>Волна и поиск используют локальные треки</p></div><button role="switch" aria-label="Только скачанная музыка" aria-checked={state.settings.offlineOnly} className={`toggle ${state.settings.offlineOnly?'on':''}`} onClick={()=>updateSettings({offlineOnly:!state.settings.offlineOnly})}><i/></button></div><p className="settings-note">Скачано {Object.keys(downloads).length} треков. Локальные файлы сохраняются в библиотеке Forma. YouTube играет онлайн; Audius разрешает загрузки с согласия автора. Максимальный объём — 10 ГБ.</p><button className="text-link" onClick={()=>navigate('downloads')}>Управлять скачанным <ChevronRight size={15}/></button></section><section className="settings-card"><h2>Источник онлайн-музыки</h2><p>YouTube — основной каталог. Audius можно включить для независимой музыки.</p><div className="mode-buttons">{[['youtube','YouTube'],['audius','Audius']].map(([id,label])=><button key={id} className={provider===id?'selected':''} onClick={()=>updateSettings({provider:id})}>{label}</button>)}</div><p className="settings-note">Поиск YouTube читает публичный музыкальный каталог без аккаунта. Встроенный плеер требует доступности YouTube и разрешения автора. Локальные файлы работают без сети.</p><h3>Audius</h3><p>Forma использует публичный каталог Audius. Если узел требует ключ, можно указать ключ бесплатного плана.</p><label className="field-label" htmlFor="api-key">API-ключ (необязательно)</label><input id="api-key" className="text-input" type="password" autoComplete="off" value={state.settings.apiKey||''} onChange={e=>updateSettings({apiKey:e.target.value})} placeholder="Твой ключ Audius"/><p className="settings-note">Ключ хранится локально. Скачать музыку можно только из доступного каталога Audius.</p><button className="text-link" onClick={()=>setModal('reset-history')}>Сбросить историю прослушиваний <RefreshCw size={14}/></button>{state.hidden.length>0&&<button className="text-link" onClick={()=>{change(s=>({...s,hidden:[],events:s.events.filter(e=>e.type!=='hide')}));notify('Скрытые треки снова могут появляться в волне.');}}>Вернуть скрытые треки ({state.hidden.length}) <Plus size={14}/></button>}</section></div></>}
    </main>{current?.source==='youtube'&&<YouTubePlayer key={current.videoId} track={current} onReady={p=>{youtube.current=p;}} onPlaying={onPlaying} onPaused={()=>{setPlaying(false);setBuffering(false);}} onBuffering={()=>setBuffering(true)} onEnded={()=>nextTrack('listen')} onTime={(time,total)=>{setPosition(time);if(total)setDuration(total);}} onError={message=>{session.current.recorded=false;setPlaying(false);setBuffering(false);notify(message);}} onOpen={id=>bridge.openYouTube(id)} volume={state.settings.volume}/>}</div></div>
    {queueOpen&&<aside className="queue-panel"><div className="queue-heading"><h3>Дальше в эфире</h3><IconButton title="Закрыть очередь" onClick={()=>setQueueOpen(false)}><X size={18}/></IconButton></div><span className="eyebrow">{wave?'ПЕРСОНАЛЬНАЯ ВОЛНА':'ОЧЕРЕДЬ ПРОСЛУШИВАНИЯ'}</span><p>{wave?'Следующий трек уточняется после каждого прослушивания.':'Музыка, которую ты выбрал.'}</p>{queue.length?queue.slice(0,20).map(t=><button className="queue-track" key={t.id} onClick={()=>{setPlaybackQueue(queueRef.current.filter(x=>x.id!==t.id));playTrack(t);}}><Cover track={t}/><span><strong>{t.title}</strong><small>{t.artist}</small></span><Play size={14}/></button>):<Empty title="Очередь пока пуста" text="Запусти волну или свой плейлист."/>}</aside>}
    <footer className="player"><div className="now-playing"><Cover track={current} className="player-cover"/><div><strong>{current?.title||'Поймай свой ритм'}</strong><span>{current?.artist||'Музыка ждёт тебя'}</span></div>{current&&<IconButton title="Нравится текущий трек" active={state.likes.includes(current.id)} onClick={()=>toggleLike(current)}><Heart size={18} fill={state.likes.includes(current.id)?'currentColor':'none'}/></IconButton>}</div><div className="player-center"><div className="transport"><IconButton title="Перемешать" active={shuffle} disabled={wave} onClick={()=>setShuffle(!shuffle)}><Shuffle size={16}/></IconButton><IconButton title="Предыдущий трек" disabled={!current} onClick={previousTrack}><SkipBack size={18} fill="currentColor"/></IconButton><button className="play-button" aria-label={playing?'Пауза':'Воспроизвести'} onClick={togglePlayback}>{buffering?<LoaderCircle size={19} className="spin"/>:playing?<Pause size={19} fill="currentColor"/>:<Play size={19} fill="currentColor"/>}</button><IconButton title="Следующий трек" disabled={!current} onClick={()=>nextTrack('skip')}><SkipForward size={18} fill="currentColor"/></IconButton><IconButton title="Повторить трек" active={repeat} onClick={()=>{repeatRef.current=!repeat;setRepeat(!repeat);}}><Repeat size={16}/></IconButton></div><div className="seek"><span>{fmt(position)}</span><input aria-label="Позиция воспроизведения" type="range" min="0" max={duration||1} value={Math.min(position,duration||1)} step="0.1" disabled={!current} style={{'--fill':`${duration?100*position/duration:0}%`}} onChange={e=>seekTo(Number(e.target.value))}/><span>{fmt(duration)}</span></div></div><div className="player-right">{wave&&<span className="wave-badge"><Radio size={12}/>Волна</span>}<IconButton title="Очередь воспроизведения" active={queueOpen} onClick={()=>setQueueOpen(!queueOpen)}><ListMusic size={19}/></IconButton><IconButton title={state.settings.volume?'Выключить звук':'Включить звук'} onClick={()=>updateSettings({volume:state.settings.volume?0:0.7})}>{state.settings.volume?<Volume2 size={18}/>:<VolumeX size={18}/>}</IconButton><input type="range" aria-label="Громкость" min="0" max="1" step="0.01" value={state.settings.volume} style={{'--fill':`${state.settings.volume*100}%`}} onChange={e=>updateSettings({volume:Number(e.target.value)})}/></div></footer>
    {toast&&<div className="toast" role="status"><span>{toast}</span><button aria-label="Закрыть уведомление" onClick={()=>setToast('')}><X size={15}/></button></div>}
    {modal&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&modal!=='onboarding')setModal(null);}}><section className={`modal ${modal==='onboarding'?'onboarding-modal':''}`} role="dialog" aria-modal="true" aria-label={modal==='onboarding'?'Настройка музыкального вкуса':'Настройки и действия'}><IconButton className="modal-close" title="Закрыть" onClick={()=>{if(modal==='onboarding')change(s=>({...s,onboarded:true}));setModal(null);}}><X size={19}/></IconButton>
      {modal==='onboarding'&&<><div className="modal-brand"><AudioLines size={28}/>forma.</div><span className="eyebrow">ДАВАЙ ПОЗНАКОМИМСЯ</span><h2>Как звучит твой мир?</h2><p>Выбери направления, которые любишь. Это начало — дальше волна будет учиться у тебя.</p><div className="genre-chips onboarding-genres">{GENRES.map(g=><button key={g} className={state.settings.genres.includes(g)?'selected':''} onClick={()=>updateSettings({genres:state.settings.genres.includes(g)?state.settings.genres.filter(x=>x!==g):[...state.settings.genres,g]})}>{g}{state.settings.genres.includes(g)&&<Check size={14}/>}</button>)}</div><button className="button button-primary full-width" onClick={()=>{change(s=>({...s,onboarded:true}));setModal(null);}}>Найти мой ритм <ArrowUpRight size={17}/></button><button className="onboarding-skip" onClick={()=>{change(s=>({...s,onboarded:true}));setModal(null);}}>Выберу позже</button><span className="privacy-caption">Без регистрации. Твой профиль — на твоём устройстве.</span></>}
      {(modal==='create'||modal==='rename')&&<form onSubmit={modal==='create'?createPlaylist:e=>{e.preventDefault();if(!playlistName.trim())return;change(s=>({...s,playlists:s.playlists.map(p=>p.id===selectedPlaylist.id?{...p,name:playlistName.trim()}:p)}));setModal(null);}}><span className="eyebrow">ТВОЯ КОЛЛЕКЦИЯ</span><h2>{modal==='create'?'Новый плейлист':'Название плейлиста'}</h2><p>Треки в плейлисте помогают персональной волне понять твой вкус.</p><input className="text-input" autoFocus aria-label="Название плейлиста" placeholder="Например, для долгих прогулок" maxLength="80" value={playlistName} onChange={e=>setPlaylistName(e.target.value)} required/><button className="button button-primary full-width" type="submit">{modal==='create'?'Создать плейлист':'Сохранить'} <Plus size={16}/></button></form>}
      {modal==='add'&&<><span className="eyebrow">СОХРАНИ НАСТРОЕНИЕ</span><h2>Добавить в плейлист</h2><p>{playlistTarget?.title} · {playlistTarget?.artist}</p><div className="playlist-picker">{state.playlists.map(p=><button key={p.id} onClick={()=>addToPlaylist(p.id)}><ListMusic size={20}/><span>{p.name}<small>{p.trackIds.length} треков</small></span>{p.trackIds.includes(playlistTarget.id)?<Check size={17}/>:<Plus size={17}/>}</button>)}</div><form onSubmit={createPlaylist}><input className="text-input" aria-label="Название нового плейлиста" placeholder="Название нового плейлиста" value={playlistName} onChange={e=>setPlaylistName(e.target.value)} maxLength="80" required/><button className="button button-primary full-width" type="submit">Создать и добавить <Plus size={16}/></button></form></>}
      {modal?.type==='track'&&playlistTarget&&<><div className="modal-track"><Cover track={playlistTarget}/><div><h3>{playlistTarget.title}</h3><p>{playlistTarget.artist}</p></div></div><div className="track-menu"><button onClick={()=>openAdd(playlistTarget)}><Plus size={18}/>Добавить в плейлист</button><button onClick={()=>{toggleLike(playlistTarget);setModal(null);}}><Heart size={18}/>{state.likes.includes(playlistTarget.id)?'Убрать из любимого':'Добавить в любимое'}</button><button onClick={()=>{setPlaybackQueue([...queueRef.current,playlistTarget]);setWaveMode(false);setModal(null);notify('Добавлено в очередь.');}}><ListMusic size={18}/>Слушать следующим после очереди</button>{downloads[playlistTarget.id]?<button onClick={()=>{removeDownload(playlistTarget);setModal(null);}}><Trash2 size={18}/>Удалить скачанный файл</button>:<button disabled={!playlistTarget.downloadable} onClick={()=>{downloadTrack(playlistTarget);setModal(null);}}><ArrowDownToLine size={18}/>{playlistTarget.downloadable?'Скачать для офлайн-прослушивания':playlistTarget.source==='youtube'?'Музыка из YouTube слушается онлайн':'Автор отключил скачивание'}</button>}{modal.playlist&&<button onClick={()=>{change(s=>({...s,playlists:s.playlists.map(p=>p.id===modal.playlist?{...p,trackIds:p.trackIds.filter(id=>id!==playlistTarget.id)}:p)}));setModal(null);}}><Minus size={18}/>Убрать из плейлиста</button>}<button onClick={()=>{hideTrack(playlistTarget);setModal(null);}}><Ban size={18}/>Не рекомендовать этот трек</button></div></>}
      {modal==='delete-playlist'&&<><h2>Удалить «{selectedPlaylist?.name}»?</h2><p>Его треки перестанут быть основой рекомендаций. Скачанные файлы останутся на диске.</p><button className="button button-primary full-width" onClick={()=>{change(s=>({...s,playlists:s.playlists.filter(p=>p.id!==selectedPlaylist.id)}));setModal(null);navigate('home');}}>Удалить плейлист</button></>}
      {modal==='reset-history'&&<><h2>Начать с чистого ритма?</h2><p>Сбросим историю прослушиваний и пропусков. Любимые треки, плейлисты и выбранные жанры сохранятся.</p><button className="button button-primary full-width" onClick={()=>{change(s=>({...s,events:[]}));setModal(null);notify('История сброшена.');}}>Сбросить историю</button></>}
    </section></div>}
  </div>;
}
