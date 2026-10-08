import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 const tracks=['abcdefghijk','12345678901','zyxwvutsrqp'].map((videoId,i)=>({id:'yt_'+videoId,videoId,title:'Song '+(i+1),artist:'Artist '+i,source:'youtube',genre:'House',streamable:true,duration:200,tags:[],relatedTo:[]}));
 const local={id:'local_test',title:'Local song',artist:'Local Artist',source:'local',genre:'House',streamable:true,duration:90,tags:[]};
 const s={version:1,tracks:Object.fromEntries([...tracks,local].map(t=>[t.id,t])),likes:[],playlists:[{id:'switching',name:'Switching test',trackIds:tracks.map(t=>t.id)}],events:[],hidden:[],settings:{provider:'youtube',repeatCooldown:0},onboarded:true};
 window.sourceCalls=0;window.forma={desktop:false,load:async()=>s,save:async()=>{},downloads:async()=>({local_test:{track:local,bytes:100}}),onProgress:()=>()=>{},onBeforeClose:()=>()=>{},catalogRequest:async()=>tracks,request:async()=>[],sources:async()=>{window.sourceCalls++;await new Promise(r=>setTimeout(r,500));return ['/test-audio.wav'];}};
 window.createdYT=0;window.YT={Player:class{
  constructor(node,options){this.options=options;this.id='';this.state=2;this.time=0;window.createdYT++;window.fixturePlayer=this;const frame=document.createElement('iframe');frame.src='about:blank';node.replaceWith(frame);this.frame=frame;setTimeout(()=>options.events.onReady({target:this}),500);}
  loadVideoById({videoId}){this.id=videoId;this.time=0;this.playVideo();}cueVideoById({videoId}){this.id=videoId;this.time=0;this.pauseVideo();}
  playVideo(){this.state=1;this.options.events.onStateChange({data:1});}pauseVideo(){this.state=2;this.options.events.onStateChange({data:2});}
  getCurrentTime(){return this.time;}getDuration(){return 200;}getPlayerState(){return this.state;}getVideoData(){return {video_id:this.id};}setVolume(v){this.volume=v;}seekTo(t){this.time=t;}destroy(){this.frame.remove();}
 }};
});
function wav(){const b=Buffer.alloc(44+8000*2*90);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;}
await page.route('**/test-audio.wav',route=>route.fulfill({contentType:'audio/wav',body:wav()}));
try{
 await page.goto(process.env.FORMA_TEST_URL||'http://localhost:5173');
 await page.locator('.sidebar-playlists').getByRole('button',{name:'Switching test'}).click();
 await page.getByRole('button',{name:'Слушать Song 1',exact:true}).click();await page.waitForFunction(()=>Boolean(window.fixturePlayer));
 await page.keyboard.press('Space');await page.waitForTimeout(600);assert.equal(await page.evaluate(()=>window.fixturePlayer.getPlayerState()),2,'pause before ready must prevent autoplay');
 await page.getByRole('button',{name:'Воспроизвести',exact:true}).click();await page.waitForFunction(()=>window.fixturePlayer.getPlayerState()===1);
 const iframe=await page.locator('.youtube-frame iframe').elementHandle();
 await page.getByRole('button',{name:'Следующий трек',exact:true}).click();await page.waitForFunction(()=>window.fixturePlayer.id==='12345678901');
 await page.getByRole('button',{name:'Следующий трек',exact:true}).click();await page.waitForFunction(()=>window.fixturePlayer.id==='zyxwvutsrqp');
 assert.equal(await page.evaluate(()=>window.createdYT),1);assert.equal(await iframe.evaluate(node=>node.isConnected),true);
 await page.evaluate(()=>window.fixturePlayer.options.events.onStateChange({data:0}));
 assert.equal(await page.evaluate(()=>window.fixturePlayer.id),'zyxwvutsrqp','stale ended event must not advance a playing track');
 await page.evaluate(()=>window.fixturePlayer.pauseVideo());await page.getByRole('button',{name:'Воспроизвести',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.fixturePlayer.getPlayerState()),1,'pause inside iframe must be resumable in one click');
 await page.getByRole('button',{name:'Скачанное',exact:true}).click();await page.getByRole('button',{name:'Слушать Local song',exact:true}).click();
 await page.keyboard.press('Space');await page.waitForTimeout(650);
 assert.equal(await page.locator('audio').evaluate(a=>a.paused),true,'pause while resolving a local source must remain paused');
 assert.equal(await page.locator('.youtube-panel').isVisible(),false);assert.equal(await iframe.evaluate(node=>node.isConnected),true);
 await page.getByRole('button',{name:'Воспроизвести',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('audio').paused);
 await page.getByRole('button',{name:'Следующий трек',exact:true}).click();assert.equal(await page.locator('audio').evaluate(a=>a.paused),true);
 await page.getByRole('button',{name:'Воспроизвести',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('audio').paused);
 await page.locator('.sidebar-playlists').getByRole('button',{name:'Switching test'}).click();await page.getByRole('button',{name:'Слушать Song 1',exact:true}).click();
 await page.waitForFunction(()=>window.fixturePlayer.id==='abcdefghijk'&&window.fixturePlayer.getPlayerState()===1);
 assert.equal(await page.evaluate(()=>window.createdYT),1,'YouTube player must survive local playback');assert.equal(await page.evaluate(()=>window.sourceCalls),1);
 assert.deepEqual(errors,[]);console.log('PASS: one persistent iframe, consecutive switching, stale end ignored, iframe pause/resume, pause before readiness/source resolution, local interlude and cached sources (mocked player/transport).');
}finally{await browser.close();}
