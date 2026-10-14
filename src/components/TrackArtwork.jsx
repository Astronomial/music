import React,{useEffect,useState} from 'react';
import {Music2} from 'lucide-react';
export default function Cover({ track, className='' }) {
  const [broken,setBroken]=useState(false);
  useEffect(()=>setBroken(false),[track?.artwork]);
  const palette = ['#777f68','#a38b76','#77748c','#5f7f87','#9c796c'];
  const hash = [...(track?.id || 'forma')].reduce((a,c)=>a+c.charCodeAt(0),0);
  return <div className={`cover ${className}`} style={{backgroundColor:palette[hash%palette.length]}}>{track?.artwork&&!broken?<img src={track.artwork} alt="" loading="lazy" onError={()=>setBroken(true)}/>:<><span className="cover-orbit"/><Music2 size={22}/></>}</div>;
}
