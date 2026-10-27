import {useEffect,useRef} from 'react';
import {validateSoundProfile} from './core/sound-profile.mjs';
export default function useSoundAnalysis({bridge,ready,stateRef,current,buffering,change,queue,enabled}){
  const attempts=useRef(new Map()),budget=useRef([]),generation=useRef(0);
  const live=useRef(null);live.current={current,buffering,change,queue};
  useEffect(()=>{
    if(!ready||!bridge.soundAudio||!enabled)return;
    let cancelled=false,worker,working=false,pending,timer;const token=++generation.current;
    async function run(){
      if(cancelled||working||live.current.buffering)return 1000;const state=stateRef.current,now=Date.now();budget.current=budget.current.filter(t=>now-t<3600000);if(budget.current.length>=120)return 30000;
      const saved=[...new Set([...state.likes,...state.playlists.flatMap(p=>p.trackIds)])].map(id=>state.tracks[id]).filter(Boolean).sort((a,b)=>(attempts.current.get(a.id)||0)-(attempts.current.get(b.id)||0));
      const pool=[live.current.current,...live.current.queue.slice(0,3),...saved].filter(Boolean);
      const track=pool.find(t=>t.source==='youtube'&&!validateSoundProfile(state.tracks[t.id]?.soundProfile)?.semantic&&now-(attempts.current.get(t.id)||0)>300000);
      if(!track)return 30000;attempts.current.set(track.id,now);budget.current.push(now);working=true;
      try{
        const bytes=await bridge.soundAudio(track.videoId);if(cancelled)return;
        const context=new OfflineAudioContext(1,1,16000),audio=await context.decodeAudioData(new Uint8Array(bytes).buffer);if(cancelled)return;
        const count=Math.min(audio.length,384000),pcm=new Float32Array(count);
        for(let channel=0;channel<audio.numberOfChannels;channel++){const source=audio.getChannelData(channel);for(let i=0;i<count;i++)pcm[i]+=source[i]/audio.numberOfChannels;}
        worker??=new Worker(new URL('./sound-worker.mjs',import.meta.url),{type:'module'});
        const profile=await new Promise(resolve=>{
          let timer;
          const finish=value=>{clearTimeout(timer);pending=null;resolve(value);};pending=()=>finish(null);
          worker.onmessage=e=>finish(e.data.profile);
          worker.onerror=()=>{worker?.terminate();worker=null;finish(null);};
          timer=setTimeout(()=>{worker?.terminate();worker=null;finish(null);},45000);
          worker.postMessage({pcm},[pcm.buffer]);
        });
        if(!cancelled&&generation.current===token&&validateSoundProfile(profile))live.current.change(s=>s.tracks[track.id]?({...s,tracks:{...s.tracks,[track.id]:{...s.tracks[track.id],soundProfile:validateSoundProfile(profile)}}}):s);
      }catch{/* Optional analysis never interrupts playback. Retry is bounded. */}finally{working=false;}
      return 30000;
    }
    // Retry a deferred start promptly, without running analysis during buffering.
    // A completed attempt still observes the normal interval and hourly budget.
    async function pump(){const delay=await run();if(!cancelled)timer=setTimeout(pump,delay);}
    timer=setTimeout(pump,5000);
    return()=>{cancelled=true;clearTimeout(timer);pending?.();worker?.terminate();bridge.cancelSound?.();};
  },[ready,stateRef,bridge,enabled]);
}
