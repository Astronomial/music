import React,{memo,useEffect,useRef,useState} from 'react';
import {Volume2,VolumeX} from 'lucide-react';
export default memo(function VolumeControl({value,onLive,onCommit}){
  const [volume,setVolume]=useState(value),live=useRef(value),editing=useRef(false),lastAudible=useRef(value||.7);
  useEffect(()=>{if(!editing.current){live.current=value;setVolume(value);}},[value]);
  function change(next){next=Math.max(0,Math.min(1,next));live.current=next;setVolume(next);if(next)lastAudible.current=next;onLive(next);}
  function commit(){editing.current=false;onCommit(live.current);}
  return <div className="volume-control"><button className="icon-button" aria-label={volume?'Выключить звук':'Включить звук'} onClick={()=>{change(volume?0:lastAudible.current);commit();}}>{volume?<Volume2 size={18}/>:<VolumeX size={18}/>}</button><input type="range" aria-label="Громкость" min="0" max="1" step="0.001" value={volume} style={{'--fill':`${volume*100}%`}} onPointerDown={()=>{editing.current=true;}} onKeyDown={()=>{editing.current=true;}} onChange={e=>change(Number(e.target.value))} onPointerUp={commit} onPointerCancel={commit} onKeyUp={commit} onBlur={commit}/></div>;
});
