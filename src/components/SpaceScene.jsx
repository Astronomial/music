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

export const SpaceBackdrop=memo(function SpaceBackdrop(){
  return <div className="cosmic-background" aria-hidden="true"><div className="cosmic-nebula"/><div className="cosmic-starfield"/><div className="cosmic-twinkles">{[0,1,2,3,4,5].map(i=><i key={i}/>)}</div><div className="cosmic-meteors">{[0,1,2].map(i=><span className="shooting-star" key={i}/>)}</div></div>;
});

export const PulseGalaxy=memo(function PulseGalaxy(){
  const element=useRef(null);
  useEffect(()=>{
    const observer=new IntersectionObserver(([entry])=>{if(element.current)element.current.dataset.inView=String(entry.isIntersecting);});
    observer.observe(element.current);return ()=>observer.disconnect();
  },[]);
  return <div ref={element} className="pulse-galaxy" aria-hidden="true"><div className="galaxy-aura"/><div className="galaxy-plane"><img className="galaxy-disk" src={galaxy} alt="" decoding="async" draggable="false"/></div><div className="galaxy-heart"/></div>;
});
