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
await fs.writeFile(path.join(dir,'library.json'),JSON.stringify({version:1,tracks:{},likes:[],playlists:[],events:[],hidden:[],settings:{provider:'audius'},onboarded:true}));
const executable=process.env.FORMA_ELECTRON_PATH||path.join(project,'node_modules/electron/dist/electron');
const desktopEnv={...process.env,XDG_CONFIG_HOME:dir,XDG_CACHE_HOME:path.join(dir,'cache')};
const track={id:'DesktopTest',title:'Offline integration test',user:{id:'ArtistOne',name:'Test artist'},genre:'House',duration:20,is_downloadable:true,is_streamable:true};
function wav(){const b=Buffer.alloc(320044);b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;}
let app;
async function launch(){
  const instance=await _electron.launch({executablePath:executable,args:['--no-sandbox','--disable-gpu',project,`--forma-test-data=${dir}`],env:desktopEnv});
  const page=await instance.firstWindow();await page.waitForLoadState();return{instance,page};
}
try{
  let launched=await launch();app=launched.instance;let page=launched.page;
  await app.evaluate(({net},{track,audio,youtubeFixture})=>{
    // Replace the main-process transport only in this test; production has no fixtures.
    net.fetch=async url=>{
      const parsed=new URL(typeof url==='string'?url:url.url);const path=parsed.pathname;
      if(parsed.hostname==='api.music.yandex.net')return Response.json({result:{title:'Public playlist',trackCount:1,tracks:[{track:{title:'Soft Focus',artists:[{name:'Test Artist'}],durationMs:200000}}]}});
      if(path.endsWith('/search')&&parsed.hostname.includes('youtube'))return Response.json(youtubeFixture);
      if(path.endsWith('/download'))return new Response(Buffer.from(audio,'base64'),{headers:{'content-length':String(Buffer.from(audio,'base64').length)}});
      return Response.json({data:/\/tracks\/DesktopTest$/.test(path)?track:[track]});
    };
  },{track,audio:wav().toString('base64'),youtubeFixture:musicSearchResponse()});
  assert.equal(await page.evaluate(()=>window.forma.desktop),true);
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  const yt=await page.evaluate(()=>window.forma.catalogRequest('/tracks/search',{query:'Soft Focus'},'youtube'));assert.equal(yt[0].source,'youtube');assert.equal(yt[0].artist,'Test Artist');
  const yandex=await page.evaluate(()=>window.forma.yandexPlaylist('https://music.yandex.ru/users/test/playlists/1'));assert.equal(yandex.tracks[0].title,'Soft Focus');

  await page.locator('.track-row').first().waitFor();
  await page.getByRole('button',{name:'Скачать Offline integration test',exact:true}).click();
  await expect.poll(async()=>Object.keys(await page.evaluate(()=>window.forma.downloads())).length).toBe(1);
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
  // The official player API is replaced here to isolate Forma's native window handling.
  await page.evaluate(()=>{window.YT={Player:class{
    constructor(node,options){this.options=options;this.id=options.videoId;this.state=2;this.time=0;const frame=document.createElement('iframe');frame.src='about:blank';node.replaceWith(frame);this.frame=frame;this.timer=setInterval(()=>{if(this.state===1)this.time+=.25;},250);setTimeout(()=>options.events.onReady({target:this}),20);window.testYTPlayer=this;}
    loadVideoById({videoId}){this.id=videoId;this.time=0;this.playVideo();}cueVideoById({videoId}){this.id=videoId;this.time=0;this.pauseVideo();}
    playVideo(){this.state=1;this.options.events.onStateChange({data:1});}pauseVideo(){this.state=2;this.options.events.onStateChange({data:2});}getPlayerState(){return this.state;}getCurrentTime(){return this.time;}getDuration(){return 200;}getVideoData(){return{video_id:this.id};}seekTo(t){this.time=t;}setVolume(){}destroy(){clearInterval(this.timer);this.frame.remove();}
  }};});
  await page.getByRole('button',{name:'Настройки',exact:true}).click();
  await page.getByRole('button',{name:'YouTube',exact:true}).click();
  await page.getByRole('textbox',{name:'Поиск треков и исполнителей',exact:true}).fill('Soft Focus');
  await page.locator('.track-name').filter({hasText:'Soft Focus'}).first().click();
  await page.waitForFunction(()=>window.testYTPlayer?.getCurrentTime()>.5);
  const youtubeTime=await page.evaluate(()=>window.testYTPlayer.getCurrentTime());
  await page.getByRole('button',{name:'Свернуть',exact:true}).click();
  await page.waitForFunction(t=>window.testYTPlayer.getPlayerState()===1&&window.testYTPlayer.getCurrentTime()>t+.8,youtubeTime);
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.restore();w.show();w.focus();});
  await page.getByRole('button',{name:'Пауза',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.testYTPlayer.getPlayerState()),2);
  await expect.poll(async()=>{const s=await page.evaluate(()=>window.forma.load());return s.importRequests?.find(r=>r.id==='astronomial-favorites')?.status;}).toBe('complete');
  const transferred=await page.evaluate(()=>window.forma.load());
  const requested=transferred.playlists.find(p=>p.id==='astronomial-favorites');
  assert.equal(requested.trackIds.length,1);assert.equal(transferred.tracks[requested.trackIds[0]].title,'Soft Focus');
  assert.equal(transferred.tracks[requested.trackIds[0]].source,'youtube');
  await page.getByRole('button',{name:'Настройки',exact:true}).click();
  await page.getByRole('switch',{name:'Только скачанная музыка'}).click();
  // Exercise the real preload -> main -> TLS server -> renderer merge path.
  await page.getByRole('button',{name:'Подключить iPhone',exact:true}).click();
  await expect.poll(async()=> (await page.evaluate(()=>window.forma.syncStatus())).enabled).toBe(true);
  const status=await page.evaluate(()=>window.forma.syncStatus());assert.equal(status.enabled,true);
  const pairing=new URL(status.pairing),identity=JSON.parse(await fs.readFile(path.join(dir,'sync-identity.json'),'utf8'));
  const syncRequest=(route,body,token)=>new Promise((resolve,reject)=>{const request=https.request({hostname:pairing.searchParams.get('host'),port:pairing.searchParams.get('port'),path:route,method:'POST',ca:identity.cert,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}},response=>{const buffers=[];response.on('data',b=>buffers.push(b));response.on('end',()=>{if(response.statusCode!==200)return reject(new Error('Sync HTTP '+response.statusCode));resolve(JSON.parse(Buffer.concat(buffers)));});});request.on('error',reject);request.end(JSON.stringify(body));});
  const paired=await syncRequest('/pair',{code:pairing.searchParams.get('code'),name:'Integration iPhone'});
  const syncBase=portableLibrary(await page.evaluate(()=>window.forma.load())),phone=structuredClone(syncBase);
  phone.playlists.push({id:'phone-playlist',name:'С телефона 🎵',trackIDs:[yt[0].videoId]});phone.likedIDs=[yt[0].videoId];phone.settings.artistDiversity=1;
  await syncRequest('/sync',{base:syncBase,library:phone},paired.token);
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
  const afterRestart=await syncRequest('/sync',{base:syncBase,library:phone},paired.token);assert.ok(afterRestart.library.playlists.some(p=>p.id==='phone-playlist'));
  await page.getByRole('button',{name:'Скачанное',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.track-row').length===2);
  await page.locator('.track-name').first().click();
  await page.waitForFunction(()=>document.querySelector('audio').currentTime>0.5);
  await page.getByRole('button',{name:'Пауза',exact:true}).click();
  await page.locator('.track-row').first().locator('.track-actions button').last().click();
  await page.getByRole('button',{name:'Удалить скачанный файл',exact:true}).click();
  await expect.poll(async()=>Object.keys(await page.evaluate(()=>window.forma.downloads())).length).toBe(1);
  console.log('PASS: real Electron sandbox/preload, minimized playback (real local audio + mocked YouTube player), explicit pause, catalogue and Yandex IPC and automatic requested-playlist import across restart (mock transport), file import, IPC download, audio seeking, close-save, restart offline, deletion.');
}finally{if(app)await app.close();await fs.rm(dir,{recursive:true,force:true});}
