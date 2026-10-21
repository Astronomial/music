import {useEffect,useRef} from 'react';
import {validateSoundProfile} from './core/sound-profile.mjs';
export default function useSoundAnalysis({bridge,ready,stateRef,current,buffering,change,queue,enabled}){
  const attempts=useRef(new Map()),budget=useRef([]),generation=useRef(0);
  useEffect(()=>{
    if(!ready||!bridge.soundAudio||buffering||!enabled)return;
    let cancelled=false,worker,working=false;const token=++generation.current;
    async function run(){
      if(cancelled||working)return;const state=stateRef.current,now=Date.now();budget.current=budget.current.filter(t=>now-t<3600000);if(budget.current.length>=12)return;
      const saved=[...new Set([...state.likes,...state.playlists.flatMap(p=>p.trackIds)])].map(id=>state.tracks[id]).filter(Boolean).sort((a,b)=>(attempts.current.get(a.id)||0)-(attempts.current.get(b.id)||0));
      const pool=[current,...queue.slice(0,2),...saved].filter(Boolean);
      const track=pool.find(t=>t.source==='youtube'&&!validateSoundProfile(state.tracks[t.id]?.soundProfile)&&now-(attempts.current.get(t.id)||0)>300000);
      if(!track)return;attempts.current.set(track.id,now);budget.current.push(now);working=true;
      try{
        const bytes=await bridge.soundAudio(track.videoId);if(cancelled)return;
        const context=new OfflineAudioContext(1,1,16000),audio=await context.decodeAudioData(new Uint8Array(bytes).buffer);if(cancelled)return;
        const count=Math.min(audio.length,384000),pcm=new Float32Array(count);
        for(let channel=0;channel<audio.numberOfChannels;channel++){const source=audio.getChannelData(channel);for(let i=0;i<count;i++)pcm[i]+=source[i]/audio.numberOfChannels;}
        worker=new Worker(new URL('./sound-worker.mjs',import.meta.url),{type:'module'});
        const profile=await new Promise(resolve=>{worker.onmessage=e=>resolve(e.data.profile);worker.onerror=()=>resolve(null);worker.postMessage({pcm},[pcm.buffer]);});worker.terminate();worker=null;
        if(!cancelled&&generation.current===token&&validateSoundProfile(profile))change(s=>s.tracks[track.id]?({...s,tracks:{...s.tracks,[track.id]:{...s.tracks[track.id],soundProfile:profile}}}):s);
      }catch{/* Optional analysis never interrupts playback. Retry is bounded. */}finally{working=false;}
    }
    const first=setTimeout(run,5000),timer=setInterval(run,30000);
    return()=>{cancelled=true;clearTimeout(first);clearInterval(timer);worker?.terminate();bridge.cancelSound?.();};
  },[ready,current?.id,buffering,stateRef,change,bridge,queue,enabled]);
}
