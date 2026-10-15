const validID=id=>typeof id==='string'&&/^[\w-]{11}$/.test(id);
const validToken=value=>typeof value==='string'&&/^[\w-]{1,80}$/.test(value);
// Compatibility playback uses YouTube's ordinary web player. No media URLs,
// account credentials or executable page content cross the IPC boundary.
class BrowserAudio {
  constructor({BrowserWindow,onState}){this.BrowserWindow=BrowserWindow;this.onState=onState;this.window=null;this.state=null;this.timer=null;this.polling=false;this.preferredUntil=0;}
  get preferred(){return this.preferredUntil>Date.now();}
  emit(patch){if(this.state)this.onState({...patch,id:this.state.id,token:this.state.token});}
  createWindow(){
    if(this.window&&!this.window.isDestroyed())return this.window;
    const window=new this.BrowserWindow({show:false,frame:false,skipTaskbar:process.platform==='win32',width:640,height:480,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
    this.window=window;
    const ua=window.webContents.getUserAgent().replace(/\s(?:Electron|Forma|forma-music)\/[^\s]+/gi,'');window.webContents.setUserAgent(ua);
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.webContents.on('will-redirect',(event,url)=>{try{if(new URL(url).origin!=='https://www.youtube.com')event.preventDefault();}catch{event.preventDefault();}});
    window.webContents.on('render-process-gone',()=>this.emit({error:'BROWSER_PROCESS_EXITED'}));
    window.on('closed',()=>{if(this.window===window)this.window=null;});
    return window;
  }
  async command(input){
    if(!input||!validToken(input.token))throw Error('Некорректный запрос плеера');
    if(input.action==='load'){
      if(!validID(input.id))throw Error('Некорректный трек YouTube');
      this.state={id:input.id,token:input.token,intent:true,volume:Math.max(0,Math.min(1,Number(input.volume)||0)),seek:null,load:true,play:true,hasPlayed:false};
      const loading=this.state;
      const window=this.createWindow();
      if(!window.webContents.getURL().startsWith('https://www.youtube.com/watch')){
        window.loadURL('https://www.youtube.com/watch?v='+input.id+'&autoplay=0').catch(()=>{if(this.state===loading)this.emit({error:'BROWSER_PAGE_LOAD_FAILED'});});
      }
      if(!this.timer)this.timer=setInterval(()=>this.poll(),200);
      return true;
    }
    if(input.token!==this.state?.token)return false;
    if(input.action==='stop'){this.state.intent=false;this.state=null;clearInterval(this.timer);this.timer=null;await this.applyPause();return true;}
    if(input.action==='pause'){this.state.intent=false;this.state.play=false;await this.applyPause();return true;}
    if(input.action==='play'){this.state.intent=true;this.state.play=true;}
    else if(input.action==='volume'&&Number.isFinite(input.value))this.state.volume=Math.max(0,Math.min(1,input.value));
    else if(input.action==='seek'&&Number.isFinite(input.value))this.state.seek=Math.max(0,input.value);
    else if(input.action!=='play')throw Error('Неизвестная команда плеера');
    return true;
  }
  async applyPause(){try{await this.window?.webContents.executeJavaScript('document.querySelectorAll("video,audio").forEach(media=>media.pause())');}catch{}}
  async poll(){
    if(this.polling||!this.state||!this.window||this.window.isDestroyed()||this.window.webContents.isLoadingMainFrame())return;
    this.polling=true;const state=this.state,command={id:state.id,intent:state.intent,volume:state.volume,seek:state.seek,load:state.load,play:state.play};
    try{
      const status=await this.window.webContents.executeJavaScript(`(()=>{
        const command=${JSON.stringify(command)},player=document.getElementById('movie_player'),media=player?.querySelector('video')||document.querySelector('video');
        if(!player||!media)return document.querySelector('.ytp-error')?{error:'BROWSER_VIDEO_UNAVAILABLE'}:{waiting:true};
        const data=player.getVideoData?.()||{},ad=player.classList?.contains('ad-showing')===true;
        if(command.load){
          if(data.video_id!==command.id){player.loadVideoById?.(command.id);return {waiting:true,loaded:true};}
          try{player.setPlaybackQualityRange?.('tiny','small');}catch{}
          const autonav=document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]');autonav?.click();
        }
        if(!ad&&data.video_id&&data.video_id!==command.id){media.pause();return {waiting:true};}
        media.volume=command.volume;media.muted=false;
        if(command.seek!==null&&Number.isFinite(media.duration))media.currentTime=Math.min(command.seek,Math.max(0,media.duration-.05));
        if(command.intent&&!media.ended){if(command.play&&media.paused)media.play().catch(()=>{});}else media.pause();
        if(media.ended)media.pause();
        const error=player.classList?.contains('ytp-error');
        return {loaded:true,seeked:command.seek!==null,currentTime:ad?0:media.currentTime,duration:ad?0:media.duration,paused:media.paused,ended:media.ended,readyState:ad?2:media.readyState,ad,error:media.error||error? 'BROWSER_VIDEO_UNAVAILABLE':null};
      })()`);
      if(this.state!==state)return;
      if(status.loaded)state.load=false;if(status.seeked&&state.seek===command.seek)state.seek=null;
      if(status.ended&&!state.hasPlayed){status.ended=false;status.waiting=true;}
      if(status.loaded&&!status.paused)state.play=false;
      if(!status.paused&&!status.ad&&status.currentTime>.1)state.hasPlayed=true;
      if(status.loaded&&status.paused&&state.hasPlayed&&!command.play)state.intent=false;
      if(status.ended)state.intent=false;
      if(!status.paused&&!status.ad&&status.currentTime>.25)this.preferredUntil=Date.now()+30*60000;
      this.emit({...status,intent:state.intent});
    }catch{if(this.state===state)this.emit({error:'BROWSER_CONTROL_FAILED'});}finally{this.polling=false;}
  }
  close(){clearInterval(this.timer);this.timer=null;this.state=null;this.window?.destroy();this.window=null;}
}
module.exports={BrowserAudio};
