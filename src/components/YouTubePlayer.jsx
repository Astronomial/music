import React,{useEffect,useRef,useState} from 'react';
import {ExternalLink,LoaderCircle} from 'lucide-react';
let scriptPromise;
function loadAPI(){
  if(window.YT?.Player)return Promise.resolve(window.YT);
  if(!scriptPromise)scriptPromise=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{scriptPromise=null;script.remove();reject(new Error('YouTube не загрузился. Проверь интернет или доступность сервиса.'));},20000);
    const old=window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady=()=>{clearTimeout(timer);old?.();resolve(window.YT);};
    const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.onerror=()=>{clearTimeout(timer);scriptPromise=null;script.remove();reject(new Error('Не удалось загрузить плеер YouTube.'));};document.head.appendChild(script);
  });
  return scriptPromise;
}
export default function YouTubePlayer({track,playbackId,onReady,onPlaying,onPaused,onBuffering,onEnded,onTime,onError,onOpen,volume}) {
  const container=useRef(null),player=useRef(null),callbacks=useRef({}),target=useRef(null),liveVolume=useRef(volume),intent=useRef(true),loadedRequest=useRef(null),transition=useRef(true);
  callbacks.current={onReady,onPlaying,onPaused,onBuffering,onEnded,onTime,onError};target.current=track;liveVolume.current=volume;
  const [error,setError]=useState(''),[loaded,setLoaded]=useState(false),[apiAttempt,setApiAttempt]=useState(0);
  function matches(){return target.current&&player.current?.getVideoData?.().video_id===target.current.videoId;}
  function loadCurrent(){
    const p=player.current,t=target.current;if(!p)return;
    if(!t){p.pauseVideo();return;}
    transition.current=true;p.setVolume(liveVolume.current*100);
    if(intent.current)p.loadVideoById({videoId:t.videoId,startSeconds:0});
    else p.cueVideoById({videoId:t.videoId,startSeconds:0});
  }
  // The same iframe/player survives every YouTube track change and local interlude.
  useEffect(()=>{
    let alive=true,instance;
    const controls={
      playVideo:()=>{intent.current=true;player.current?.playVideo();},
      pauseVideo:()=>{intent.current=false;player.current?.pauseVideo();},
      wantsPlayback:()=>intent.current,
      getPlayerState:()=>matches()?player.current.getPlayerState():-1,
      getCurrentTime:()=>matches()?player.current.getCurrentTime():0,
      getDuration:()=>matches()?player.current.getDuration():0,
      getVideoData:()=>player.current?.getVideoData?.()||{},
      seekTo:(time,allow)=>{if(matches())player.current.seekTo(time,allow);},
      setVolume:value=>{liveVolume.current=value/100;player.current?.setVolume(value);}
    };
    callbacks.current.onReady(controls);
    const node=document.createElement('div');container.current.replaceChildren(node);
    loadAPI().then(YT=>{
      if(!alive)return;
      instance=new YT.Player(node,{width:'100%',height:'220',playerVars:{autoplay:0,playsinline:1,enablejsapi:1,origin:location.origin,widget_referrer:'https://music.forma.desktop/',rel:0},events:{
        onReady:event=>{if(!alive)return;player.current=event.target;setLoaded(true);loadCurrent();},
        onStateChange:event=>{
          if(!alive||!matches())return;
          if(event.data===1){transition.current=false;if(!intent.current){player.current.pauseVideo();return;}callbacks.current.onPlaying();}
          else if(event.data===2){if(!transition.current)intent.current=false;callbacks.current.onPaused();}
          else if(event.data===3&&intent.current)callbacks.current.onBuffering();
          else if(event.data===0&&intent.current&&player.current.getPlayerState()===0)callbacks.current.onEnded();
        },
        onError:event=>{if(!alive||!target.current)return;const videoId=player.current?.getVideoData?.().video_id;if(videoId&&videoId!==target.current.videoId)return;const message=[101,150].includes(event.data)?'Автор запретил встроенное воспроизведение. Можно открыть трек на YouTube.':event.data===153?'YouTube не разрешил воспроизведение в приложении. Открой трек на YouTube.':'Трек недоступен в YouTube или в твоём регионе.';intent.current=false;setError(message);callbacks.current.onError(message);}
      }});
    }).catch(e=>{if(alive&&target.current){setError(e.message);callbacks.current.onError(e.message);}});
    const timer=setInterval(()=>{const p=player.current;if(alive&&matches())callbacks.current.onTime(p.getCurrentTime(),p.getDuration());},500);
    return()=>{alive=false;clearInterval(timer);player.current=null;callbacks.current.onReady(null);instance?.destroy();};
  },[apiAttempt]);
  useEffect(()=>{
    if(loadedRequest.current===playbackId&&track)return;
    loadedRequest.current=playbackId;intent.current=Boolean(track);if(track&&error&&!loaded)setApiAttempt(a=>a+1);setError('');loadCurrent();
  },[track?.videoId,playbackId]);
  useEffect(()=>{player.current?.setVolume?.(volume*100);},[volume]);
  return <aside className="youtube-panel" hidden={!track}><span className="eyebrow">СЕЙЧАС ИГРАЕТ · YOUTUBE</span><div className="youtube-frame" ref={container}/>{!loaded&&!error&&<p className="search-loading"><LoaderCircle size={17} className="spin"/>Подключаем плеер…</p>}{error&&<p className="player-error" role="alert">{error}</p>}<div className="youtube-details"><h2>{track?.title}</h2><p>{track?.artist}</p><button className="text-link" onClick={()=>onOpen(track.videoId)}>Открыть на YouTube <ExternalLink size={15}/></button></div><p className="settings-note">Можно свернуть Forma — музыка продолжит играть. Для прослушивания без интернета добавь свои файлы.</p></aside>;
}
