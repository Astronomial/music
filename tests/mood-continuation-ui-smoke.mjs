import {chromium} from '@playwright/test';
import {installAudioFixture} from './audio-fixture.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 const song=i=>({id:'yt_'+String(i).padStart(11,'0'),videoId:String(i).padStart(11,'0'),title:'Тихая запись '+i,artist:'Артист '+i,artistId:'artist'+i,source:'youtube',genre:'Pop',mood:'calm',streamable:true,duration:200,tags:[]});
 const tracks=Array.from({length:25},(_,i)=>song(i));
 const wrong={...song(900),mood:'energetic',title:'Громкая запись'};
 const state={version:1,tracks:Object.fromEntries([...tracks,wrong].map(t=>[t.id,t])),likes:tracks.slice(0,3).map(t=>t.id),playlists:[],events:[],hidden:[],settings:{recommendationVersion:2,discovery:.7,repeatCooldown:24,artistDiversity:.6},onboarded:true};
 window.remotePage=0;window.remoteCalls=0;window.remoteDelay=0;
 window.forma={desktop:false,load:async()=>state,save:async s=>{window.saved=s;},downloads:async()=>({}),catalogRequest:async()=>{
  if(!window.remotePage)return [];
  window.remoteCalls++;const batch=window.remotePage;
  if(window.remoteDelay)await new Promise(r=>setTimeout(r,window.remoteDelay));
  return Array.from({length:3},(_,i)=>song(1000+batch*10+i));
 }};
});
await page.addInitScript(installAudioFixture);
try{
 await page.goto(process.env.FORMA_TEST_URL||'http://localhost:5173');
 await page.locator('.mix-card').filter({hasText:'Спокойствие'}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.track-row').length===25);
 assert.equal(await page.getByText('Громкая запись',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Слушать подборку',exact:true}).click();
 const seen=new Set();
 for(let i=0;i<25;i++){
  await page.waitForFunction(previous=>window.nativeAudio?.state===1&&window.nativeAudio.id!==previous,i?Array.from(seen).at(-1):null);
  const id=await page.evaluate(()=>window.nativeAudio.id);assert.ok(!seen.has(id));seen.add(id);
  if(i<24)await page.getByRole('button',{name:'Следующий трек',exact:true}).click();
 }
 await page.evaluate(()=>{window.remotePage=1;});
 await page.getByRole('button',{name:'Следующий трек',exact:true}).click();
 await page.waitForFunction(()=>window.nativeAudio?.state===1&&Number(window.nativeAudio.id)>=1010);
 await page.waitForFunction(()=>window.saved?.events?.some(e=>e.type==='play'&&e.trackId==='yt_'+window.nativeAudio?.id&&e.surface==='mood'));
 const log=await page.evaluate(()=>window.saved.events);
 assert.ok(log.filter(e=>e.type==='play').every(e=>e.surface==='mood'));
 assert.ok(await page.evaluate(()=>window.remoteCalls>0));
 // Exhaust the three new recordings, then pause while the next radio is loading.
 for(let i=0;i<2;i++){const previous=await page.evaluate(()=>window.nativeAudio.id);await page.getByRole('button',{name:'Следующий трек',exact:true}).click();await page.waitForFunction(id=>window.nativeAudio.state===1&&window.nativeAudio.id!==id,previous);}
 await page.evaluate(()=>{window.remotePage=2;window.remoteDelay=400;});
 await page.getByRole('button',{name:'Следующий трек',exact:true}).click();await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('Space');
 await page.waitForTimeout(1400);
 assert.equal(await page.locator('audio').evaluate(a=>a.paused),true,'A late mood refill must respect Pause');
 assert.deepEqual(errors,[]);
 console.log('PASS: 25 mood-verified tracks, no incompatible fill, exhausted collection fetches fresh neighbours, mood feedback retained, Pause cancels delayed refill autoplay.');
}finally{await browser.close();}
