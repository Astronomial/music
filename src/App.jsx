import React, { useCallback,useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Home, Search, Heart, ArrowDownToLine, Plus, Settings2, ChevronRight, ArrowUpRight, Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, ListMusic, Shuffle, Repeat, Check, X, Minus, Square, WifiOff, RefreshCw, MoreHorizontal, FolderOpen, SlidersHorizontal, ThumbsDown, Ban, Music2, ArrowLeft, Trash2, Radio, Disc3, LoaderCircle, ArrowRightLeft } from 'lucide-react';
import useSoundAnalysis from './useSoundAnalysis.jsx';
import SyncSettings from './components/SyncSettings.jsx';
import {mergeDesktop} from './core/sync.mjs';
import WaveSettingsPage from './components/WaveSettingsPage.jsx';
import VolumeControl from './components/VolumeControl.jsx';
import TrackTable from './components/TrackTable.jsx';
import RequestedPlaylistBanner,{useRequestedPlaylistImport} from './components/RequestedPlaylistImport.jsx';
import {ensureRequestedPlaylist} from './core/starter-library.mjs';
import {waveSettings,upgradeWaveSettings} from './core/wave-settings.mjs';
import YouTubePlayer from './components/YouTubePlayer.jsx';
import {collectYouTubeCandidates} from './core/catalog.mjs';
import SearchPage from './components/SearchPage.jsx';
import AppearanceSettings from './components/AppearanceSettings.jsx';
import {SpaceBackdrop,PulseGalaxy,useVisualActivity} from './components/SpaceScene.jsx';
import LibraryImportPage from './components/LibraryImportPage.jsx';
import { appearanceVariables } from './core/appearance.mjs';
import { bridge } from './bridge.mjs';
import { initialState, GENRES, mergeTracks, normalizeTrack, recordEvent } from './core/model.mjs';
import {playlistPulseContext,playlistSeedState} from './core/recommender.mjs';
import {createRecommendationClient} from './core/recommendation-client.mjs';
import {MOOD_MIXES} from './core/mood-mixes.mjs';
import {ListeningClock} from './core/listening-clock.mjs';
import { collectCandidates } from './core/audius.mjs';

const fmt = seconds => `${Math.floor((seconds || 0)/60)}:${String(Math.floor((seconds || 0)%60)).padStart(2,'0')}`;
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
  const visualsActive=useVisualActivity();
  const [state,setState]=useState(initialState), [ready,setReady]=useState(false), [page,setPage]=useState('home');
  const [loading,setLoading]=useState(false), [networkError,setNetworkError]=useState(''), [online,setOnline]=useState(navigator.onLine);
  const [downloads,setDownloads]=useState({}), [progress,setProgress]=useState({}), [toast,setToast]=useState('');
  const [query,setQuery]=useState(''),[importResume,setImportResume]=useState(null);
  const [importingLocal,setImportingLocal]=useState(false);
  const youtube=useRef(null),recommendationClient=useRef(null),selectionToken=useRef(0),actions=useRef({}),catalogContext=useRef(null),playingIntent=useRef(false),sourcesCache=useRef(new Map());
  const [youtubeMounted,setYoutubeMounted]=useState(false),[playbackId,setPlaybackId]=useState(0);
  const [analysis,setAnalysis]=useState({recommendations:[],mixes:MOOD_MIXES.map(m=>({...m,items:[]})),taste:[]});
  const provider=state.settings.provider||'youtube';
  const catalogRequest=useMemo(()=>(route,params)=>bridge.catalogRequest(route,params,provider),[provider]);
  const importBridge=useMemo(()=>({...bridge,request:catalogRequest}),[catalogRequest]);
  const [modal,setModal]=useState(null), [playlistName,setPlaylistName]=useState(''), [playlistTarget,setPlaylistTarget]=useState(null), [context,setContext]=useState(null);
  const [current,setCurrent]=useState(null), [playing,setPlaying]=useState(false), [buffering,setBuffering]=useState(false), [position,setPosition]=useState(0), [duration,setDuration]=useState(0);
  const [queue,setQueue]=useState([]), [wave,setWave]=useState(false), [queueOpen,setQueueOpen]=useState(false), [shuffle,setShuffle]=useState(false), [repeat,setRepeat]=useState(false);
  const readyRef=useRef(false),pendingCloudSync=useRef(null);
  const audio = useRef(null), stateRef=useRef(state), currentRef=useRef(null), session=useRef({clock:new ListeningClock(),recorded:false}), playToken=useRef(0), queueRef=useRef([]), waveRef=useRef(false), contextRef=useRef(null);
  const toastTimer=useRef(null), refreshBusy=useRef(false), refreshPending=useRef(false), refreshSignature=useRef(null), saveChain=useRef(Promise.resolve()), navHistory=useRef(['home']), playbackHistory=useRef([]), repeatRef=useRef(false), refreshCount=useRef(0);
  const notify = message => { setToast(message);clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(''),4500); };
  const change=useCallback(fn=>{const next=fn(stateRef.current);stateRef.current=next;setState(next);return next;},[]);
  function navigate(next) {navHistory.current.push(next);setPage(next);setQuery('');}
  function goBack(){if(navHistory.current.length>1){navHistory.current.pop();setPage(navHistory.current.at(-1));}}
  const updateSettings = useCallback(patch => change(s=>({...s,settings:{...s.settings,...patch}})),[]);
  const liveVolume=useCallback(value=>{if(audio.current)audio.current.volume=value;youtube.current?.setVolume?.(value*100);},[]);
  const commitVolume=useCallback(value=>{if(stateRef.current.settings.volume!==value)updateSettings({volume:value});},[updateSettings]);
  const requestedPlaylist=state.importRequests?.find(r=>r.id==='astronomial-favorites');
  useRequestedPlaylistImport({request:requestedPlaylist,bridge:importBridge,enabled:ready&&online&&!state.settings.offlineOnly&&provider==='youtube',onChange:change});

  useEffect(()=>{
    const client=createRecommendationClient();recommendationClient.current=client;
    return()=>{recommendationClient.current=null;client.close();};
  },[]);
  useEffect(()=>{
    let alive=true;
    Promise.all([bridge.load(),bridge.downloads()]).then(([saved,files])=> {
      if(!alive)return;
      let initial=initialState();
      if(saved?.version===1) initial={...initial,...saved,settings:{...initial.settings,...saved.settings,...upgradeWaveSettings(saved.settings)}};
      for(const [id,file] of Object.entries(files)) initial.tracks[id]=file.track;
      if(bridge.desktop){initial=ensureRequestedPlaylist(initial);initial.importRequests=initial.importRequests.map(r=>r.status==='loading'?{...r,status:'pending'}:r);}
      if(pendingCloudSync.current){const {state:remote,base}=pendingCloudSync.current;initial=mergeDesktop(remote,base||{},initial);pendingCloudSync.current=null;}
      readyRef.current=true;stateRef.current=initial;setState(initial);setDownloads(files);setReady(true);
      if(!initial.onboarded)setModal('onboarding');
    }).catch(e=>{if(alive){notify('Не удалось прочитать библиотеку: '+e.message);setReady(true);}});
    const on=()=>setOnline(true),off=()=>setOnline(false);window.addEventListener('online',on);window.addEventListener('offline',off);
    const unsub=bridge.onProgress(p=>setProgress(old=>({...old,[p.id]:p})));
    return ()=>{alive=false;unsub();window.removeEventListener('online',on);window.removeEventListener('offline',off);};
  },[]);
  useEffect(()=>bridge.onSync?.(({state:remote,base})=>{if(!readyRef.current){pendingCloudSync.current={state:remote,base};return;}change(local=>mergeDesktop(remote,base||{},local));notify('Библиотека синхронизирована.');}),[]);
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
    const controls=()=>[...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')];
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
  const lastFeedback=state.events.findLast(e=>e.type==='listen'||e.type==='skip');
  const tasteSeed=JSON.stringify([state.likes,state.dislikes,state.playlists.map(p=>p.trackIds),lastFeedback&&[lastFeedback.at,lastFeedback.trackId,lastFeedback.type]]);
  const retrievalKey=JSON.stringify(['genres','excludedGenres','genreMode','mood','energy','vocals','preferredArtists','blockedArtists','playlistSource','seedPlaylistIds','languagePreference','explorationStyle'].map(k=>state.settings[k]));
  useEffect(()=>{if(!ready||!state.onboarded||!online||state.settings.offlineOnly)return;const timer=setTimeout(()=>refresh(),1500);return()=>clearTimeout(timer);},[tasteSeed,retrievalKey]);
  useEffect(()=>{if(audio.current)audio.current.volume=state.settings.volume;},[state.settings.volume]);
  function measureListening(seeking=false){
    const yt=currentRef.current?.source==='youtube';
    const active=yt?youtube.current?.getPlayerState?.()===1:audio.current&&!audio.current.paused&&!audio.current.seeking&&audio.current.readyState>=3;
    return session.current.clock.sample(performance.now(),Boolean(active),seeking);
  }
  useEffect(()=>{const timer=setInterval(()=>measureListening(),500);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    if(!current)return;
    if('mediaSession' in navigator){navigator.mediaSession.metadata=new MediaMetadata({title:current.title,artist:current.artist,album:'Forma',artwork:current.artwork?[{src:current.artwork}]:[]});}
  },[current]);
  useEffect(()=>{
    if(!('mediaSession' in navigator))return;
    navigator.mediaSession.setActionHandler('play',()=>actions.current.resumePlayback());
    navigator.mediaSession.setActionHandler('pause',()=>actions.current.pausePlayback());
    navigator.mediaSession.setActionHandler('nexttrack',()=>actions.current.nextTrack('skip'));
    navigator.mediaSession.setActionHandler('previoustrack',()=>actions.current.previousTrack());
    return ()=>{for(const action of ['play','pause','nexttrack','previoustrack'])navigator.mediaSession.setActionHandler(action,null);};
  },[downloads,repeat]);
  useEffect(()=>{
    const key=e=>{if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable||modal)return;if(e.code==='Space'){e.preventDefault();actions.current.togglePlayback();}if(e.ctrlKey&&e.code==='ArrowRight'){e.preventDefault();actions.current.nextTrack('skip');}if(e.ctrlKey&&e.code==='ArrowLeft'){e.preventDefault();actions.current.previousTrack();}};
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[current,modal]);

  async function refresh() {
    if(!navigator.onLine||stateRef.current.settings.offlineOnly)return;
    const snapshot=stateRef.current;const signature=JSON.stringify([snapshot.settings.provider,['genres','excludedGenres','genreMode','mood','energy','vocals','preferredArtists','blockedArtists','playlistSource','seedPlaylistIds','languagePreference','explorationStyle'].map(k=>snapshot.settings[k]),snapshot.likes,snapshot.playlists.map(p=>p.trackIds),snapshot.events.findLast(e=>e.type==='listen'||e.type==='skip'),catalogContext.current]);
    if(refreshBusy.current){refreshPending.current=refreshPending.current||signature!==refreshSignature.current;return;}
    refreshSignature.current=signature;refreshBusy.current=true;setLoading(true);setNetworkError('');
    try {const s=stateRef.current;const candidates=s.settings.provider==='audius'?await collectCandidates(playlistSeedState(s,catalogContext.current),bridge.request):await collectYouTubeCandidates(s,(route,params)=>bridge.catalogRequest(route,params,'youtube'),{context:catalogContext.current,round:refreshCount.current,onBatch:batch=>change(s=>mergeTracks(s,batch))});change(s=>mergeTracks(s,candidates));refreshCount.current++;}
    catch(e){setNetworkError(e.message);}
    finally{setLoading(false);refreshBusy.current=false;if(refreshPending.current){refreshPending.current=false;refresh();}}
  }
  const allTracks=useMemo(()=>Object.values(state.tracks),[state.tracks]);
  const candidates=useMemo(()=>state.settings.offlineOnly||!online?allTracks.filter(t=>downloads[t.id]):allTracks.filter(t=>t.source==='local'||(t.source||'audius')===provider),[allTracks,state.settings.offlineOnly,online,downloads,provider]);
  const waveKey=JSON.stringify(waveSettings(state.settings));
  const recommendationState=useMemo(()=>({...state,settings:waveSettings(state.settings)}),[state.tracks,state.likes,state.playlists,state.events,state.hidden,state.dislikes,waveKey]);
  const {recommendations,mixes,taste}=analysis;
  const soundQueue=useMemo(()=>[...queue,...recommendations.slice(0,3).map(r=>r.track)],[queue,recommendations]);
  useSoundAnalysis({bridge,ready,stateRef,current,buffering,change,queue:soundQueue,enabled:state.settings.audioAnalysis!==false});
  useEffect(()=>{
    let alive=true;
    recommendationClient.current?.request({kind:'analyze',candidates,state:recommendationState}).then(result=>{if(alive&&result)setAnalysis(result);}).catch(e=>{if(alive)notify(e.message);});
    return()=>{alive=false;};
  },[candidates,recommendationState]);
  useEffect(()=>{
    if(!waveRef.current)return;let alive=true;
    const ctx=contextRef.current,token=selectionToken.current;
    recommendationClient.current?.request({kind:'rank',lane:'preview',candidates,state:stateRef.current,options:{limit:30,context:ctx,currentTrackId:currentRef.current?.id,exclude:currentRef.current?[currentRef.current.id]:[]}}).then(ranked=>{
      if(alive&&ranked&&waveRef.current&&contextRef.current===ctx&&selectionToken.current===token)setPlaybackQueue(ranked.map(r=>r.track));
    }).catch(e=>{if(alive)notify(e.message);});return()=>{alive=false;};
  },[waveKey,candidates]);

  function finalize(reason) {
    const t=currentRef.current,seconds=measureListening();
    // Explicit feedback already records the rejection; never also log a listen.
    if(reason==='dislike'){session.current.recorded=false;return;}
    if(!t||!session.current.recorded||seconds<1)return;
    const ratio=Math.min(1,seconds/((t.source==='youtube'?youtube.current?.getDuration?.():audio.current?.duration)||t.duration||Infinity));
    change(s=>recordEvent(s,t.id,reason==='skip'?'skip':'listen',{seconds,ratio,surface:session.current.surface||'manual',mood:session.current.context?.mood||'',...(session.current.recommendation?{recommendation:session.current.recommendation}:{})}));
    session.current.recorded=false;
  }
  function setPlaybackQueue(items) {queueRef.current=items;setQueue(items);}
  function setWaveMode(value){waveRef.current=value;setWave(value);}
  function recommendationFor(track){
    if(currentRef.current?.id===track.id&&session.current.recommendation)return session.current.recommendation;
    const mood=contextRef.current?.mood;
    const items=mood?(mixes.find(m=>m.context.mood===mood)?.items||[]):recommendations;
    return items.find(r=>r.track.id===track.id)?.exposure||null;
  }
  function sourcesFor(id){
    const hit=sourcesCache.current.get(id);if(hit&&Date.now()-hit.at<60000)return hit.promise;
    const promise=bridge.sources(id).catch(error=>{sourcesCache.current.delete(id);throw error;});
    sourcesCache.current.set(id,{at:Date.now(),promise});if(sourcesCache.current.size>40)sourcesCache.current.delete(sourcesCache.current.keys().next().value);return promise;
  }
  useEffect(()=>{sourcesCache.current.clear();},[downloads,state.settings.apiKey]);
  useEffect(()=>{const next=queue[0];if(next&&next.source!=='youtube')sourcesFor(next.id).catch(()=>{});},[queue]);
  async function playTrack(track,list=null,{asWave=false,reason='skip',history=true,playbackContext=null,recommendation=null}={}) {
    if(!track)return;
    if(!track.streamable){notify('Название сохранено из Яндекса. Подтверди доступную версию в переносе библиотеки.');return;}
    if((stateRef.current.settings.offlineOnly||!online)&&!downloads[track.id]){notify('Этот трек ещё не скачан. Выбери трек из раздела «Загрузки».');return;}
    selectionToken.current++;playingIntent.current=true;
    finalize(reason);
    if(history&&currentRef.current){playbackHistory.current.push(currentRef.current);if(playbackHistory.current.length>150)playbackHistory.current.shift();}
    if(list){const index=list.findIndex(t=>t.id===track.id);setPlaybackQueue(list.slice(index+1).filter(t=>t.streamable));setWaveMode(asWave);contextRef.current=playbackContext;catalogContext.current=asWave?playbackContext:null;}
    const token=++playToken.current;
    youtube.current?.pauseVideo?.();
    const el=audio.current;el.onerror=null;el.pause();el.removeAttribute('src');el.load();
    const exposure=recommendation?.exposure||recommendationFor(track);
    currentRef.current=track;setCurrent(track);setPlaybackId(token);setPlaying(false);setPosition(0);setDuration(track.duration);setBuffering(true);session.current={clock:new ListeningClock(),recorded:false,context:contextRef.current,surface:contextRef.current?.mood?'mood':waveRef.current?'pulse':list?'playlist':'manual',newArtist:recommendation?.newArtist===true||exposure?.features?.[5]===1,recommendation:exposure?structuredClone(exposure):null};
    if(track.source==='youtube'){setYoutubeMounted(true);return;}
    try{
      const sources=await sourcesFor(track.id);if(token!==playToken.current)return;
      const trySource=index=>{
        if(token!==playToken.current)return;
        if(index>=sources.length){playingIntent.current=false;session.current.recorded=false;setBuffering(false);setPlaying(false);el.onerror=null;notify('Не удалось воспроизвести трек. Он может быть недоступен в источнике музыки.');return;}
        el.onerror=()=>trySource(index+1);el.src=sources[index];
        if(!playingIntent.current){setBuffering(false);return;}
        el.play().catch(e=>{if(token===playToken.current&&e.name!=='AbortError'){playingIntent.current=false;setBuffering(false);if(e.name==='NotAllowedError')notify('Нажми кнопку воспроизведения, чтобы начать.');}});
      };trySource(0);
    }catch(e){if(token===playToken.current){playingIntent.current=false;setBuffering(false);notify(e.message);}}
  }
  function playablePool(){
    const s=stateRef.current;return Object.values(s.tracks).filter(t=>s.settings.offlineOnly||!navigator.onLine?Boolean(downloads[t.id]):t.source==='local'||(t.source||'audius')===s.settings.provider);
  }
  function playRecommendation(track,ctx=null){
    const items=ctx?.mood?(mixes.find(m=>m.context.mood===ctx.mood)?.items||[]):recommendations;
    const recommendation=items.find(r=>r.track.id===track.id);
    const previousToken=selectionToken.current;
    playTrack(track,[track],{asWave:true,playbackContext:ctx,recommendation});
    if(selectionToken.current===previousToken)return;
    const token=selectionToken.current;
    recommendationClient.current.request({kind:'rank',lane:'preview',candidates:playablePool(),state:stateRef.current,options:{limit:30,context:ctx,currentTrackId:track.id,exclude:[track.id]}}).then(ranked=>{
      if(token===selectionToken.current&&waveRef.current&&ranked)setPlaybackQueue(ranked.map(r=>r.track));
    }).catch(e=>{if(token===selectionToken.current)notify(e.message);});
  }
  async function startWave(ctx=null,mayRefresh=true) {
    const token=++selectionToken.current;
    if(ctx?.playlistId&&!playlistPulseContext(stateRef.current,ctx.playlistId)){notify('В плейлисте пока нет треков для Пульса.');return;}
    try{
      const ranked=await recommendationClient.current.request({kind:'rank',lane:'playback',candidates:playablePool(),state:stateRef.current,options:{limit:30,context:ctx,currentTrackId:currentRef.current?.id,exclude:currentRef.current?[currentRef.current.id]:[]}});
      if(token!==selectionToken.current||!ranked)return;
      if(!ranked.length){
        if(mayRefresh&&ctx?.playlistId&&navigator.onLine&&!stateRef.current.settings.offlineOnly){catalogContext.current=ctx;await refresh();if(token===selectionToken.current)return startWave(ctx,false);}
        else notify(loading?'Подожди, загружаем музыкальный каталог.':'Пока нет новых треков для Пульса. Обнови каталог или выбери музыку в поиске.');
        return;
      }
      contextRef.current=ctx;catalogContext.current=ctx;setWaveMode(true);setPlaybackQueue(ranked.slice(1).map(r=>r.track));playTrack(ranked[0].track,null,{asWave:true,recommendation:ranked[0]});
      if(ctx?.playlistId)refresh();
    }catch(e){if(token===selectionToken.current)notify(e.message);}
  }
  function startPlaylistPulse(playlist){const ctx=playlistPulseContext(stateRef.current,playlist.id);if(ctx)startWave(ctx);else notify('Добавь треки в плейлист, чтобы задать направление Пульса.');}
  async function nextTrack(reason='skip') {
    finalize(reason);
    if(reason==='listen'&&repeatRef.current&&currentRef.current){playTrack(currentRef.current,null,{reason:'listen',history:false});return;}
    if(waveRef.current){
      const token=++selectionToken.current,ctx=contextRef.current;audio.current.pause();youtube.current?.pauseVideo?.();setPlaying(false);setBuffering(true);
      try{
        const ranked=await recommendationClient.current.request({kind:'rank',lane:'playback',candidates:playablePool(),state:stateRef.current,options:{limit:30,context:ctx,currentTrackId:currentRef.current?.id,exclude:currentRef.current?[currentRef.current.id]:[]}});
        if(token!==selectionToken.current||!ranked)return;
        if(ranked.length){setPlaybackQueue(ranked.slice(1).map(r=>r.track));playTrack(ranked[0].track,null,{reason:'listen',recommendation:ranked[0]});if(ranked.length<6&&!refreshBusy.current)refresh();return;}
        playingIntent.current=false;audio.current.pause();youtube.current?.pauseVideo?.();setPlaying(false);setBuffering(false);setPlaybackQueue([]);notify('Новые треки закончились. Обнови каталог или запусти плейлист.');
      }catch(e){if(token===selectionToken.current){setBuffering(false);notify(e.message);}}
      return;
    }
    const items=[...queueRef.current];
    const index=shuffle?Math.floor(Math.random()*items.length):0;
    const [next]=items.splice(index,1);setPlaybackQueue(items);
    if(next)playTrack(next,null,{reason:'listen'});else{playingIntent.current=false;audio.current.pause();youtube.current?.pauseVideo?.();setPlaying(false);setBuffering(false);}
  }
  function seekTo(value){measureListening();measureListening(true);if(currentRef.current?.source==='youtube')youtube.current?.seekTo?.(value,true);else audio.current.currentTime=value;setPosition(value);}
  function previousTrack(){if(!currentRef.current)return;const time=currentRef.current.source==='youtube'?youtube.current?.getCurrentTime?.()||0:audio.current.currentTime;if(time>3){seekTo(0);return;}const prev=playbackHistory.current.pop();if(prev){setWaveMode(false);setPlaybackQueue([currentRef.current,...queueRef.current]);playTrack(prev,null,{reason:'listen',history:false});}}
  function pausePlayback(){selectionToken.current++;playingIntent.current=false;audio.current?.pause();youtube.current?.pauseVideo?.();setPlaying(false);setBuffering(false);}
  function resumePlayback(){if(!currentRef.current){startWave();return;}playingIntent.current=true;if(currentRef.current.source==='youtube')youtube.current?.playVideo?.();else if(audio.current.getAttribute('src'))audio.current.play().catch(()=>notify('Не удалось начать воспроизведение.'));else playTrack(currentRef.current,null,{history:false});}
  function togglePlayback(){
    selectionToken.current++;
    if(!currentRef.current){startWave();return;}
    if(currentRef.current.source==='youtube'){
      if(youtube.current?.wantsPlayback?.())pausePlayback();else resumePlayback();return;
    }
    if(playingIntent.current){playingIntent.current=false;audio.current.pause();setPlaying(false);setBuffering(false);}
    else{playingIntent.current=true;if(audio.current.getAttribute('src'))audio.current.play().catch(()=>notify('Не удалось начать воспроизведение.'));else playTrack(currentRef.current,null,{history:false});}
  }
  actions.current={nextTrack,previousTrack,togglePlayback,pausePlayback,resumePlayback,playTrack,playRecommendation,toggleLike,toggleDislike,downloadTrack,cancelDownload:id=>bridge.cancelDownload?.(id),showTrackMenu:(track,table)=>{setPlaylistTarget(track);setModal({type:'track',playlist:table.playlist,downloaded:table.downloaded});}};

  async function importLocal(kind){setImportingLocal(true);try{const result=await bridge.importLocal(kind);setDownloads(result.files);change(s=>mergeTracks(s,Object.values(result.files).map(f=>f.track)));notify(`Добавлено файлов: ${result.added}.${result.errors.length?' Не удалось прочитать: '+result.errors.length+'. '+result.errors[0].file+': '+result.errors[0].error:''}`);}catch(e){notify(e.message);}finally{setImportingLocal(false);}}
  function onPlaying(){measureListening();setPlaying(true);setBuffering(false);if(!session.current.recorded&&currentRef.current){session.current.recorded=true;change(s=>recordEvent(s,currentRef.current.id,'play',{surface:session.current.surface,mood:session.current.context?.mood||'',newArtist:session.current.newArtist===true,...(session.current.recommendation?{recommendation:session.current.recommendation}:{})}));}}
  function toggleDislike(t){
    const removing=(stateRef.current.dislikes||[]).includes(t.id),isCurrent=currentRef.current?.id===t.id,exposure=recommendationFor(t);
    change(s=>{const next={...s,dislikes:removing?(s.dislikes||[]).filter(id=>id!==t.id):[...new Set([...(s.dislikes||[]),t.id])],likes:s.likes.filter(id=>id!==t.id),events:s.events.filter(e=>!(e.trackId===t.id&&e.type==='dislike'))};return removing?next:recordEvent(next,t.id,'dislike',{...(exposure?{recommendation:exposure}:{}),surface:isCurrent?session.current.surface||'manual':'library'});});
    notify(removing?'Дизлайк снят':'Будем предлагать реже');
    if(!removing&&isCurrent)nextTrack('dislike');
  }
  function toggleLike(t){const exposure=recommendationFor(t);change(s=>{const liked=s.likes.includes(t.id),next={...s,dislikes:(s.dislikes||[]).filter(id=>id!==t.id),events:s.events.filter(e=>!(e.trackId===t.id&&e.type==='dislike')),likes:liked?s.likes.filter(id=>id!==t.id):[...s.likes,t.id]};return liked?next:recordEvent(next,t.id,'like',{...(exposure?{recommendation:exposure}:{}),surface:currentRef.current?.id===t.id?session.current.surface:'library'});});}
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
  function createPlaylist(e){e.preventDefault();const name=playlistName.trim();if(!name)return;const id=crypto.randomUUID(),exposure=playlistTarget?recommendationFor(playlistTarget):null;change(s=>{const next={...s,playlists:[...s.playlists,{id,name,trackIds:playlistTarget?[playlistTarget.id]:[],createdAt:Date.now()}]};return playlistTarget?recordEvent(next,playlistTarget.id,'playlist-add',{...(exposure?{recommendation:exposure}:{}),surface:'playlist'}):next;});setPlaylistName('');setModal(null);setPlaylistTarget(null);navigate(`playlist:${id}`);notify('Плейлист создан.');}
  function addToPlaylist(id){const exposure=recommendationFor(playlistTarget);change(s=>{const exists=s.playlists.find(p=>p.id===id)?.trackIds.includes(playlistTarget.id),next={...s,playlists:s.playlists.map(p=>p.id===id?{...p,trackIds:[...new Set([...p.trackIds,playlistTarget.id])]}:p)};return exists?next:recordEvent(next,playlistTarget.id,'playlist-add',{...(exposure?{recommendation:exposure}:{}),surface:'playlist'});});setModal(null);notify('Трек добавлен. Пульс учтёт твой выбор.');}
  function openAdd(t){setPlaylistTarget(t);setPlaylistName('');setModal('add');}
  function playList(tracks){const playable=tracks.filter(t=>t.streamable);if(!playable.length)return;playTrack(playable[0],playable);}

  function rows(tracks,options={}){return <TrackTable tracks={tracks} {...options} current={current} playing={playing} likes={state.likes} downloads={downloads} progress={progress} actions={actions} Cover={Cover} IconButton={IconButton}/>;}


  const selectedPlaylist=state.playlists.find(p=>page===`playlist:${p.id}`);
  const selectedMix=mixes.find(m=>page===`mix:${m.id}`);
  let collectionTracks=[],collectionTitle='',collectionSubtitle='',collectionIcon=Heart;
  if(page==='liked'){collectionTracks=state.likes.map(id=>state.tracks[id]).filter(Boolean);collectionTitle='Любимые треки';collectionSubtitle='';}
  if(page==='downloads'){collectionTracks=Object.values(downloads).map(d=>d.track);collectionTitle='Скачанное';collectionSubtitle='Доступно без интернета';collectionIcon=ArrowDownToLine;}
  if(selectedPlaylist){collectionTracks=selectedPlaylist.trackIds.map(id=>state.tracks[id]).filter(Boolean);collectionTitle=selectedPlaylist.name;collectionSubtitle='Плейлист';collectionIcon=ListMusic;}
  if(selectedMix){collectionTracks=selectedMix.items.map(r=>r.track);collectionTitle=selectedMix.title;collectionSubtitle=selectedMix.subtitle;collectionIcon=Disc3;}
  const CollectionIcon=collectionIcon;

  return <div className="app-shell" style={appearanceVariables(state.settings)} data-palette={state.settings.palette} data-space-motion={state.settings.spaceMotion!==false} data-visuals-active={visualsActive}>
    <SpaceBackdrop/>
    <audio ref={audio} onPlaying={onPlaying} onPause={()=>{measureListening();if(currentRef.current?.source!=='youtube')setPlaying(false);}} onWaiting={()=>{measureListening();if(currentRef.current?.source!=='youtube')setBuffering(true);}} onCanPlay={()=>{if(currentRef.current?.source!=='youtube')setBuffering(false);}} onTimeUpdate={()=>{if(currentRef.current?.source!=='youtube')setPosition(audio.current.currentTime);}} onDurationChange={()=>{if(currentRef.current?.source!=='youtube'&&Number.isFinite(audio.current.duration))setDuration(audio.current.duration);}} onEnded={()=>actions.current.nextTrack('listen')}/>
    <aside className="sidebar"><div className="brand"><AudioLines size={27} strokeWidth={2.2}/><span>forma<span className="brand-dot">.</span></span></div>
      <div className="sidebar-label">Музыка</div><nav>
        {[['home',Home,'Главная'],['search',Search,'Поиск'],['wave-settings',SlidersHorizontal,'Настройка Пульса'],['liked',Heart,'Любимые треки'],['downloads',ArrowDownToLine,'Скачанное'],['import',ArrowRightLeft,'Перенос библиотеки']].map(([id,Icon,label])=><button key={id} className={`nav-item ${page===id?'selected':''}`} aria-expanded={id==='wave-settings'?modal==='pulse-settings':undefined} onClick={()=>id==='wave-settings'?setModal('pulse-settings'):navigate(id)}><Icon size={19} strokeWidth={1.7}/><span>{label}</span>{id==='liked'&&state.likes.length>0&&<small>{state.likes.length}</small>}</button>)}
      </nav>
      <div className="playlist-heading"><span className="sidebar-label">Плейлисты</span><IconButton title="Создать плейлист" onClick={()=>{setPlaylistTarget(null);setPlaylistName('');setModal('create');}}><Plus size={17}/></IconButton></div>
      <div className="sidebar-playlists">{state.playlists.map(p=><button key={p.id} className={`playlist-link ${selectedPlaylist?.id===p.id?'selected':''}`} onClick={()=>navigate(`playlist:${p.id}`)}><span className="playlist-icon"><ListMusic size={17}/></span><span>{p.name}<small>{p.trackIds.length} треков</small></span></button>)}{!state.playlists.length&&<button className="create-playlist-hint" onClick={()=>{setPlaylistTarget(null);setModal('create');}}>Новый плейлист<Plus size={14}/></button>}</div>
      <div className="sidebar-bottom"><button className={`nav-item ${page==='settings'?'selected':''}`} onClick={()=>navigate('settings')}><Settings2 size={18}/><span>Настройки</span></button></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="topbar-left"><IconButton title="Назад" disabled={navHistory.current.length<2} onClick={goBack}><ArrowLeft size={18}/></IconButton><span>{page==='home'?'Для тебя':page==='search'?'Поиск':page==='settings'?'Настройки':page==='wave-settings'?'Твой Пульс':'Твоя коллекция'}</span></div><form className="search-field" onSubmit={searchTracks}><Search size={17}/><input aria-label="Поиск треков и исполнителей" placeholder="Трек или исполнитель" value={query} onChange={e=>typeSearch(e.target.value)}/><kbd>↵</kbd></form><div className="topbar-right"><span className="online-badge">{online&&!state.settings.offlineOnly?<><span className="status-dot"/>На связи</>:<><WifiOff size={13}/>Офлайн</>}</span><button className="profile-avatar" title="Мой музыкальный профиль" onClick={()=>navigate('settings')}>F</button></div>{bridge.desktop&&<div className="window-controls"><button aria-label="Свернуть" onClick={()=>bridge.windowControl('minimize')}><Minus size={14}/></button><button aria-label="Развернуть" onClick={()=>bridge.windowControl('maximize')}><Square size={11}/></button><button className="window-close" aria-label="Закрыть" onClick={()=>bridge.windowControl('close')}><X size={15}/></button></div>}</header>
    <div className={`main-stage ${current?.source==='youtube'?'with-video':''}`}><main className="content" key={page}>
      {(!online||state.settings.offlineOnly)&&<div className="offline-banner"><WifiOff size={16}/><span>Слушаем без интернета. Пульс подбирает музыку из скачанных треков.</span></div>}
      {networkError&&<div className="network-banner"><span>{networkError}</span><button onClick={refresh} disabled={loading}>Повторить <RefreshCw size={13}/></button></div>}
      {page==='home'&&<>
        {requestedPlaylist&&<RequestedPlaylistBanner request={requestedPlaylist} enabled={online&&!state.settings.offlineOnly&&provider==='youtube'} onChange={change} onReview={r=>{setImportResume(r);navigate('import');}} onOpen={id=>navigate(`playlist:${id}`)}/>}
        <section className={`pulse-stage ${wave&&playing?'wave-playing':''}`} aria-labelledby="pulse-title">
          <PulseGalaxy/>
          <div className="pulse-controls"><h1 id="pulse-title">Пульс</h1>
            <button className="pulse-play" onClick={()=>wave&&!contextRef.current?.playlistId&&current?togglePlayback():startWave()}>{wave&&buffering?<LoaderCircle size={23} className="spin"/>:wave&&playing?<Pause size={23} fill="currentColor"/>:<Play size={23} fill="currentColor"/>}{wave&&playing?'Приостановить':'Слушать Пульс'}</button>
            <button className="pulse-customize" aria-label="Настроить Пульс" onClick={()=>setModal('pulse-settings')}><SlidersHorizontal size={17}/>Настроить</button>
          </div>
        </section>
        <div className="section-heading"><h2>По настроению</h2></div>
        <div className="mix-grid">{mixes.map((m,i)=><button className="mix-card" key={m.id} onClick={()=>navigate(`mix:${m.id}`)}><div className={`mix-art ${m.className}`}><div className={`mix-shape shape-${i}`}><i/><i/><i/><i/></div><h3>{m.title}</h3><span className="mix-play"><Play size={19} fill="currentColor"/></span></div><p>{m.items.length?m.items.slice(0,2).map(r=>r.track.artist).join(' · '):'Ищем треки…'}</p><span className="mix-count">{m.items.length} треков</span></button>)}</div>
        <div className="home-lower"><section className="for-you"><div className="section-heading"><div><h2>Тебе может понравиться</h2></div><IconButton title="Обновить рекомендации" onClick={refresh} disabled={loading||!online||state.settings.offlineOnly}><RefreshCw size={17} className={loading?'spin':''}/></IconButton></div>{recommendations.length?rows(recommendations.slice(0,6).map(r=>r.track),{adaptive:true,reasons:Object.fromEntries(recommendations.map(r=>[r.track.id,r.reason]))}):<Empty icon={loading?LoaderCircle:Radio} title={loading?'Ищем музыку…':'Пока нет рекомендаций'} text={loading?'':'Выбери жанры и обнови каталог.'} action={!loading&&<button className="button button-outline" onClick={refresh} disabled={!online||state.settings.offlineOnly}>Загрузить музыку <RefreshCw size={15}/></button>}/>}</section><aside className="taste-card"><div className="taste-heading"><h3>Твой вкус</h3><AudioLines size={20}/></div><div className="taste-bars">{taste.length?taste.map(([genre,value],i)=><div key={genre}><span>{genre.slice(6)}</span><div><i style={{width:`${Math.max(12,100*value/taste[0][1])}%`,opacity:1-i*0.2}}/></div></div>):<div className="taste-placeholder">Добавь любимые треки</div>}</div><button className="text-link" onClick={()=>navigate('settings')}>Твой профиль <ArrowUpRight size={15}/></button></aside></div>
      </>}
      {page==='search'&&<SearchPage query={query} setQuery={typeSearch} request={catalogRequest} tracks={candidates} offline={!online||state.settings.offlineOnly} provider={provider} renderTracks={rows} onTracks={ts=>{if(ts.length)change(s=>mergeTracks(s,ts));}} onPlay={playList}/>}
      {page==='import'&&<LibraryImportPage resume={importResume} bridge={importBridge} provider={provider} state={state} onChange={change} onNavigate={navigate} onNotify={notify} onPreview={t=>{change(s=>mergeTracks(s,[t]));playTrack(t,[t]);}}/>}
      {(page==='liked'||page==='downloads'||selectedPlaylist||selectedMix)&&<><div className="collection-hero"><div className={`collection-art ${selectedMix?.className||''}`}><CollectionIcon size={70} strokeWidth={1}/></div><div><span className="eyebrow">{selectedMix?'ПЕРСОНАЛЬНАЯ ПОДБОРКА':page==='downloads'?'ОФЛАЙН-БИБЛИОТЕКА':'ТВОЯ КОЛЛЕКЦИЯ'}</span><h1>{collectionTitle}</h1><p>{collectionSubtitle}</p><span className="collection-meta">{collectionTracks.length} треков <span>·</span> {Math.round(collectionTracks.reduce((sum,t)=>sum+t.duration,0)/60)} мин{page==='downloads'&&<> <span>·</span> {(Object.values(downloads).reduce((s,d)=>s+d.bytes,0)/1024**2).toFixed(1)} МБ</>}</span></div></div><div className="collection-controls"><button className="big-play" aria-label="Слушать подборку" disabled={!collectionTracks.length} onClick={()=>selectedMix?startWave(selectedMix.context):playList(collectionTracks)}><Play size={23} fill="currentColor"/></button><span>{selectedMix?'Пульс по настроению':'Слушать всё'}</span>{page==='downloads'&&<><button className="button button-primary" disabled={importingLocal} onClick={()=>importLocal('files')}><Plus size={17}/>{importingLocal?'Добавляем файлы…':'Добавить файлы'}</button><button className="button button-outline" disabled={importingLocal} onClick={()=>importLocal('folder')}><FolderOpen size={17}/>Добавить папку</button><button className="button button-outline" onClick={()=>bridge.openFolder()}><FolderOpen size={16}/>Открыть папку</button></>}{selectedPlaylist&&<button className="button button-outline playlist-pulse" disabled={!collectionTracks.length} onClick={()=>startPlaylistPulse(selectedPlaylist)}><Radio size={17}/>Пульс от плейлиста</button>}{selectedPlaylist&&<div className="collection-extra"><IconButton title="Переименовать плейлист" onClick={()=>{setPlaylistName(selectedPlaylist.name);setModal('rename');}}><Settings2 size={18}/></IconButton><IconButton title="Удалить плейлист" onClick={()=>setModal('delete-playlist')}><Trash2 size={18}/></IconButton></div>}</div>{collectionTracks.length?rows(collectionTracks,{playlist:selectedPlaylist?.id,downloaded:page==='downloads',adaptive:Boolean(selectedMix),playbackContext:selectedMix?.context,reasons:selectedMix?Object.fromEntries(selectedMix.items.map(r=>[r.track.id,r.reason])):{}}):<Empty icon={CollectionIcon} title={selectedMix?'Ищем музыку под это настроение':page==='downloads'?'Музыка, которая всегда рядом':'Здесь будут твои треки'} text={selectedMix?'Добавим треки, когда найдём подходящее звучание. Любимая песня не попадёт сюда только ради заполнения подборки.':page==='downloads'?'Добавь MP3, FLAC, M4A, OGG или WAV. Forma скопирует файлы в свою библиотеку, прочитает теги и учтёт музыку в рекомендациях.':'Сохраняй треки сердечком или добавляй через меню в плейлист — это помогает Пульсу лучше понимать тебя.'} action={<button className="button button-outline" onClick={()=>navigate('search')}>Найти музыку <Search size={15}/></button>}/>}</>}
      {page==='settings'&&<><div className="page-intro"><div><h1>Настройки</h1></div></div><AppearanceSettings settings={state.settings} onChange={updateSettings}/><SyncSettings bridge={bridge}/><section className="settings-card" style={{marginBottom:24}}><h2>Анализ звучания</h2><div className="setting-row"><div><strong>Фоновый анализ аудио</strong><p>Для поиска похожей музыки. Дополнительный трафик: до 6 МБ на трек, до 12 треков в час.</p></div><button role="switch" aria-label="Фоновый анализ аудио" aria-checked={state.settings.audioAnalysis!==false} className={`toggle ${state.settings.audioAnalysis!==false?'on':''}`} onClick={()=>updateSettings({audioAnalysis:state.settings.audioAnalysis===false})}><i/></button></div><p className="settings-note">Проанализировано: {Object.values(state.tracks).filter(t=>t.soundProfile).length}. Аудио удаляется после анализа. Синхронизируются только признаки звучания.</p></section><div className="settings-grid"><section className="settings-card"><h2>Персональный Пульс</h2><div className="wave-settings-summary"><span>{state.settings.genres.length?state.settings.genres.join(' · '):'Любые направления'}</span><span>Открытия: {Math.round(state.settings.discovery*100)}%</span><span>Интервал повторов: {state.settings.repeatCooldown} ч</span></div><button className="button button-primary" onClick={()=>setModal('pulse-settings')}><SlidersHorizontal size={17}/>Настроить рекомендации</button></section><section className="settings-card"><h2>Твой профиль</h2><div className="profile-stats"><div><strong>{state.likes.length}</strong><span>любимых треков</span></div><div><strong>{state.playlists.length}</strong><span>плейлистов</span></div><div><strong>{state.events.filter(e=>e.type==='listen'||e.type==='skip').length}</strong><span>прослушиваний</span></div></div><div className="signal-explanation"><p><Heart size={16}/><span><b>Сохранения и плейлисты</b> уточняют твой вкус.</span></p><p><AudioLines size={16}/><span><b>Дослушивания</b> усиливают интерес.</span></p><p><SkipForward size={16}/><span><b>Ранние пропуски</b> уменьшают похожие рекомендации.</span></p><p><Shuffle size={16}/><span><b>Разнообразие</b> даёт шанс новым артистам.</span></p></div><button className="button button-outline" onClick={()=>bridge.exportProfile().then(ok=>ok&&notify('Библиотека экспортирована.')).catch(e=>notify(e.message))}>Экспортировать библиотеку <ArrowUpRight size={15}/></button></section><section className="settings-card"><h2>Без интернета</h2><div className="setting-row"><div><strong>Только скачанная музыка</strong><p>Пульс и поиск используют локальные треки</p></div><button role="switch" aria-label="Только скачанная музыка" aria-checked={state.settings.offlineOnly} className={`toggle ${state.settings.offlineOnly?'on':''}`} onClick={()=>updateSettings({offlineOnly:!state.settings.offlineOnly})}><i/></button></div><p className="settings-note">Скачано {Object.keys(downloads).length} треков. YouTube доступен онлайн. Лимит загрузок — 10 ГБ.</p><button className="text-link" onClick={()=>navigate('downloads')}>Управлять скачанным <ChevronRight size={15}/></button></section><section className="settings-card"><h2>Источник онлайн-музыки</h2><div className="mode-buttons">{[['youtube','YouTube'],['audius','Audius']].map(([id,label])=><button key={id} className={provider===id?'selected':''} onClick={()=>updateSettings({provider:id})}>{label}</button>)}</div><p className="settings-note">Для YouTube нужен интернет и разрешённое встроенное воспроизведение.</p><h3>Audius</h3><p>Ключ нужен, если его требует сервер Audius.</p><label className="field-label" htmlFor="api-key">API-ключ (необязательно)</label><input id="api-key" className="text-input" type="password" autoComplete="off" value={state.settings.apiKey||''} onChange={e=>updateSettings({apiKey:e.target.value})} placeholder="Твой ключ Audius"/><p className="settings-note">Ключ хранится на устройстве.</p><button className="text-link" onClick={()=>setModal('reset-history')}>Сбросить историю прослушиваний <RefreshCw size={14}/></button>{state.hidden.length>0&&<button className="text-link" onClick={()=>{change(s=>({...s,hidden:[],events:s.events.filter(e=>e.type!=='hide')}));notify('Скрытые треки снова могут появляться в Пульсе.');}}>Вернуть скрытые треки ({state.hidden.length}) <Plus size={14}/></button>}</section></div></>}
    </main>{youtubeMounted&&<YouTubePlayer playbackId={playbackId} track={current?.source==='youtube'?current:null} onReady={p=>{youtube.current=p;}} onPlaying={onPlaying} onPaused={()=>{measureListening();setPlaying(false);setBuffering(false);}} onBuffering={()=>{measureListening();setBuffering(true);}} onEnded={()=>actions.current.nextTrack('listen')} onTime={(time,total)=>{setPosition(time);if(total)setDuration(total);}} onError={message=>{session.current.recorded=false;setPlaying(false);setBuffering(false);notify(message);}} onOpen={id=>bridge.openYouTube(id)} volume={state.settings.volume}/>}</div></div>
    {queueOpen&&<aside className="queue-panel"><div className="queue-heading"><h3>Далее</h3><IconButton title="Закрыть очередь" onClick={()=>setQueueOpen(false)}><X size={18}/></IconButton></div><span className="eyebrow">{wave?'ТВОЙ ПУЛЬС':'ОЧЕРЕДЬ'}</span><p>{wave?contextRef.current?.playlistId?`По мотивам «${contextRef.current.playlistName}». Прослушивания и пропуски уточняют подборку.`:'Подобрано для тебя':'Музыка, которую ты выбрал.'}</p>{queue.length?queue.slice(0,20).map(t=><button className="queue-track" key={t.id} onClick={()=>{setPlaybackQueue(queueRef.current.filter(x=>x.id!==t.id));playTrack(t);}}><Cover track={t}/><span><strong>{t.title}</strong><small>{t.artist}</small></span><Play size={14}/></button>):<Empty title="Очередь пока пуста" text="Запусти Пульс или свой плейлист."/>}</aside>}
    <footer className="player"><div className="now-playing"><Cover track={current} className="player-cover"/><div><strong>{current?.title||'Ничего не играет'}</strong><span>{current?.artist||'Выбери трек'}</span></div>{current&&<IconButton title="Нравится текущий трек" active={state.likes.includes(current.id)} onClick={()=>toggleLike(current)}><Heart size={18} fill={state.likes.includes(current.id)?'currentColor':'none'}/></IconButton>}{current&&<IconButton title={(state.dislikes||[]).includes(current.id)?'Снять дизлайк':'Не нравится'} active={(state.dislikes||[]).includes(current.id)} onClick={()=>toggleDislike(current)}><ThumbsDown size={18}/></IconButton>}</div><div className="player-center"><div className="transport"><IconButton title="Перемешать" active={shuffle} disabled={wave} onClick={()=>setShuffle(!shuffle)}><Shuffle size={16}/></IconButton><IconButton title="Предыдущий трек" disabled={!current} onClick={previousTrack}><SkipBack size={18} fill="currentColor"/></IconButton><button className="play-button" aria-label={playing?'Пауза':'Воспроизвести'} onClick={togglePlayback}>{buffering?<LoaderCircle size={19} className="spin"/>:playing?<Pause size={19} fill="currentColor"/>:<Play size={19} fill="currentColor"/>}</button><IconButton title="Следующий трек" disabled={!current} onClick={()=>actions.current.nextTrack('skip')}><SkipForward size={18} fill="currentColor"/></IconButton><IconButton title="Повторить трек" active={repeat} onClick={()=>{repeatRef.current=!repeat;setRepeat(!repeat);}}><Repeat size={16}/></IconButton></div><div className="seek"><span>{fmt(position)}</span><input aria-label="Позиция воспроизведения" type="range" min="0" max={duration||1} value={Math.min(position,duration||1)} step="0.1" disabled={!current} style={{'--fill':`${duration?100*position/duration:0}%`}} onChange={e=>seekTo(Number(e.target.value))}/><span>{fmt(duration)}</span></div></div><div className="player-right">{wave&&<span className="wave-badge"><Radio size={12}/>{contextRef.current?.playlistId?'От плейлиста':'Пульс'}</span>}<IconButton title="Очередь воспроизведения" active={queueOpen} onClick={()=>setQueueOpen(!queueOpen)}><ListMusic size={19}/></IconButton><VolumeControl value={state.settings.volume} onLive={liveVolume} onCommit={commitVolume}/></div></footer>
    {toast&&<div className="toast" role="status"><span>{toast}</span><button aria-label="Закрыть уведомление" onClick={()=>setToast('')}><X size={15}/></button></div>}
    {modal&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&modal!=='onboarding')setModal(null);}}><section className={`modal ${modal==='onboarding'?'onboarding-modal':modal==='pulse-settings'?'pulse-settings-modal':''}`} role="dialog" aria-modal="true" aria-label={modal==='onboarding'?'Настройка музыкального вкуса':modal==='pulse-settings'?'Настройки Пульса':'Настройки и действия'}><IconButton className="modal-close" title={modal==='pulse-settings'?'Свернуть настройки Пульса':'Закрыть'} onClick={()=>{if(modal==='onboarding')change(s=>({...s,onboarded:true}));setModal(null);}}><X size={19}/></IconButton>
      {modal==='pulse-settings'&&<WaveSettingsPage settings={state.settings} playlists={state.playlists} onChange={updateSettings} recommendations={recommendations} renderTracks={rows} onRefresh={refresh} loading={loading} canRefresh={online&&!state.settings.offlineOnly} onPlay={()=>{startWave();setModal(null);}}/>}
      {modal==='onboarding'&&<><div className="modal-brand"><AudioLines size={28}/>forma.</div><span className="eyebrow">ДАВАЙ ПОЗНАКОМИМСЯ</span><h2>Как звучит твой мир?</h2><p>Выбери направления, которые любишь. Это начало — дальше Пульс будет учиться у тебя.</p><div className="genre-chips onboarding-genres">{GENRES.map(g=><button key={g} className={state.settings.genres.includes(g)?'selected':''} onClick={()=>updateSettings({genres:state.settings.genres.includes(g)?state.settings.genres.filter(x=>x!==g):[...state.settings.genres,g]})}>{g}{state.settings.genres.includes(g)&&<Check size={14}/>}</button>)}</div><button className="button button-primary full-width" onClick={()=>{change(s=>({...s,onboarded:true}));setModal(null);}}>Найти мой ритм <ArrowUpRight size={17}/></button><button className="onboarding-skip" onClick={()=>{change(s=>({...s,onboarded:true}));setModal(null);}}>Выберу позже</button><span className="privacy-caption">Без регистрации. Твой профиль — на твоём устройстве.</span></>}
      {(modal==='create'||modal==='rename')&&<form onSubmit={modal==='create'?createPlaylist:e=>{e.preventDefault();if(!playlistName.trim())return;change(s=>({...s,playlists:s.playlists.map(p=>p.id===selectedPlaylist.id?{...p,name:playlistName.trim()}:p)}));setModal(null);}}><span className="eyebrow">ТВОЯ КОЛЛЕКЦИЯ</span><h2>{modal==='create'?'Новый плейлист':'Название плейлиста'}</h2><p></p><input className="text-input" autoFocus aria-label="Название плейлиста" placeholder="Название плейлиста" maxLength="80" value={playlistName} onChange={e=>setPlaylistName(e.target.value)} required/><button className="button button-primary full-width" type="submit">{modal==='create'?'Создать плейлист':'Сохранить'} <Plus size={16}/></button></form>}
      {modal==='add'&&<><span className="eyebrow">СОХРАНИ НАСТРОЕНИЕ</span><h2>Добавить в плейлист</h2><p>{playlistTarget?.title} · {playlistTarget?.artist}</p><div className="playlist-picker">{state.playlists.map(p=><button key={p.id} onClick={()=>addToPlaylist(p.id)}><ListMusic size={20}/><span>{p.name}<small>{p.trackIds.length} треков</small></span>{p.trackIds.includes(playlistTarget.id)?<Check size={17}/>:<Plus size={17}/>}</button>)}</div><form onSubmit={createPlaylist}><input className="text-input" aria-label="Название нового плейлиста" placeholder="Название нового плейлиста" value={playlistName} onChange={e=>setPlaylistName(e.target.value)} maxLength="80" required/><button className="button button-primary full-width" type="submit">Создать и добавить <Plus size={16}/></button></form></>}
      {modal?.type==='track'&&playlistTarget&&<><div className="modal-track"><Cover track={playlistTarget}/><div><h3>{playlistTarget.title}</h3><p>{playlistTarget.artist}</p></div></div><div className="track-menu"><button onClick={()=>openAdd(playlistTarget)}><Plus size={18}/>Добавить в плейлист</button><button onClick={()=>{toggleLike(playlistTarget);setModal(null);}}><Heart size={18}/>{state.likes.includes(playlistTarget.id)?'Убрать из любимого':'Добавить в любимое'}</button><button disabled={!playlistTarget.streamable} onClick={()=>{setPlaybackQueue([...queueRef.current,playlistTarget]);setWaveMode(false);setModal(null);notify('Добавлено в очередь.');}}><ListMusic size={18}/>Добавить в очередь</button>{downloads[playlistTarget.id]?<button onClick={()=>{removeDownload(playlistTarget);setModal(null);}}><Trash2 size={18}/>Удалить скачанный файл</button>:<button disabled={!playlistTarget.downloadable} onClick={()=>{downloadTrack(playlistTarget);setModal(null);}}><ArrowDownToLine size={18}/>{playlistTarget.downloadable?'Скачать для офлайн-прослушивания':playlistTarget.source==='youtube'?'Музыка из YouTube слушается онлайн':'Автор отключил скачивание'}</button>}{modal.playlist&&<button onClick={()=>{change(s=>({...s,playlists:s.playlists.map(p=>p.id===modal.playlist?{...p,trackIds:p.trackIds.filter(id=>id!==playlistTarget.id)}:p)}));setModal(null);}}><Minus size={18}/>Убрать из плейлиста</button>}<button onClick={()=>{toggleDislike(playlistTarget);setModal(null);}}><ThumbsDown size={18}/>{(state.dislikes||[]).includes(playlistTarget.id)?'Снять дизлайк':'Не нравится'}</button><button onClick={()=>{hideTrack(playlistTarget);setModal(null);}}><Ban size={18}/>Не рекомендовать этот трек</button></div></>}
      {modal==='delete-playlist'&&<><h2>Удалить «{selectedPlaylist?.name}»?</h2><p>Скачанные файлы останутся на диске.</p><button className="button button-primary full-width" onClick={()=>{change(s=>({...s,playlists:s.playlists.filter(p=>p.id!==selectedPlaylist.id)}));setModal(null);navigate('home');}}>Удалить плейлист</button></>}
      {modal==='reset-history'&&<><h2>Сбросить историю?</h2><p>Сбросим историю прослушиваний и пропусков. Любимые треки, плейлисты и выбранные жанры сохранятся.</p><button className="button button-primary full-width" onClick={()=>{change(s=>({...s,events:[]}));setModal(null);notify('История сброшена.');}}>Сбросить историю</button></>}
    </section></div>}
  </div>;
}
