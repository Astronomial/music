const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Store } = require('./storage.cjs');
const { OfflineLibrary, validId } = require('./offline.cjs');
protocol.registerSchemesAsPrivileged([{scheme:'forma-audio', privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true}}]);
let window, store, offline, api, apiKey = '', closing = false, closeTimer;
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
  protocol.handle('forma-audio', request => { const url = new URL(request.url); return url.hostname==='track' ? offline.respond(url.pathname.slice(1),request.headers.get('range')) : new Response(null,{status:404}); });
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
  handle('window:control',action=> { if(action==='minimize') window.minimize(); if(action==='maximize') window.isMaximized()?window.unmaximize():window.maximize(); if(action==='close') window.close(); });
  window = new BrowserWindow({width:1440,height:940,minWidth:1000,minHeight:680,frame:false,backgroundColor:'#101110',title:'Forma',icon:path.join(__dirname,'../build/icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.on('close',event=> {
    if(closing)return;
    event.preventDefault();window.webContents.send('app:closing');
    clearTimeout(closeTimer);closeTimer=setTimeout(async()=>{await store.queue.catch(()=>{});closing=true;window.close();},3000);
  });
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  const entry = pathToFileURL(path.join(__dirname,'../dist/index.html')).href;
  window.webContents.on('will-navigate',(e,url)=>{if(url!==entry)e.preventDefault();});
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,cb)=>cb(false));
  window.webContents.session.webRequest.onHeadersReceived((details,callback)=> {
    if(details.url===entry) callback({responseHeaders:{...details.responseHeaders,'Content-Security-Policy':["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; media-src 'self' https: forma-audio: blob:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-src 'none'"]}});
    else callback({responseHeaders:details.responseHeaders});
  });
  await window.loadFile(path.join(__dirname,'../dist/index.html'));
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{for(const id of offline?.active.keys() || []) offline.cancel(id);});
