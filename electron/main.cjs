const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog } = require('electron');
const path = require('node:path');
const { startStaticServer } = require('./static.cjs');
const { Store } = require('./storage.cjs');
const { folderFiles, importLocalFile } = require('./local.cjs');
const { OfflineLibrary, validId } = require('./offline.cjs');
protocol.registerSchemesAsPrivileged([{scheme:'forma-audio', privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true}}]);
let window, store, offline, api, uiServer, apiKey = '', closing = false, closeTimer;
// Dev smoke tests use an explicit temporary profile on all operating systems.
const testDataArg = process.argv.find(arg=>arg.startsWith('--forma-test-data='));
if(!app.isPackaged&&testDataArg) app.setPath('userData',path.resolve(testDataArg.slice('--forma-test-data='.length)));
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance',()=>{ window?.restore(); window?.focus(); });
app.whenReady().then(async () => {
  api = await import('../src/core/audius.mjs');
  const { normalizeTrack } = await import('../src/core/model.mjs');
  store = new Store(app.getPath('userData'));
  offline = new OfflineLibrary(path.join(app.getPath('userData'),'Music'));
  await offline.init();
  const state = await store.read('library.json',null); apiKey = state?.settings?.apiKey || '';
  protocol.handle('forma-audio', request => { const url = new URL(request.url); return url.hostname==='track' ? offline.respond(url.pathname.slice(1),request.headers.get('range')) : url.hostname==='art'?offline.respondArt(url.pathname.slice(1)):new Response(null,{status:404}); });
  const handle = (name, fn) => ipcMain.handle(name,(event,...args)=> {
    if (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame) throw new Error('Недопустимый источник запроса');
    return fn(...args);
  });
  handle('state:load',()=>store.read('library.json',null));
  const saveState = async state => {
    if (!state || state.version!==1 || !state.tracks || !Array.isArray(state.likes) || !Array.isArray(state.events) || !Array.isArray(state.playlists) || JSON.stringify(state).length>25*1024**2) throw new Error('Некорректная библиотека');
    apiKey = String(state.settings?.apiKey || '').slice(0,250);
    await store.write('library.json',state);
  };
  handle('state:save',saveState);
  handle('state:close',async state=> {
    await saveState(state);await store.queue;clearTimeout(closeTimer);closing=true;window.close();
  });
  handle('audius:request',(route,params)=>api.requestAudius(route,params,net.fetch,apiKey));
  const { YouTubeCatalog } = await import('../src/core/youtube.mjs');
  const catalog=new YouTubeCatalog(async()=>{
    const {Innertube}=await import('youtubei.js');
    return Innertube.create({lang:'en',location:'US',retrieve_player:false,generate_session_locally:true,fetch:(input,options={})=>{
      const url=new URL(typeof input==='string'?input:input.url||input.href);
      if(url.protocol!=='https:'||!(/(^|\.)youtube\.com$/.test(url.hostname)||url.hostname==='youtubei.googleapis.com'))throw new Error('Недопустимый адрес каталога.');
      const timeout=AbortSignal.timeout(18000);return net.fetch(input,{...options,signal:options.signal?AbortSignal.any([options.signal,timeout]):timeout});
    }});
  });
  handle('youtube:request',(route,params)=>catalog.request(route,params));
  let localBusy=false;
  handle('local:import',async kind=>{
    if(localBusy)throw new Error('Дождись завершения импорта файлов.');localBusy=true;
    try{
      const chosen=await dialog.showOpenDialog(window,{title:kind==='folder'?'Выбери папку с музыкой':'Выбери музыкальные файлы',properties:kind==='folder'?['openDirectory']:['openFile','multiSelections'],filters:[{name:'Музыка',extensions:['mp3','flac','ogg','opus','wav','m4a','mp4']}]});
      if(chosen.canceled)return {files:offline.list(),added:0,errors:[]};
      const files=kind==='folder'?await folderFiles(chosen.filePaths[0]):chosen.filePaths;
      const errors=[];let added=0;
      for(const file of files)try{const before=Object.keys(offline.manifest).length;await importLocalFile(file,offline);if(Object.keys(offline.manifest).length>before)added++;}catch(e){errors.push({file:path.basename(file),error:e.message});}
      return {files:offline.list(),added,errors};
    }finally{localBusy=false;}
  });

  const { requestPublicYandexPlaylist } = await import('../src/core/yandex.mjs');
  let importController;
  handle('yandex:playlist',async url=>{
    importController?.abort();const controller=new AbortController();importController=controller;
    try{return await requestPublicYandexPlaylist(url,net.fetch,{signal:controller.signal});}
    finally{if(importController===controller)importController=null;}
  });
  handle('yandex:cancel',()=>importController?.abort());
  handle('audio:sources',id=> {
    if (!validId(id)) throw new Error('Некорректный трек');
    return offline.manifest[id] ? [`forma-audio://track/${id}`] : api.API_HOSTS.map(host=>api.apiURL(host,`/tracks/${id}/stream`,apiKey?{api_key:apiKey}:{}));
  });
  handle('offline:list',()=>offline.list());
  handle('offline:download',async id => {
    if (!validId(id)) throw new Error('Некорректный трек');
    const fresh = normalizeTrack(await api.requestAudius(`/tracks/${id}`,{},net.fetch,apiKey));
    return offline.download(fresh,async signal=> {
      let lastError;
      for (const host of api.API_HOSTS) try {
        const response = await net.fetch(api.apiURL(host,`/tracks/${id}/download`,apiKey?{api_key:apiKey}:{}),{signal,headers:apiKey?{'x-api-key':apiKey}:{}});
        if (response.ok) return response;
        await response.body?.cancel(); lastError=new Error(`Audius: ${response.status}`);
      } catch(e) { lastError=e; if(signal.aborted) throw e; }
      throw lastError;
    },progress=>window?.webContents.send('offline:progress',progress));
  });
  handle('offline:remove',id=>offline.remove(id));
  handle('offline:cancel',id=>offline.cancel(id));
  handle('folder:open',()=>shell.openPath(offline.dir));
  handle('profile:export',async()=> {
    const result = await dialog.showSaveDialog(window,{title:'Экспорт библиотеки Forma',defaultPath:'Forma-library.json',filters:[{name:'JSON',extensions:['json']}]});
    if(result.canceled) return false;
    const fs = require('node:fs/promises'); const state = await store.read('library.json',{});
    if(state.settings) delete state.settings.apiKey;
    await fs.writeFile(result.filePath,JSON.stringify(state,null,2)); return true;
  });
  handle('youtube:open',id=>{if(!/^[\w-]{11}$/.test(id))throw new Error('Некорректная ссылка.');return shell.openExternal('https://www.youtube.com/watch?v='+id);});
  handle('window:control',action=> { if(action==='minimize') window.minimize(); if(action==='maximize') window.isMaximized()?window.unmaximize():window.maximize(); if(action==='close') window.close(); });
  window = new BrowserWindow({width:1440,height:940,minWidth:1000,minHeight:680,frame:false,backgroundColor:'#06070b',title:'Forma',icon:path.join(__dirname,'../build/icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false}});
  window.on('close',event=> {
    if(closing)return;
    event.preventDefault();window.webContents.send('app:closing');
    clearTimeout(closeTimer);closeTimer=setTimeout(async()=>{await store.queue.catch(()=>{});closing=true;window.close();},3000);
  });
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  const localUI=await startStaticServer(path.join(__dirname,'../dist'));uiServer=localUI.server;const entry=localUI.url;
  window.webContents.on('will-navigate',(e,url)=>{if(url!==entry)e.preventDefault();});
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,cb)=>cb(false));
  window.webContents.session.webRequest.onHeadersReceived((details,callback)=> {
    if(details.url===entry) callback({responseHeaders:{...details.responseHeaders,'Content-Security-Policy':["default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob: forma-audio:; media-src 'self' https: forma-audio: blob:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com"]}});
    else callback({responseHeaders:details.responseHeaders});
  });
  app.setAppUserModelId('music.forma.desktop');
  window.webContents.session.webRequest.onBeforeSendHeaders({urls:['https://www.youtube.com/*','https://www.youtube-nocookie.com/*']},(details,callback)=>callback({requestHeaders:{...details.requestHeaders,Referer:'https://music.forma.desktop/'}}));
  await window.loadURL(entry);
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{uiServer?.close();for(const id of offline?.active.keys() || []) offline.cancel(id);});
