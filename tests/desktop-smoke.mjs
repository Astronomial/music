import crypto from 'node:crypto';
import { _electron,expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {portableLibrary} from '../src/core/sync.mjs';
import {musicSearchResponse} from './fixtures-youtube.mjs';
const project=path.resolve('.');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forma-desktop-'));
await fs.writeFile(path.join(dir,'library.json'),JSON.stringify({version:1,tracks:{},likes:[],playlists:[],events:[],hidden:[],settings:{provider:'audius',audioAnalysis:false},onboarded:true}));
const executable=process.env.FORMA_ELECTRON_PATH||path.join(project,'node_modules/electron/dist',process.platform==='win32'?'electron.exe':'electron');
const desktopEnv={...process.env,XDG_CONFIG_HOME:dir,XDG_CACHE_HOME:path.join(dir,'cache')};
const track={id:'DesktopTest',title:'Offline integration test',user:{id:'ArtistOne',name:'Test artist'},genre:'House',duration:20,is_downloadable:true,is_streamable:true};
function wav(){const b=Buffer.alloc(320044);b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;}
const offlineTrack={id:'DesktopTest',title:'Offline integration test',artist:'Test artist',genre:'House',duration:20,source:'legacy',streamable:true,downloadable:true};
await fs.mkdir(path.join(dir,'Music'),{recursive:true});
await fs.writeFile(path.join(dir,'Music','DesktopTest.audio'),wav());
await fs.writeFile(path.join(dir,'Music','downloads.json'),JSON.stringify({DesktopTest:{track:offlineTrack,bytes:wav().length,mime:'audio/wav',savedAt:1}}));
let app;
async function launch(){
  const instance=await _electron.launch({executablePath:executable,args:['--no-sandbox','--disable-gpu',...(process.platform==='linux'&&!process.env.DISPLAY?['--ozone-platform=headless']:[]),project,`--forma-test-data=${dir}`],env:desktopEnv});
  const page=await instance.firstWindow();await page.waitForLoadState();return{instance,page};
}
try{
  let launched=await launch();app=launched.instance;let page=launched.page;
  await app.evaluate(({net},{track,audio,streamAudio,youtubeFixture})=>{
    // Replace the main-process transport only in this test; production has no fixtures.
    net.fetch=async (url,options={})=>{
      const parsed=new URL(typeof url==='string'?url:url.url);const path=parsed.pathname;
      if(parsed.hostname==='api.music.yandex.net')return Response.json({result:{title:'Public playlist',trackCount:1,tracks:[{track:{title:'Soft Focus',artists:[{name:'Test Artist'}],durationMs:200000}}]}});
      if(path.endsWith('/player')){const videoId=JSON.parse(options.body).videoId;return Response.json({playabilityStatus:{status:'OK'},videoDetails:{videoId,title:'Native fixture',author:'Test Artist',lengthSeconds:'20'},streamingData:{expiresInSeconds:'3600',adaptiveFormats:[{itag:140,url:'https://r1.googlevideo.com/native-audio',mimeType:'audio/mp4; codecs="mp4a.40.2"',bitrate:128000,contentLength:String(Buffer.from(streamAudio,'base64').length),audioQuality:'AUDIO_QUALITY_MEDIUM',approxDurationMs:'12000'}]}});}
      if(parsed.hostname==='r1.googlevideo.com')return new Response(null,{status:302,headers:{location:'https://r2.googlevideo.com/native-audio'}});
      if(parsed.hostname==='r2.googlevideo.com'){const bytes=Buffer.from(streamAudio,'base64'),range=parsed.searchParams.get('range'),[start,end]=range?range.split('-').map(Number):[0,bytes.length-1],part=bytes.subarray(start,Math.min(end+1,bytes.length));return new Response(part,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(part.length)}});}
      if(path.endsWith('/search')&&parsed.hostname.includes('youtube'))return Response.json(youtubeFixture);
      if(path.endsWith('/download'))return new Response(Buffer.from(audio,'base64'),{headers:{'content-length':String(Buffer.from(audio,'base64').length)}});
      return Response.json({data:/\/tracks\/DesktopTest$/.test(path)?track:[track]});
    };
  },{track,audio:wav().toString('base64'),streamAudio:(await fs.readFile(path.join(project,'tests/fixtures/acoustic-sample.m4a'))).toString('base64'),youtubeFixture:musicSearchResponse()});
  assert.equal(await page.evaluate(()=>window.forma.desktop),true);
  const scriptResult=await app.evaluate(async({app})=>{const req=process.getBuiltinModule('module').createRequire(process.getBuiltinModule('path').join(app.getAppPath(),'electron/main.cjs'));return req('./signature-runtime.cjs').evaluateSignature({output:'return {n:typeof process+":"+typeof require+":"+typeof fetch};'});});assert.equal(scriptResult.n,'undefined:undefined:undefined');
  const packed=path.join(project,'release/win-unpacked/resources/app.asar');
  if(process.platform==='win32'){const packedResult=await app.evaluate(async(_electron,file)=>{const req=process.getBuiltinModule('module').createRequire(file+'/electron/main.cjs');return req('./signature-runtime.cjs').evaluateSignature({output:'return {n:"asar-wasm-ok"};'});},packed);assert.equal(packedResult.n,'asar-wasm-ok');}

  await app.evaluate(({shell})=>{globalThis.playerBrowserCalls=[];shell.openExternal=async url=>{globalThis.playerBrowserCalls.push(url);};});
  for(const url of ['https://accounts.google.com/ServiceLogin?service=youtube','https://www.youtube.com/watch?v=abcdefghijk']){
    await page.evaluate(url=>window.open(url,'_blank'),url);
    await expect.poll(async()=>await app.evaluate((_electron,url)=>globalThis.playerBrowserCalls.includes(url),url)).toBe(true);
  }
  const browserCalls=await app.evaluate(()=>globalThis.playerBrowserCalls.length);
  for(const url of ['https://accounts.google.com.evil.test/','file:///etc/passwd','javascript:alert(1)'])await page.evaluate(url=>window.open(url,'_blank'),url);
  await page.waitForTimeout(100);
  assert.equal(await app.evaluate(()=>globalThis.playerBrowserCalls.length),browserCalls);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);

  const sample=[...await fs.readFile(path.join(project,'tests/fixtures/acoustic-sample.m4a'))];
  const decoded=await page.evaluate(async bytes=>{const c=new OfflineAudioContext(1,1,16000),audio=await c.decodeAudioData(new Uint8Array(bytes).buffer);return {duration:audio.duration,rate:audio.sampleRate};},sample);
  assert.ok(decoded.duration>=12);assert.equal(decoded.rate,16000);
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  const yt=await page.evaluate(()=>window.forma.catalogRequest('/tracks/search',{query:'Soft Focus'},'youtube'));assert.equal(yt[0].source,'youtube');assert.equal(yt[0].artist,'Test Artist');
  const yandex=await page.evaluate(()=>window.forma.yandexPlaylist('https://music.yandex.ru/users/test/playlists/1'));assert.equal(yandex.tracks[0].title,'Soft Focus');

  assert.equal(await page.evaluate(()=>typeof window.forma.request),'undefined');
  await page.getByRole('button',{name:'Скачанное',exact:true}).click();
  await page.locator('.track-name').first().click();
  await page.waitForFunction(()=>document.querySelector('audio').currentTime>1.6);
  assert.match(await page.locator('audio').evaluate(a=>a.src),/^forma-audio:/);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling()),false);
  const localTime=await page.locator('audio').evaluate(a=>a.currentTime);
  await page.getByRole('button',{name:'Свернуть',exact:true}).click();
  await page.waitForFunction(t=>!document.querySelector('audio').paused&&document.querySelector('audio').currentTime>t+.8,localTime);
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.restore();w.show();w.focus();});
  await page.locator('audio').evaluate(a=>a.currentTime=12);
  await page.waitForFunction(()=>document.querySelector('audio').currentTime>12);
  await page.getByRole('button',{name:'Нравится текущий трек',exact:true}).click();
  const localPath=path.join(dir,'Local Artist — Local Song.wav');await fs.writeFile(localPath,wav());
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},localPath);
  await page.getByRole('button',{name:'Добавить файлы',exact:true}).click();
  await expect.poll(async()=>Object.values(await page.evaluate(()=>window.forma.downloads())).some(f=>f.track.source==='local')).toBe(true);await fs.rm(localPath);
  await page.getByRole('textbox',{name:'Поиск треков и исполнителей',exact:true}).fill('Soft Focus');
  await page.locator('.track-name').filter({hasText:'Soft Focus'}).first().click();
  await page.waitForFunction(()=>document.querySelector('audio').currentTime>.5);
  assert.match(await page.locator('audio').evaluate(a=>a.src),/^forma-stream:\/\/youtube\//);
  assert.equal(await page.locator('iframe,video,.youtube-panel').count(),0);
  await page.getByRole('slider',{name:'Позиция воспроизведения'}).fill('5');await page.waitForFunction(()=>document.querySelector('audio').currentTime>=5);
  const youtubeTime=await page.locator('audio').evaluate(a=>a.currentTime);
  await page.getByRole('button',{name:'Свернуть',exact:true}).click();
  await page.waitForFunction(t=>!document.querySelector('audio').paused&&document.querySelector('audio').currentTime>t+.8,youtubeTime);
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.restore();w.show();w.focus();});
  await page.getByRole('button',{name:'Пауза',exact:true}).click();
  assert.equal(await page.locator('audio').evaluate(a=>a.paused),true);
  await expect.poll(async()=>{const s=await page.evaluate(()=>window.forma.load());return s.importRequests?.find(r=>r.id==='astronomial-favorites')?.status;}).toBe('complete');
  const transferred=await page.evaluate(()=>window.forma.load());
  const requested=transferred.playlists.find(p=>p.id==='astronomial-favorites');
  assert.equal(requested.trackIds.length,1);assert.equal(transferred.tracks[requested.trackIds[0]].title,'Soft Focus');
  assert.equal(transferred.tracks[requested.trackIds[0]].source,'youtube');
  await page.getByRole('button',{name:'Настройки',exact:true}).click();
  await page.getByRole('switch',{name:'Только скачанная музыка'}).click();
  await expect(page.getByRole('heading',{name:'iPhone и ПК · Wi-Fi',exact:true})).toBeVisible();
  assert.equal(await page.evaluate(()=>typeof window.forma.googleStatus),'undefined');
  await page.evaluate(()=>window.forma.syncStart());
  await expect.poll(async()=> (await page.evaluate(()=>window.forma.syncStatus())).enabled).toBe(true);
  const status=await page.evaluate(()=>window.forma.syncStatus());assert.equal(status.enabled,true);
  const pairing=new URL(status.pairing),identity=JSON.parse(await fs.readFile(path.join(dir,'sync-identity.json'),'utf8'));
  const syncRequest=(route,body,token)=>new Promise((resolve,reject)=>{const request=https.request({hostname:pairing.searchParams.get('host'),port:pairing.searchParams.get('port'),path:route,method:'POST',ca:identity.cert,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}},response=>{const buffers=[];response.on('data',b=>buffers.push(b));response.on('end',()=>{if(response.statusCode!==200)return reject(new Error('Sync HTTP '+response.statusCode));resolve(JSON.parse(Buffer.concat(buffers)));});});request.on('error',reject);request.end(JSON.stringify(body));});
  const paired=await syncRequest('/pair',{code:pairing.searchParams.get('code'),name:'Integration iPhone'});
  await expect.poll(async()=> (await page.evaluate(()=>window.forma.load())).settings.offlineOnly).toBe(true);
  const syncBase=portableLibrary(await page.evaluate(()=>window.forma.load())),phone=structuredClone(syncBase);
  phone.playlists.push({id:'phone-playlist',name:'С телефона 🎵',trackIDs:[yt[0].videoId]});phone.likedIDs=[yt[0].videoId];phone.settings.artistDiversity=1;
  const draft=await syncRequest('/sync/prepare',{id:crypto.randomUUID(),base:syncBase,library:phone},paired.token);
  assert.equal((await page.evaluate(()=>window.forma.load())).playlists.some(p=>p.id==='phone-playlist'),false);
  await page.getByRole('button',{name:'Применить на обоих устройствах',exact:true}).click();
  assert.equal((await syncRequest('/sync/status',{id:draft.id},paired.token)).status,'approved');
  await expect.poll(async()=>{const current=await page.evaluate(()=>window.forma.load());return current.playlists.some(p=>p.id==='phone-playlist');}).toBe(true);
  await expect(page.getByRole('button',{name:/^С телефона 🎵/})).toBeVisible();
  assert.equal(Object.keys(await page.evaluate(()=>window.forma.downloads())).length,2);
  const dataPath=await app.evaluate(({app})=>app.getPath('userData'));
  const exited=new Promise(resolve=>app.process().once('exit',resolve));
  await page.evaluate(()=>window.forma.windowControl('close'));
  await exited;app=null;
  const saved=JSON.parse(await fs.readFile(path.join(dataPath,'library.json'),'utf8'));
  assert.ok(saved.likes.includes('DesktopTest'));assert.equal(saved.settings.offlineOnly,true);assert.ok(saved.events.some(e=>e.type==='listen'));
  assert.equal(saved.playlists.filter(p=>p.id==='astronomial-favorites').length,1);
  assert.ok(saved.playlists.some(p=>p.id==='phone-playlist'));assert.equal(saved.settings.artistDiversity,1);assert.ok(saved.likes.includes(yt[0].id));
  launched=await launch();app=launched.instance;page=launched.page;
  await expect.poll(async()=>{const s=await page.evaluate(()=>window.forma.load());return s.importRequests?.find(r=>r.id==='astronomial-favorites')?.status;}).toBe('complete');
  assert.equal((await page.evaluate(()=>window.forma.syncStatus())).enabled,true);
  await page.evaluate(()=>window.forma.syncStart());
  const afterRestart=await syncRequest('/sync/status',{id:draft.id},paired.token);assert.ok(afterRestart.library.playlists.some(p=>p.id==='phone-playlist'));
  await page.getByRole('button',{name:'Скачанное',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.track-row').length===2);
  await page.locator('.track-name').first().click();
  await page.waitForFunction(()=>document.querySelector('audio').currentTime>0.5);
  await page.getByRole('button',{name:'Пауза',exact:true}).click();
  await page.locator('.track-row').first().locator('.track-actions button').last().click();
  await page.getByRole('button',{name:'Удалить скачанный файл',exact:true}).click();
  await expect.poll(async()=>Object.keys(await page.evaluate(()=>window.forma.downloads())).length).toBe(1);
  // A damaged primary and backup must open a recovery screen, never an empty autosaved profile.
  await app.close();app=null;
  await fs.writeFile(path.join(dir,'library.json'),'damaged primary');await fs.writeFile(path.join(dir,'library.json.bak'),'damaged backup');
  await fs.writeFile(path.join(dir,'sync-settings.json'),JSON.stringify({enabled:false}));
  launched=await launch();app=launched.instance;page=launched.page;
  await expect(page.getByRole('heading',{name:'Библиотека не загрузилась'})).toBeVisible();await page.waitForTimeout(350);
  assert.equal(await fs.readFile(path.join(dir,'library.json'),'utf8'),'damaged primary');assert.equal(await fs.readFile(path.join(dir,'library.json.bak'),'utf8'),'damaged backup');
  await fs.writeFile(path.join(dir,'library.json'),JSON.stringify(saved));await page.getByRole('button',{name:'Повторить загрузку'}).click();
  await expect(page.locator('.sidebar')).toBeVisible();assert.ok((await page.evaluate(()=>window.forma.load())).likes.includes('DesktopTest'));
  console.log('PASS: real Electron sandbox/preload, native AAC playback through CDN redirect/query ranges, isolated signature runtime and Wi-Fi settings and approval on PC, draft does not modify library, pinned TLS/token and approved receipt survive restart, minimized playback (real local audio + real native YouTube audio protocol with controlled extractor/HTTP), explicit pause, catalogue and Yandex IPC and automatic requested-playlist import across restart (mock transport), file import, legacy downloaded file preservation, audio seeking, close-save, restart offline, deletion, damaged-profile protection and retry recovery.');
}finally{if(app)await app.close();await fs.rm(dir,{recursive:true,force:true});}
