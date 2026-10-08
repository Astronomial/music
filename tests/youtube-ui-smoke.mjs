import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 const songs=[['abcdefghijk','Soft Focus'],['12345678901','Night Current'],['zyxwvutsrqp','Fresh Direction']].map(([videoId,title])=>({id:'yt_'+videoId,videoId,title,artist:'Test Artist',artistId:'yt_UCabcdefghijklmnop',source:'youtube',genre:'House',streamable:true,downloadable:false,duration:200,tags:[],relatedTo:[]}));
 let state=JSON.parse(localStorage.getItem('youtube-test-library')||'null')||{version:1,tracks:{},likes:[],playlists:[],events:[],hidden:[],imports:[],settings:{provider:'youtube',genres:['House']},onboarded:true};
 window.forma={desktop:false,load:async()=>state,save:async value=>{state=value;localStorage.setItem('youtube-test-library',JSON.stringify(value));},downloads:async()=>({}),onProgress:()=>()=>{},onBeforeClose:()=>()=>{},cancelImport:()=>{},openYouTube:()=>{},
  catalogRequest:async(route,p)=>{if(p?.query==='Slow')await new Promise(r=>setTimeout(r,1000));if(route==='/users/search')return p.query.includes('Artist')?[{id:'yt_UCabcdefghijklmnop',name:'Test Artist'}]:[];if(route.startsWith('/users/'))return songs;if(p?.query?.includes('Missing'))return [];if(p?.query?.includes('Night'))return [songs[1]];if(p?.query==='Slow')return [songs[0]];return songs;},
  request:async()=>[],yandexPlaylist:async()=>({name:'Плейлист из Яндекса',sourceURL:'https://music.yandex.ru/users/test/playlists/1',tracks:[{title:'Soft Focus',artists:['Test Artist'],duration:200,key:'test artist soft focus'},{title:'Missing Song',artists:['Other Artist'],duration:180,key:'other artist missing song'}]})};
 window.ytPlayerCreations=0;window.ytLoads=[];
 window.YT={Player:class{
  constructor(node,options){window.ytPlayerCreations++;this.options=options;this.id=options.videoId;this.state=2;this.time=0;const frame=document.createElement('iframe');frame.title='YouTube fixture';frame.src='about:blank';node.replaceWith(frame);this.frame=frame;this.timer=setInterval(()=>{if(this.state===1)this.time+=.25;},250);setTimeout(()=>options.events.onReady({target:this}),20);window.testYTPlayer=this;}
  loadVideoById({videoId}){this.id=videoId;this.time=0;window.ytLoads.push(videoId);this.playVideo();}cueVideoById({videoId}){this.id=videoId;this.time=0;this.pauseVideo();}
  playVideo(){this.state=1;this.options.events.onStateChange({data:1});}pauseVideo(){this.state=2;this.options.events.onStateChange({data:2});}getPlayerState(){return this.state;}getCurrentTime(){return this.time;}getDuration(){return 200;}getVideoData(){return{video_id:this.id};}seekTo(time){this.time=time;}setVolume(value){this.volume=value;}destroy(){clearInterval(this.timer);this.frame.remove();}
 }};
});
try{
 await page.goto(process.env.FORMA_TEST_URL||'http://localhost:5173');await page.locator('.track-row').first().waitFor();
 await page.getByRole('button',{name:'Слушать Пульс',exact:true}).click();await page.locator('.youtube-frame iframe').waitFor();await page.waitForFunction(()=>window.testYTPlayer?.getCurrentTime()>1);
 assert.equal(await page.locator('audio').evaluate(a=>a.getAttribute('src')),null);assert.equal(await page.locator('.youtube-panel').isVisible(),true);
 const initialVideo=await page.evaluate(()=>window.testYTPlayer.id);
 const volume=page.getByRole('slider',{name:'Громкость',exact:true});
 await volume.fill('0.337');assert.ok(Math.abs(await page.evaluate(()=>window.testYTPlayer.volume)-33.7)<.01);
 await volume.press('ArrowRight');await page.waitForTimeout(400);
 assert.ok(Math.abs(await page.evaluate(()=>JSON.parse(localStorage.getItem('youtube-test-library')).settings.volume)-.338)<.001);
 const backgroundTime=await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));return window.testYTPlayer.getCurrentTime();});
 await page.waitForFunction(t=>window.testYTPlayer.getPlayerState()===1&&window.testYTPlayer.getCurrentTime()>t+.5,backgroundTime);
 await page.getByRole('button',{name:'Следующий трек',exact:true}).click();await page.waitForFunction(id=>window.testYTPlayer.id!==id,initialVideo);
 await page.waitForFunction(()=>window.testYTPlayer.getPlayerState()===1&&window.testYTPlayer.getCurrentTime()>.5);
 assert.equal(await page.evaluate(()=>window.ytPlayerCreations),1);
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
 await page.getByRole('button',{name:'Пауза',exact:true}).click();assert.equal(await page.evaluate(()=>window.testYTPlayer.getPlayerState()),2);
 await page.getByRole('slider',{name:'Позиция воспроизведения'}).fill('45');assert.equal(await page.evaluate(()=>window.testYTPlayer.getCurrentTime()),45);
 await page.getByRole('textbox',{name:'Поиск треков и исполнителей'}).fill('Slow');await page.waitForTimeout(350);await page.getByRole('textbox',{name:'Поиск треков и исполнителей'}).fill('Night');await page.locator('.best-match h2').filter({hasText:'Night Current'}).waitFor();await page.waitForTimeout(800);assert.equal(await page.locator('.best-match h2').innerText(),'Night Current');
 await page.screenshot({path:'artifacts/forma-youtube.png',fullPage:true});
 for(const width of [1024,600]){await page.setViewportSize({width,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.ok((await page.locator('.youtube-frame').boundingBox()).width>=200);}
 await page.setViewportSize({width:1440,height:1050});
 await page.getByRole('button',{name:'Перенос библиотеки',exact:true}).click();await page.getByRole('textbox',{name:'Ссылка на публичный плейлист'}).fill('https://music.yandex.ru/users/test/playlists/1');await page.getByRole('button',{name:'Прочитать плейлист'}).click();await page.getByRole('button',{name:'Найти совпадения'}).click();await page.locator('.import-summary').waitFor();
 assert.equal(await page.locator('.import-row').count(),2);assert.equal(await page.getByRole('combobox',{name:'Версия для Soft Focus'}).inputValue(),'yt_abcdefghijk');assert.equal(await page.getByRole('combobox',{name:'Версия для Missing Song'}).inputValue(),'');
 await page.screenshot({path:'artifacts/forma-import.png',fullPage:true});await page.getByRole('button',{name:'Создать плейлист · 1'}).click();await page.getByRole('heading',{name:'Плейлист из Яндекса',exact:true}).waitFor();assert.equal(await page.locator('.track-row').count(),1);
 await page.getByRole('button',{name:'Пульс от плейлиста',exact:true}).click();
 await page.waitForFunction(()=>window.testYTPlayer.getPlayerState()===1);
 await page.getByRole('button',{name:'Очередь воспроизведения',exact:true}).click();
 assert.match(await page.locator('.queue-panel').innerText(),/По мотивам «Плейлист из Яндекса»/);
 assert.equal(await page.evaluate(()=>window.ytPlayerCreations),1);
 await page.getByRole('button',{name:'Закрыть очередь',exact:true}).click();
 await page.getByRole('button',{name:'Пауза',exact:true}).click();
 await page.waitForTimeout(400);await page.reload();await page.locator('.sidebar-playlists').getByRole('button',{name:'Плейлист из Яндекса'}).click();assert.equal(await page.locator('.track-row').count(),1);
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('youtube-test-library')));assert.equal(saved.imports[0].entries.length,2);assert.equal(saved.imports[0].entries[1].trackId,null);
 // Resume the requested playlist after restart without dropping unmatched source names.
 const resumeRequest=await page.evaluate(()=>{
  const s=JSON.parse(localStorage.getItem('youtube-test-library')),track=Object.values(s.tracks).find(t=>t.title==='Soft Focus');
  const library={name:'Мне нравится · Яндекс',sourceURL:'https://music.yandex.ru/users/Astronomial/playlists/3',tracks:[{title:'Soft Focus',artists:['Test Artist'],duration:200,key:'test artist soft focus'},{title:'Missing Song',artists:['Other Artist'],duration:180,key:'other artist missing song'}]};
  return {id:'astronomial-favorites',name:library.name,sourceURL:library.sourceURL,library,status:'review',total:2,items:[{source:library.tracks[0],selectedId:track.id,status:'matched',candidates:[{track,score:1}]},{source:library.tracks[1],selectedId:null,status:'missing',candidates:[]}]};
 });
 await page.addInitScript(request=>{const s=JSON.parse(localStorage.getItem('youtube-test-library'));if(!s.importRequests?.length){s.importRequests=[request];window.forma.save(s);}},resumeRequest);
 await page.reload();await page.getByRole('button',{name:'Проверить версии',exact:true}).click();
 await page.getByRole('combobox',{name:'Версия для Soft Focus'}).selectOption('');
 await page.getByRole('button',{name:'Сохранить плейлист · 0'}).click();
 await page.getByRole('heading',{name:'Мне нравится · Яндекс',exact:true}).waitFor();
 assert.equal(await page.locator('.track-row').count(),2);
 assert.equal(await page.locator('.track-row.unavailable').count(),2);
 await page.waitForTimeout(400);await page.reload();
 const resumed=await page.evaluate(()=>JSON.parse(localStorage.getItem('youtube-test-library')));
 assert.equal(resumed.playlists.filter(p=>p.id==='astronomial-favorites').length,1);
 assert.equal(resumed.importRequests[0].status,'complete');
 assert.deepEqual(errors,[]);console.log('PASS: visible YouTube player, hidden-document playback and next-track autoplay, queue, explicit pause, continuous volume, seek, stale search, public playlist import and resumed review preserving unmatched titles (mocked services/player).');
}finally{await browser.close();}
