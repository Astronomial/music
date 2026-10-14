import React,{memo,useEffect,useRef,useState} from 'react';
import galaxy from '../assets/pulse-galaxy.svg';

export function useVisualActivity(){
  const [visible,setVisible]=useState(()=>!document.hidden);
  useEffect(()=>{
    const update=()=>setVisible(!document.hidden);
    document.addEventListener('visibilitychange',update);
    return ()=>document.removeEventListener('visibilitychange',update);
  },[]);
  return visible;
}

// One 3.2-second flight per four-second slot; paths cover the whole window.
// Coordinates and CSS timing stay stable across playback and page renders.
const METEOR_PATHS=[
  [-4,5,28,58,110,.8], [34,-4,35,44,95,.7], [74,10,34,40,125,.75],
  [-3,48,25,48,92,.8], [33,39,32,45,112,.75], [61,54,24,36,84,.7],
  [8,-5,38,54,124,.8], [16,72,20,55,94,.7], [47,19,27,40,116,.8],
  [-2,28,29,62,104,.75], [8,59,19,50,96,.7], [43,82,20,48,114,.8]
].map(([x,y,angle,distance,tail,light],i)=>({
  '--meteor-x':x+'%','--meteor-y':y+'%','--meteor-angle':angle+'deg',
  '--meteor-distance':`min(${distance}vw, 90vh)`,'--meteor-tail':tail+'px',
  '--meteor-light':light,'--meteor-delay':(i*4-.8)+'s'
}));

export const SpaceBackdrop=memo(function SpaceBackdrop(){
  return <div className="cosmic-background" aria-hidden="true"><div className="cosmic-nebula"/><div className="cosmic-starfield"/><div className="cosmic-twinkles">{[0,1,2,3,4,5].map(i=><i key={i}/>)}</div><div className="cosmic-meteors">{METEOR_PATHS.map((style,i)=><span className="meteor-origin" style={style} key={i}><i className="shooting-star"/></span>)}</div></div>;
});

export const PulseGalaxy=memo(function PulseGalaxy(){
  const element=useRef(null);
  useEffect(()=>{
    const observer=new IntersectionObserver(([entry])=>{if(element.current)element.current.dataset.inView=String(entry.isIntersecting);});
    observer.observe(element.current);return ()=>observer.disconnect();
  },[]);
  return <div ref={element} className="pulse-galaxy" aria-hidden="true"><div className="galaxy-aura"/><div className="galaxy-plane"><img className="galaxy-disk" src={galaxy} alt="" decoding="async" draggable="false"/></div><div className="galaxy-heart"/></div>;
});
