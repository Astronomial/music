const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('forma',{
  desktop:true,
  load:()=>ipcRenderer.invoke('state:load'),
  save:state=>ipcRenderer.invoke('state:save',state),
  request:(path,params)=>ipcRenderer.invoke('audius:request',path,params),
  yandexPlaylist:url=>ipcRenderer.invoke('yandex:playlist',url),
  cancelImport:()=>ipcRenderer.invoke('yandex:cancel'),
  catalogRequest:(route,params,provider)=>provider==='youtube'?ipcRenderer.invoke('youtube:request',route,params).then(r=>Object.assign(r.items,{hasMore:r.hasMore})):ipcRenderer.invoke('audius:request',route,params),
  openYouTube:id=>ipcRenderer.invoke('youtube:open',id),
  importLocal:kind=>ipcRenderer.invoke('local:import',kind),
  onPauseYouTube:callback=>{const fn=()=>callback();ipcRenderer.on('player:pause-youtube',fn);return()=>ipcRenderer.removeListener('player:pause-youtube',fn);},
  sources:id=>ipcRenderer.invoke('audio:sources',id),
  downloads:()=>ipcRenderer.invoke('offline:list'),
  download:id=>ipcRenderer.invoke('offline:download',id),
  removeDownload:id=>ipcRenderer.invoke('offline:remove',id),
  cancelDownload:id=>ipcRenderer.invoke('offline:cancel',id),
  openFolder:()=>ipcRenderer.invoke('folder:open'),
  exportProfile:()=>ipcRenderer.invoke('profile:export'),
  windowControl:action=>ipcRenderer.invoke('window:control',action),
  finishClose:state=>ipcRenderer.invoke('state:close',state),
  onBeforeClose:callback=>{const fn=()=>callback();ipcRenderer.on('app:closing',fn);return ()=>ipcRenderer.removeListener('app:closing',fn);},
  onProgress:callback=> {const fn=(_event,value)=>callback(value);ipcRenderer.on('offline:progress',fn);return ()=>ipcRenderer.removeListener('offline:progress',fn);}
});
