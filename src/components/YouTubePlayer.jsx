import React,{useEffect,useRef,useState} from 'react';
import {ExternalLink,LoaderCircle} from 'lucide-react';
let scriptPromise;
function loadAPI(){
  if(window.YT?.Player)return Promise.resolve(window.YT);
  if(!scriptPromise)scriptPromise=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{scriptPromise=null;reject(new Error('YouTube не загрузился. Проверь интернет или доступность сервиса.'));},20000);
    const old=window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady=()=>{clearTimeout(timer);old?.();resolve(window.YT);};
    const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.onerror=()=>{clearTimeout(timer);scriptPromise=null;script.remove();reject(new Error('Не удалось загрузить плеер YouTube.'));};document.head.appendChild(script);
  });
  return scriptPromise;
}
export default function YouTubePlayer({track,onReady,onPlaying,onPaused,onBuffering,onEnded,onTime,onError,onOpen,volume}) {
  const container=useRef(null),player=useRef(null),callbacks=useRef({});callbacks.current={onReady,onPlaying,onPaused,onBuffering,onEnded,onTime,onError};
  const [error,setError]=useState(''),[loaded,setLoaded]=useState(false);
  useEffect(()=>{
    let alive=true,instance;
    const node=document.createElement('div');container.current.replaceChildren(node);
    loadAPI().then(YT=>{
      if(!alive)return;
      instance=new YT.Player(node,{width:'100%',height:'220',videoId:track.videoId,playerVars:{autoplay:1,playsinline:1,enablejsapi:1,origin:location.origin,widget_referrer:'https://music.forma.desktop/',rel:0},events:{
        onReady:event=>{if(!alive)return;player.current=event.target;event.target.setVolume(volume*100);setLoaded(true);callbacks.current.onReady(event.target);if(!document.hidden)event.target.playVideo();},
        onStateChange:event=>{if(!alive)return;if(event.data===1)callbacks.current.onPlaying();else if(event.data===2)callbacks.current.onPaused();else if(event.data===3)callbacks.current.onBuffering();else if(event.data===0)callbacks.current.onEnded();},
        onError:event=>{if(!alive)return;const message=[101,150].includes(event.data)?'Автор запретил встроенное воспроизведение. Можно открыть трек на YouTube.':event.data===153?'YouTube не разрешил воспроизведение в приложении. Открой трек на YouTube.':'Трек недоступен в YouTube или в твоём регионе.';setError(message);callbacks.current.onError(message);}
      }});
    }).catch(e=>{if(alive){setError(e.message);callbacks.current.onError(e.message);}});
    const timer=setInterval(()=>{const p=player.current;if(alive&&p?.getCurrentTime)callbacks.current.onTime(p.getCurrentTime(),p.getDuration());},500);
    const visibility=()=>{if(document.hidden)player.current?.pauseVideo?.();};document.addEventListener('visibilitychange',visibility);
    return()=>{alive=false;clearInterval(timer);document.removeEventListener('visibilitychange',visibility);player.current=null;callbacks.current.onReady(null);instance?.destroy();};
  },[track.videoId]);
  useEffect(()=>{player.current?.setVolume?.(volume*100);},[volume]);
  return <aside className="youtube-panel"><span className="eyebrow">СЕЙЧАС ИГРАЕТ · YOUTUBE</span><div className="youtube-frame" ref={container}/>{!loaded&&!error&&<p className="search-loading"><LoaderCircle size={17} className="spin"/>Подключаем плеер…</p>}{error&&<p className="player-error" role="alert">{error}</p>}<div className="youtube-details"><h2>{track.title}</h2><p>{track.artist}</p><button className="text-link" onClick={()=>onOpen(track.videoId)}>Открыть на YouTube <ExternalLink size={15}/></button></div><p className="settings-note">Видео остаётся видимым во время прослушивания. Для музыки без интернета добавь свои файлы.</p></aside>;
}
