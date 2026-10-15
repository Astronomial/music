export function createHybridAudio(element,bridge){
  if(!bridge.browserAudio||!bridge.onBrowserAudio)return element;
  let remote=null,disposed=false;const ownEvent=Symbol('browser-audio');
  const events=['playing','pause','timeupdate','durationchange','waiting','ended','error'];
  const dispatch=type=>{const event=new Event(type);event[ownEvent]=true;element.dispatchEvent(event);};
  const suppress=event=>{if(remote&&!event[ownEvent])event.stopImmediatePropagation();};
  for(const name of events)element.addEventListener(name,suppress,true);
  function command(action,value){if(!remote)return Promise.resolve();return bridge.browserAudio({action,token:remote.token,...(value===undefined?{}:{value})});}
  function stop(){if(remote?.started)command('stop').catch(()=>{});remote=null;}
  const unsubscribe=bridge.onBrowserAudio(status=>{
    if(!remote||status.token!==remote.token||status.id!==remote.id)return;
    if(status.error){remote.error={code:2,message:status.error};remote.paused=true;dispatch('error');return;}
    if(status.waiting){dispatch('waiting');return;}
    const before={...remote};
    if(Number.isFinite(status.currentTime))remote.currentTime=status.currentTime;
    if(Number.isFinite(status.duration)&&status.duration>0)remote.duration=status.duration;
    remote.paused=status.paused;remote.ended=status.ended;remote.readyState=status.readyState;remote.intent=status.intent;
    if(remote.duration!==before.duration)dispatch('durationchange');
    if(!remote.paused&&(!before.playing||before.paused)){remote.playing=true;dispatch('playing');}
    else if(remote.paused&&!before.paused)dispatch('pause');
    if(remote.currentTime!==before.currentTime)dispatch('timeupdate');
    if(remote.ended&&!before.ended)dispatch('ended');
  });
  const overrides={
    play:()=>{
      if(!remote)return element.play();
      if(!remote.started){remote.started=true;return bridge.browserAudio({action:'load',token:remote.token,id:remote.id,volume:element.volume});}
      return command('play');
    },
    pause:()=>{if(!remote)return element.pause();remote.paused=true;remote.intent=false;command('pause').catch(()=>{});dispatch('pause');},
    removeAttribute:name=>{if(name==='src')stop();element.removeAttribute(name);},
    getAttribute:name=>remote&&name==='src'?remote.src:element.getAttribute(name),
    dispose:()=>{if(disposed)return;disposed=true;stop();unsubscribe();for(const name of events)element.removeEventListener(name,suppress,true);}
  };
  return new Proxy(element,{
    get(target,key){
      if(key in overrides)return overrides[key];
      if(key==='remoteWantsPlayback')return remote?.intent;
      if(remote&&['src','currentSrc','currentTime','duration','paused','ended','readyState','error'].includes(key))return remote[key==='currentSrc'?'src':key];
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    },
    set(target,key,value){
      if(key==='src'&&typeof value==='string'&&/^forma-browser:\/\/youtube\/[\w-]{11}$/.test(value)){
        stop();element.pause();element.removeAttribute('src');element.load();remote={id:value.split('/').at(-1),token:crypto.randomUUID(),src:value,currentTime:0,duration:0,paused:true,ended:false,readyState:0,error:null,started:false};return true;
      }
      if(remote&&key==='currentTime'){remote.currentTime=value;command('seek',value).catch(()=>{});return true;}
      if(remote&&key==='volume')command('volume',value).catch(()=>{});
      return Reflect.set(target,key,value,target);
    }
  });
}
