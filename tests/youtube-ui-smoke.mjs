import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 const songs=[['abcdefghijk','Soft Focus'],['12345678901','Night Current'],['abcdefghijkl'.slice(0,11),'Soft Focus']].slice(0,2).map(([videoId,title])=>({id:'yt_'+videoId,videoId,title,artist:'Test Artist',artistId:'yt_UCabcdefghijklmnop',source:'youtube',genre:'House',streamable:true,downloadable:false,duration:200,tags:[],relatedTo:[]}));
 let state=JSON.parse(localStorage.getItem('youtube-test-library')||'null')||{version:1,tracks:{},likes:[],playlists:[],events:[],hidden:[],imports:[],settings:{provider:'youtube',genres:['House']},onboarded:true};
 window.forma={desktop:false,load:async()=>state,save:async value=>{state=value;localStorage.setItem('youtube-test-library',JSON.stringify(value));},downloads:async()=>({}),onProgress:()=>()=>{},onBeforeClose:()=>()=>{},onPauseYouTube:()=>()=>{},cancelImport:()=>{},openYouTube:()=>{},
  catalogRequest:async(route,p)=>{if(p?.query==='Slow')await new Promise(r=>setTimeout(r,1000));if(route==='/users/search')return p.query.includes('Artist')?[{id:'yt_UCabcdefghijklmnop',name:'Test Artist'}]:[];if(route.startsWith('/users/'))return songs;if(p?.query?.includes('Missing'))return [];if(p?.query?.includes('Night'))return [songs[1]];if(p?.query==='Slow')return [songs[0]];return songs;},
  request:async()=>[],yandexPlaylist:async()=>({name:'Плейлист из Яндекса',sourceURL:'https://music.yandex.ru/users/test/playlists/1',tracks:[{title:'Soft Focus',artists:['Test Artist'],duration:200,key:'test artist soft focus'},{title:'Missing Song',artists:['Other Artist'],duration:180,key:'other artist missing song'}]})};
 window.YT={Player:class{
  constructor(node,options){this.options=options;this.id=options.videoId;this.state=2;this.time=0;const frame=document.createElement('iframe');frame.title='YouTube fixture';frame.src='about:blank';node.replaceWith(frame);this.frame=frame;this.timer=setInterval(()=>{if(this.state===1)this.time+=.25;},250);setTimeout(()=>options.events.onReady({target:this}),20);window.testYTPlayer=this;}
  playVideo(){this.state=1;this.options.events.onStateChange({data:1});}pauseVideo(){this.state=2;this.options.events.onStateChange({data:2});}getPlayerState(){return this.state;}getCurrentTime(){return this.time;}getDuration(){return 200;}getVideoData(){return{video_id:this.id};}seekTo(time){this.time=time;}setVolume(value){this.volume=value;}destroy(){clearInterval(this.timer);this.frame.remove();}
 }};
});
try{
 await page.goto(process.env.FORMA_TEST_URL||'http://localhost:5173');await page.locator('.track-row').first().waitFor();
 await page.getByRole('button',{name:'Слушать волну',exact:true}).click();await page.locator('.youtube-frame iframe').waitFor();await page.waitForFunction(()=>window.testYTPlayer?.getCurrentTime()>1);
 assert.equal(await page.locator('audio').evaluate(a=>a.getAttribute('src')),null);assert.equal(await page.locator('.youtube-panel').isVisible(),true);
 await page.getByRole('button',{name:'Следующий трек',exact:true}).click();await page.waitForFunction(()=>window.testYTPlayer.id==='12345678901');
 await page.getByRole('button',{name:'Пауза',exact:true}).click();assert.equal(await page.evaluate(()=>window.testYTPlayer.getPlayerState()),2);
 await page.getByRole('slider',{name:'Позиция воспроизведения'}).fill('45');assert.equal(await page.evaluate(()=>window.testYTPlayer.getCurrentTime()),45);
 await page.getByRole('textbox',{name:'Поиск треков и исполнителей'}).fill('Slow');await page.waitForTimeout(350);await page.getByRole('textbox',{name:'Поиск треков и исполнителей'}).fill('Night');await page.locator('.best-match h2').filter({hasText:'Night Current'}).waitFor();await page.waitForTimeout(800);assert.equal(await page.locator('.best-match h2').innerText(),'Night Current');
 await page.screenshot({path:'artifacts/forma-youtube.png',fullPage:true});
 for(const width of [1024,600]){await page.setViewportSize({width,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.ok((await page.locator('.youtube-frame').boundingBox()).width>=200);}
 await page.setViewportSize({width:1440,height:1050});
 await page.getByRole('button',{name:'Перенос библиотеки',exact:true}).click();await page.getByRole('textbox',{name:'Ссылка на публичный плейлист'}).fill('https://music.yandex.ru/users/test/playlists/1');await page.getByRole('button',{name:'Прочитать плейлист'}).click();await page.getByRole('button',{name:'Найти совпадения'}).click();await page.locator('.import-summary').waitFor();
 assert.equal(await page.locator('.import-row').count(),2);assert.equal(await page.getByRole('combobox',{name:'Версия для Soft Focus'}).inputValue(),'yt_abcdefghijk');assert.equal(await page.getByRole('combobox',{name:'Версия для Missing Song'}).inputValue(),'');
 await page.screenshot({path:'artifacts/forma-import.png',fullPage:true});await page.getByRole('button',{name:'Создать плейлист · 1'}).click();await page.getByRole('heading',{name:'Плейлист из Яндекса',exact:true}).waitFor();assert.equal(await page.locator('.track-row').count(),1);
 await page.waitForTimeout(400);await page.reload();await page.locator('.sidebar-playlists').getByRole('button',{name:'Плейлист из Яндекса'}).click();assert.equal(await page.locator('.track-row').count(),1);
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('youtube-test-library')));assert.equal(saved.imports[0].entries.length,2);assert.equal(saved.imports[0].entries[1].trackId,null);
 assert.deepEqual(errors,[]);console.log('PASS: visible YouTube player, queue, pause, seek, stale search protection, public playlist import review, missing-track report and persistence (mocked services/player).');
}finally{await browser.close();}
