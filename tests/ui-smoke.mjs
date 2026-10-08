import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const base=process.env.FORMA_TEST_URL||'http://localhost:5173';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1050}});const errors=[];
page.on('pageerror',e=>errors.push(e.message));
// Fixtures never ship with the application. All API/audio requests are intercepted here.
const titles=['Soft Focus','Night Current','Between the Lines','Slow Motion','Morning Light','Far From Home','Blue Hour','Sideways','Quiet Room','Warm Static','Lost in the City','New Perspective'];
const tracks=titles.map((title,i)=>({id:'Test'+i,title,user:{id:'Artist'+i,name:['Test Artist One','Test Artist Two','Test Artist Three'][i%3]},genre:['House','Electronic','Ambient'][i%3],mood:i%2?'Peaceful':'Upbeat',duration:120+i*17,tags:'melodic,chill',is_streamable:true,is_downloadable:true,play_count:3000+i*200,favorite_count:500+i*10,artwork:{}}));
function wav(seconds=90){const rate=8000,b=Buffer.alloc(44+rate*2*seconds);b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);for(let i=44;i<b.length;i+=2)b.writeInt16LE(Math.round(Math.sin(i/16)*1800),i);return b;}
const audio=wav();
await page.route(/https:\/\/.*\/v1\//,async route=>{
  const u=new URL(route.request().url());
  if(u.pathname.endsWith('/stream')){await route.fulfill({status:200,contentType:'audio/wav',body:audio,headers:{'accept-ranges':'bytes'}});return;}
  let data=tracks;
  if(u.pathname.endsWith('/search')){const q=u.searchParams.get('query');const g=u.searchParams.get('genre');data=tracks.filter(t=>(!q||`${t.title} ${t.user.name}`.toLowerCase().includes(q.toLowerCase()))&&(!g||t.genre===g));}
  await route.fulfill({json:{data}});
});
try{
  await page.goto(base);
  await page.getByRole('heading',{name:'Как звучит твой мир?'}).waitFor();
  await page.getByRole('button',{name:'House',exact:true}).click();
  await page.getByRole('button',{name:'Ambient',exact:true}).click();
  await page.getByRole('button',{name:'Найти мой ритм'}).click();
  await page.locator('.track-row').first().waitFor();
  assert.equal(await page.locator('.modal').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await fs.mkdir(path.resolve('artifacts'),{recursive:true});
  await page.screenshot({path:'artifacts/forma-home.png',fullPage:true});
  const firstRow=page.locator('.track-row').first();const firstTitle=await firstRow.locator('.track-name strong').innerText();
  await firstRow.locator('.track-actions button').first().click();
  await page.getByRole('button',{name:'Любимые треки',exact:false}).first().click();
  await page.getByRole('heading',{name:'Любимые треки',exact:true}).waitFor();
  assert.equal(await page.locator('.track-row').count(),1);
  await page.getByRole('button',{name:'Создать плейлист',exact:true}).click();
  await page.getByRole('textbox',{name:'Название плейлиста'}).fill('Вечерний маршрут');
  await page.locator('.modal').getByRole('button',{name:'Создать плейлист'}).click();
  await page.getByRole('heading',{name:'Вечерний маршрут',exact:true}).waitFor();
  await page.getByRole('button',{name:'Любимые треки',exact:false}).first().click();
  await page.locator('.track-actions button').last().click();
  await page.getByRole('button',{name:'Добавить в плейлист',exact:true}).click();
  await page.locator('.playlist-picker').getByRole('button',{name:'Вечерний маршрут'}).click();
  await page.locator('.sidebar-playlists').getByRole('button',{name:'Вечерний маршрут'}).click();
  assert.equal(await page.locator('.track-row').count(),1);
  await page.getByRole('textbox',{name:'Поиск треков и исполнителей'}).fill('Night');
  await page.getByRole('textbox',{name:'Поиск треков и исполнителей'}).press('Enter');
  await page.getByRole('heading',{name:'Нашлось по запросу «Night»'}).waitFor();
  assert.equal(await page.locator('.track-row').count(),1);
  await page.getByRole('button',{name:'Главная',exact:true}).click();
  await page.getByRole('button',{name:'Слушать волну',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('audio').currentTime>1);
  const old=await page.locator('.now-playing strong').innerText();
  await page.getByRole('button',{name:'Следующий трек',exact:true}).click();
  await page.waitForFunction(old=>document.querySelector('.now-playing strong').textContent!==old,old);
  await page.getByRole('button',{name:'Пауза',exact:true}).click();
  assert.equal(await page.locator('audio').evaluate(a=>a.paused),true);
  await page.getByRole('button',{name:'Настройки',exact:true}).click();
  await page.getByRole('switch',{name:'Только скачанная музыка'}).click();
  await page.getByText('Слушаем без интернета.',{exact:false}).waitFor();
  await page.reload();
  await page.getByRole('button',{name:'Любимые треки',exact:false}).first().click();
  assert.equal(await page.locator('.track-name strong').innerText(),firstTitle);
  await page.locator('.sidebar-playlists').getByRole('button',{name:'Вечерний маршрут'}).click();
  assert.equal(await page.locator('.track-row').count(),1);
  await page.setViewportSize({width:1024,height:768});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.setViewportSize({width:600,height:800});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: onboarding, catalogue, likes, playlists, search, wave, skip, pause, offline mode, restart persistence and responsive layout.');
}finally{await browser.close();}
