const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog } = require('electron');
const path = require('node:path');
const { startStaticServer } = require('./static.cjs');
const { playerBrowserURL, playerRequestHeaders } = require('./player-links.cjs');
const { Store } = require('./storage.cjs');
const { folderFiles, importLocalFile } = require('./local.cjs');
const { OfflineLibrary, validId } = require('./offline.cjs');
protocol.registerSchemesAsPrivileged(['forma-audio','forma-stream'].map(scheme=>({scheme,privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true,corsEnabled:true}})));
let window, store, offline, youtubeAudio, browserAudio, uiServer, syncServer, coordinator, desktopBaseline, closing = false, closeTimer;
// Dev smoke tests use an explicit temporary profile on all operating systems.
// Explicit isolated profiles also let release checks run the packaged EXE.
const profileArg=process.argv.find(arg=>arg.startsWith('--user-data-dir='));
if(profileArg)app.setPath('userData',path.resolve(profileArg.slice('--user-data-dir='.length)));
const testDataArg = process.argv.find(arg=>arg.startsWith('--forma-test-data='));
if(!app.isPackaged&&testDataArg) app.setPath('userData',path.resolve(testDataArg.slice('--forma-test-data='.length)));
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance',()=>{ window?.restore(); window?.focus(); });
app.whenReady().then(async () => {
  const {desktopAppID,desktopPlayerIdentity}=await import('../src/core/youtube-player-config.mjs');
  store = new Store(app.getPath('userData'));
  offline = new OfflineLibrary(path.join(app.getPath('userData'),'Music'));
  await offline.init();
  // Let the renderer show recovery actions if the profile cannot be read.
  protocol.handle('forma-audio', request => { const url = new URL(request.url); return url.hostname==='track' ? offline.respond(url.pathname.slice(1),request.headers.get('range')) : url.hostname==='art'?offline.respondArt(url.pathname.slice(1)):new Response(null,{status:404}); });
  const handle = (name, fn) => ipcMain.handle(name,(event,...args)=> {
    if (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame) throw new Error('Недопустимый источник запроса');
    return fn(...args);
  });
  const {SyncServer,LibraryCoordinator}=require('./sync.cjs');
  const {mergeDesktop}=await import('../src/core/sync.mjs');
  coordinator=new LibraryCoordinator(store);
  syncServer=new SyncServer({store,coordinator,onChange:state=>window?.webContents.send('sync:changed',{state,base:desktopBaseline})});
  handle('state:load',async()=>{desktopBaseline=await store.read('library.json',null);return desktopBaseline;});
  // Retire old OAuth credentials without ever restoring them or contacting Google.
  await store.write('google-secure.json',null);await store.write('google-secure.json',null);
  handle('sync:status',()=>syncServer.status());
  handle('sync:start',()=>syncServer.start());
  handle('sync:stop',()=>syncServer.stop());
  handle('sync:pair',()=>syncServer.newPairing());
  handle('sync:forget',()=>syncServer.forget());
  handle('sync:address',address=>syncServer.selectAddress(address));
  handle('sync:firewall',async()=>{if(!syncServer.server)throw new Error('Сначала включи синхронизацию.');await require('./sync-firewall.cjs').allowLocalSync(syncServer.server.address().port);return syncServer.status();});
  handle('sync:approve',async id=>{await syncServer.approvals.approve(id);return syncServer.status();});
  handle('sync:reject',async id=>{await syncServer.approvals.reject(id);return syncServer.status();});
  const saveState = async state => {
    if (!state || state.version!==1 || !state.tracks || !Array.isArray(state.likes) || !Array.isArray(state.events) || !Array.isArray(state.playlists) || JSON.stringify(state).length>25*1024**2) throw new Error('Некорректная библиотека');
    const {retireLegacyCatalog}=await import('../src/core/library-order.mjs');state=retireLegacyCatalog(state);
    const next=await coordinator.mutate(current=>mergeDesktop(current||state,desktopBaseline||state,state));
    desktopBaseline=structuredClone(state);
    if(JSON.stringify(next)!==JSON.stringify(state))window?.webContents.send('sync:changed',{state:next,base:state});
  };
  if((await store.read('sync-settings.json',{})).enabled)try{await syncServer.start();}catch{/* Retry from Settings when LAN becomes available. */}
  handle('state:save',saveState);
  handle('state:close',async state=> {
    await saveState(state);await coordinator.queue;await store.queue;clearTimeout(closeTimer);closing=true;window.close();
  });
  const { YouTubeCatalog } = await import('../src/core/youtube.mjs');
  const genreCatalog=new (require('./genre-catalog.cjs').GenreCatalog)((url,options)=>net.fetch(url,options));
  const catalog=new YouTubeCatalog(async()=>{
    const {Innertube}=await import('youtubei.js');
    return Innertube.create({lang:'en',location:'US',retrieve_player:false,generate_session_locally:true,fetch:(input,options={})=>{
      const url=new URL(typeof input==='string'?input:input.url||input.href);
      if(url.protocol!=='https:'||!(/(^|\.)youtube\.com$/.test(url.hostname)||url.hostname==='youtubei.googleapis.com'))throw new Error('Недопустимый адрес каталога.');
      const timeout=AbortSignal.timeout(18000);return net.fetch(input,{...options,signal:options.signal?AbortSignal.any([options.signal,timeout]):timeout});
    }});
  },{releaseLookup:artist=>genreCatalog.releases(artist)});
  handle('youtube:request',(route,params)=>catalog.request(route,params));
  const soundAudio=new (require('./sound-audio.cjs').SoundAudio)(net.fetch);
  handle('genre:metadata',track=>genreCatalog.lookup(track));
  handle('sound:audio',id=>soundAudio.load(id));
  handle('sound:cancel',()=>soundAudio.cancel());
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
  youtubeAudio=new (require('./youtube-audio.cjs').YouTubeAudio)((input,options)=>net.fetch(input,options),undefined,{fetchMedia:(input,options)=>require('./media-fetch.cjs').mediaFetch(net,input,options)});
  browserAudio=new (require('./browser-audio.cjs').BrowserAudio)({BrowserWindow,onState:state=>{if(window&&!window.isDestroyed())window.webContents.send('browser-audio:state',state);}});
  handle('browser-audio:command',command=>browserAudio.command(command));
  protocol.handle('forma-stream',async request=>{
    const u=new URL(request.url);
    if(u.hostname!=='youtube')return new Response(null,{status:404});
    const hls=u.pathname.match(/^\/([\w-]{11})\/hls\/([\w.-]+)$/);
    const response=await(hls?youtubeAudio.respondHls(hls[1],hls[2],request):youtubeAudio.respond(u.pathname.slice(1),request));
    const headers=new Headers(response.headers);headers.set('Access-Control-Allow-Origin','*');headers.set('Access-Control-Expose-Headers','Content-Length,Content-Range');
    return new Response(response.body,{status:response.status,headers});
  });
  handle('audio:sources',async id=> {
    if(typeof id!=='string')throw new Error('Некорректный трек');
    if(validId(id)&&offline.manifest[id])return [`forma-audio://track/${id}`];
    if(/^yt_[A-Za-z0-9_-]{11}$/.test(id)){const videoID=id.slice(3);if(browserAudio.preferred)return [`forma-browser://youtube/${videoID}`];const source=await youtubeAudio.resolve(videoID);return [`forma-stream://youtube/${videoID}${source.kind==='hls'?'/hls/index.m3u8':''}`];}
    throw new Error('Трек недоступен. Найди версию в поиске YouTube.');
  });
  handle('audio:error',id=>youtubeAudio.error(String(id).replace(/^yt_/,'')));
  handle('audio:prepare',ids=>{if(!Array.isArray(ids))throw new Error('Некорректная очередь');return browserAudio.preferred?0:youtubeAudio.prepare(ids.slice(0,3));});
  handle('offline:list',()=>offline.list());
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
  window = new BrowserWindow({width:1440,height:940,minWidth:1000,minHeight:680,frame:false,backgroundColor:'#050309',title:'Forma',icon:path.join(__dirname,'../build/icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false}});
  window.on('closed',()=>browserAudio?.close());
  window.on('close',event=> {
    if(closing)return;
    event.preventDefault();window.webContents.send('app:closing');
    clearTimeout(closeTimer);closeTimer=setTimeout(async()=>{await store.queue.catch(()=>{});closing=true;window.close();},3000);
  });
  const openPlayerLink = url => {
    const target = playerBrowserURL(url);
    if(target) shell.openExternal(target).catch(()=>console.error('Не удалось открыть браузер для YouTube.'));
  };
  window.webContents.setWindowOpenHandler(({url})=>{openPlayerLink(url);return {action:'deny'};});
  const localUI=await startStaticServer(path.join(__dirname,'../dist'));uiServer=localUI.server;const entry=localUI.url;
  window.webContents.on('will-navigate',(e,url)=>{if(url!==entry){e.preventDefault();openPlayerLink(url);}});
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,cb)=>cb(false));
  window.webContents.session.webRequest.onHeadersReceived((details,callback)=> {
    if(details.url===entry) callback({responseHeaders:{...details.responseHeaders,'Content-Security-Policy':["default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob: forma-audio:; media-src 'self' forma-stream: forma-audio: blob:; connect-src 'self' https: forma-stream:; object-src 'none'; base-uri 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com"]}});
    else callback({responseHeaders:details.responseHeaders});
  });
  app.setAppUserModelId(desktopAppID);
  window.webContents.session.webRequest.onBeforeSendHeaders({urls:['https://www.youtube.com/*','https://www.youtube-nocookie.com/*']},(details,callback)=>callback({requestHeaders:playerRequestHeaders(details,entry,desktopPlayerIdentity)}));
  await window.loadURL(entry);
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{syncServer?.stop({persist:false});uiServer?.close();youtubeAudio?.close();browserAudio?.close();for(const id of offline?.active.keys() || []) offline.cancel(id);});
