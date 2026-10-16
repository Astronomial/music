import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {installAudioFixture} from './audio-fixture.mjs';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 const make=(id,title,artist,extra={})=>({id:'yt_'+id,videoId:id,title,artist,artistId:'yt_UCabcdefghijklmnop',source:'youtube',duration:180,streamable:true,tags:[],...extra});
 const seed=make('seed0000001','Моя песня','Артист'),near=make('near0000001','Новая песня','Новый артист',{artistId:'yt_UCnewartistchannel',relatedTo:[seed.id],directRelatedTo:[seed.id]}),remix=make('same0000001','Моя песня (Remix)','Артист',{relatedTo:[seed.id]}),other=make('diff0000001','Совсем другая','Другой артист',{artistId:'yt_UCanotherchannel01'}),all=[seed,near,remix,other];
 const state={version:1,tracks:Object.fromEntries(all.map(t=>[t.id,t])),likes:[],playlists:[],events:[],hidden:[],settings:{languagePreference:'any',repeatCooldown:0},onboarded:true};
 window.forma={desktop:false,load:async()=>state,save:async s=>{window.saved=s;},downloads:async()=>({}),catalogRequest:async(route,p)=>{
  if(route==='/users/search')return [{id:seed.artistId,name:'Артист'}];
  if(route.startsWith('/users/'))return [seed,remix];
  if(route==='/related/seed0000001')return [remix,near];
  if(route.startsWith('/related/'))return [near];
  return p.sort_method==='recent'?[seed,near,remix]:p.sort_method==='popular'?[near,seed,remix]:[];
 }};
});
await page.addInitScript(installAudioFixture);
try{
 await page.goto(process.env.FORMA_TEST_URL||'http://localhost:5173');
 const search=page.getByRole('textbox',{name:'Поиск треков и исполнителей'});await search.fill('Артист');
 const recent=page.getByRole('region',{name:'Свежие релизы'}),popular=page.getByRole('region',{name:'Популярные'});
 await expect(recent.locator('.track-title').first()).toHaveText('Моя песня');await expect(popular.locator('.track-title').first()).toHaveText('Новая песня');
 const boxes=await Promise.all([recent.boundingBox(),popular.boundingBox()]);assert.ok(boxes[1].x>boxes[0].x&&Math.abs(boxes[1].y-boxes[0].y)<2);
 await recent.getByRole('button',{name:'К исполнителю Артист',exact:true}).first().click();await expect(page.locator('.artist-hero h1')).toHaveText('Артист');await expect(page.locator('.track-row')).toHaveCount(2);
 await page.getByRole('button',{name:'Назад',exact:true}).click();await expect(search).toHaveValue('Артист');await recent.locator('.track-title').first().click();await page.waitForFunction(()=>window.nativeAudio.state===1);
 await page.locator('.now-playing').getByRole('button',{name:'Артист',exact:true}).click();await expect(page.locator('.artist-hero')).toBeVisible();await page.getByRole('button',{name:'Назад',exact:true}).click();
 await recent.getByRole('button',{name:'Действия с треком Моя песня',exact:true}).click();await page.getByRole('button',{name:'Пульс по треку',exact:true}).click();
 await expect(page.locator('.now-playing strong')).toHaveText('Моя песня');await page.waitForFunction(()=>window.nativeAudio.state===1);
 await page.waitForFunction(()=>window.saved?.tracks.yt_near0000001?.directRelatedTo?.includes('yt_seed0000001'));
 await page.getByRole('button',{name:'Следующий трек',exact:true}).click();await expect(page.locator('.now-playing strong')).toHaveText('Новая песня');await page.waitForFunction(()=>window.nativeAudio.state===1);
 await page.screenshot({path:process.env.FORMA_FEATURE_SCREENSHOT||'/tmp/forma-track-pulse.png'});
 assert.deepEqual(errors,[]);console.log('PASS: independent fresh/popular search columns, artist from search and player, Back preserves query, track Pulse starts seed and continues with a different related recording.');
}finally{await browser.close();}
