import {useEffect,useRef} from 'react';
import {selectGenreMetadataAnchors} from './core/recommender.mjs';
import {validateGenreEvidence} from './core/genre-evidence.mjs';
export default function useGenreMetadata({bridge,ready,stateRef,change,current,queue,online}){
  const attempts=useRef(new Map()),latest=useRef({current,queue});latest.current={current,queue};
  useEffect(()=>{
    if(!ready||!online||!bridge.genreMetadata)return;
    let cancelled=false,busy=false;
    async function run(){
      if(cancelled||busy)return;
      const state=stateRef.current;if(state.settings.offlineOnly)return;
      const now=Date.now(),anchors=selectGenreMetadataAnchors(state,{limit:24}),pool=[...anchors.slice(0,4),latest.current.current,...latest.current.queue.slice(0,6),...anchors.slice(4),...Object.values(state.tracks).slice(-24)].filter(Boolean);
      const track=pool.find(t=>t.source==='youtube'&&now-(validateGenreEvidence(state.tracks[t.id]?.genreEvidence)?.checkedAt||0)>7*86400000&&now-(attempts.current.get(t.id)||0)>600000);
      if(!track)return;
      busy=true;attempts.current.set(track.id,now);
      try{const evidence=validateGenreEvidence(await bridge.genreMetadata({title:track.title,artist:track.artist,duration:track.duration}));
        if(!cancelled&&evidence)change(s=>s.tracks[track.id]?({...s,tracks:{...s.tracks,[track.id]:{...s.tracks[track.id],genreEvidence:evidence}}}):s);
      }catch{/* Optional enrichment cannot interrupt playback. */}finally{busy=false;}
    }
    const first=setTimeout(run,2000),timer=setInterval(run,8000);
    return()=>{cancelled=true;clearTimeout(first);clearInterval(timer);};
  },[ready,online,bridge,stateRef,change]);
}
