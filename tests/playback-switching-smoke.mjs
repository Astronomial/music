import {chromium} from '@playwright/test';
import {installAudioFixture} from './audio-fixture.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 const tracks=['abcdefghijk','12345678901','zyxwvutsrqp'].map((videoId,i)=>({id:'yt_'+videoId,videoId,title:'Song '+(i+1),artist:'Artist '+i,source:'youtube',genre:'House',streamable:true,duration:200,tags:[],relatedTo:[]}));
 const local={id:'local_test',title:'Local song',artist:'Local Artist',source:'local',genre:'House',streamable:true,duration:90,tags:[]};
 const s={version:1,tracks:Object.fromEntries([...tracks,local].map(t=>[t.id,t])),likes:[],playlists:[{id:'switching',name:'Switching test',trackIds:tracks.map(t=>t.id)}],events:[],hidden:[],settings:{provider:'youtube',repeatCooldown:0},onboarded:true};
 window.forma={desktop:false,load:async()=>s,save:async()=>{},downloads:async()=>({local_test:{track:local,bytes:100}}),catalogRequest:async()=>tracks};
});
await page.addInitScript(installAudioFixture);
await page.addInitScript(()=>{const original=window.forma.sources;window.sourceCalls=0;window.forma.sources=async id=>{window.sourceCalls++;await new Promise(r=>setTimeout(r,id==='yt_abcdefghijk'?650:100));return original(id);};});
try{
 await page.goto(process.env.FORMA_TEST_URL||'http://localhost:5173');
 await page.locator('.sidebar-playlists').getByRole('button',{name:'Switching test'}).click();
 await page.getByRole('button',{name:'Слушать Song 1',exact:true}).click();
 await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('Space');await page.waitForTimeout(800);
 assert.equal(await page.locator('audio').evaluate(a=>a.paused),true,'pause before source resolution must prevent autoplay');
 await page.getByRole('button',{name:'Воспроизвести',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('audio').paused);
 const element=await page.locator('audio').elementHandle();
 await page.getByRole('button',{name:'Слушать Song 1',exact:true}).click();
 await page.getByRole('button',{name:'Слушать Song 2',exact:true}).click();
 await page.waitForFunction(()=>window.nativeAudio.id==='12345678901'&&window.nativeAudio.state===1);
 await page.getByRole('button',{name:'Следующий трек',exact:true}).click();await page.waitForFunction(()=>window.nativeAudio.id==='zyxwvutsrqp'&&window.nativeAudio.state===1);
 await page.evaluate(()=>document.querySelector('audio').dispatchEvent(new Event('ended')));assert.equal(await page.evaluate(()=>window.nativeAudio.id),'zyxwvutsrqp','stale ended event must not advance a playing track');
 await page.getByRole('button',{name:'Скачанное',exact:true}).click();await page.getByRole('button',{name:'Слушать Local song',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('audio').paused);assert.equal(await element.evaluate(a=>a===document.querySelector('audio')),true);
 await page.getByRole('button',{name:'Следующий трек',exact:true}).click();assert.equal(await page.locator('audio').evaluate(a=>a.paused),true);
 await page.getByRole('button',{name:'Воспроизвести',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('audio').paused);
 await page.locator('.sidebar-playlists').getByRole('button',{name:'Switching test'}).click();await page.getByRole('button',{name:'Слушать Song 1',exact:true}).click();await page.waitForFunction(()=>window.nativeAudio.id==='abcdefghijk'&&window.nativeAudio.state===1);
 assert.equal(await page.locator('iframe,video,.youtube-panel').count(),0);assert.equal(await element.evaluate(a=>a===document.querySelector('audio')),true);
 assert.deepEqual(errors,[]);console.log('PASS: real audio decode, pause before resolution, rapid selection, stable audio element, stale ended ignored, local interlude and resume; no video.');
}finally{await browser.close();}
