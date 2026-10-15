import {installAudioFixture} from './audio-fixture.mjs';
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

});
await page.addInitScript(installAudioFixture);
try{
 await page.goto(process.env.FORMA_TEST_URL||'http://localhost:5173');await page.locator('.track-row').first().waitFor();
 await page.getByRole('button',{name:'Слушать Пульс',exact:true}).click();await page.waitForFunction(()=>window.nativeAudio.getCurrentTime()>1);
 let audioElement=await page.locator('audio').elementHandle();
 assert.equal(await page.locator('iframe,video,.youtube-panel,.online-badge').count(),0);
 assert.equal(await page.locator('.sidebar').getByRole('button',{name:'Настройка Пульса',exact:true}).count(),0);
 const initialVideo=await page.evaluate(()=>window.nativeAudio.id);
 const volume=page.getByRole('slider',{name:'Громкость',exact:true});
 await volume.fill('0.337');assert.ok(Math.abs(await page.evaluate(()=>window.nativeAudio.volume)-33.7)<.01);
 await volume.press('ArrowRight');await page.waitForTimeout(400);
 assert.ok(Math.abs(await page.evaluate(()=>JSON.parse(localStorage.getItem('youtube-test-library')).settings.volume)-.338)<.001);
 const backgroundTime=await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));return window.nativeAudio.getCurrentTime();});
 await page.waitForFunction(t=>window.nativeAudio.getPlayerState()===1&&window.nativeAudio.getCurrentTime()>t+.5,backgroundTime);
 await page.waitForFunction(()=>document.querySelector('.app-shell').dataset.visualsActive==='false');
 assert.equal(await page.locator('.galaxy-disk').evaluate(el=>getComputedStyle(el).animationPlayState),'paused');
 await page.getByRole('button',{name:'Следующий трек',exact:true}).click();await page.waitForFunction(id=>window.nativeAudio.id!==id,initialVideo);
 await page.waitForFunction(()=>window.nativeAudio.getPlayerState()===1&&window.nativeAudio.getCurrentTime()>.5);
 assert.equal(await audioElement.evaluate(a=>a===document.querySelector('audio')),true);
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForFunction(()=>document.querySelector('.app-shell').dataset.visualsActive==='true');
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('.galaxy-disk').evaluate(el=>getComputedStyle(el).animationName),'none');
 assert.equal(await page.locator('.shooting-star').first().evaluate(el=>getComputedStyle(el).display),'none');
 assert.equal(await page.evaluate(()=>window.nativeAudio.getPlayerState()),1);
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.getByRole('button',{name:'Пауза',exact:true}).click();assert.equal(await page.evaluate(()=>window.nativeAudio.getPlayerState()),2);
 await page.getByRole('slider',{name:'Позиция воспроизведения'}).fill('45');assert.equal(await page.evaluate(()=>window.nativeAudio.getCurrentTime()),45);
 await page.getByRole('button',{name:'Воспроизвести',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('audio').paused);
 await page.getByRole('button',{name:'Пауза',exact:true}).click();
 await page.getByRole('textbox',{name:'Поиск треков и исполнителей'}).fill('Slow');await page.waitForTimeout(350);await page.getByRole('textbox',{name:'Поиск треков и исполнителей'}).fill('Night');await page.locator('.best-match h2').filter({hasText:'Night Current'}).waitFor();await page.waitForTimeout(800);assert.equal(await page.locator('.best-match h2').innerText(),'Night Current');
 await page.screenshot({path:'artifacts/forma-youtube.png',fullPage:true});
 for(const width of [1024,600]){await page.setViewportSize({width,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('iframe,video').count(),0);}
 await page.setViewportSize({width:1440,height:1050});
 // Favorite ordering is checked through real clicks, persistence and a re-like.
 const searchBox=page.getByRole('textbox',{name:'Поиск треков и исполнителей'});await searchBox.fill('Test Artist');await page.locator('.track-row').nth(2).waitFor();
 const favoriteTitles=await page.locator('.track-row .track-name strong').allTextContents();
 await page.locator('.track-row').nth(0).locator('.track-actions button').first().click();await page.locator('.track-row').nth(1).locator('.track-actions button').first().click();
 await page.locator('.sidebar').getByRole('button',{name:'Любимые треки',exact:true}).click();
 assert.deepEqual(await page.locator('.track-name strong').allTextContents(),[favoriteTitles[1],favoriteTitles[0]]);
 await page.locator('.track-row').first().locator('.track-actions button').first().click();await searchBox.fill(favoriteTitles[1]);await page.locator('.best-match').waitFor();await page.locator('.track-row').first().locator('.track-actions button').first().click();
 await page.locator('.sidebar').getByRole('button',{name:'Любимые треки',exact:true}).click();await page.waitForTimeout(350);await page.reload();audioElement=await page.locator('audio').elementHandle();
 await page.locator('.sidebar').getByRole('button',{name:'Любимые треки',exact:true}).click();assert.deepEqual(await page.locator('.track-name strong').allTextContents(),[favoriteTitles[1],favoriteTitles[0]]);
 await page.getByRole('button',{name:'Перенос библиотеки',exact:true}).click();await page.getByRole('textbox',{name:'Ссылка на публичный плейлист'}).fill('https://music.yandex.ru/users/test/playlists/1');await page.getByRole('button',{name:'Прочитать плейлист'}).click();await page.getByRole('button',{name:'Найти совпадения'}).click();await page.locator('.import-summary').waitFor();
 assert.equal(await page.locator('.import-row').count(),2);assert.equal(await page.getByRole('combobox',{name:'Версия для Soft Focus'}).inputValue(),'yt_abcdefghijk');assert.equal(await page.getByRole('combobox',{name:'Версия для Missing Song'}).inputValue(),'');
 await page.screenshot({path:'artifacts/forma-import.png',fullPage:true});await page.getByRole('button',{name:'Создать плейлист · 1'}).click();await page.getByRole('heading',{name:'Плейлист из Яндекса',exact:true}).waitFor();assert.equal(await page.locator('.track-row').count(),1);
 await page.getByRole('button',{name:'Пульс от плейлиста',exact:true}).click();
 await page.waitForFunction(()=>window.nativeAudio.getPlayerState()===1);
 await page.getByRole('button',{name:'Очередь воспроизведения',exact:true}).click();
 assert.match(await page.locator('.queue-panel').innerText(),/По мотивам «Плейлист из Яндекса»/);
 assert.equal(await audioElement.evaluate(a=>a===document.querySelector('audio')),true);
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
 assert.deepEqual(errors,[]);console.log('PASS: native audio without video, hidden-document playback and next-track autoplay, queue, explicit pause, continuous volume, seek, stale search, public playlist import and resumed review preserving unmatched titles (mocked services/player).');
}finally{await browser.close();}
