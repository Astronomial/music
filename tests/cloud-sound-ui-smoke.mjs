import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
const source=await fs.readFile('tests/youtube-ui-smoke.mjs','utf8'),start=source.indexOf('await page.addInitScript(()=>{')+'await page.addInitScript(()=>{'.length,end=source.indexOf('\n});\ntry{',start);await page.addInitScript(source.slice(start,end));
const bytes=[...await fs.readFile('tests/fixtures/acoustic-sample.m4a')];
await page.addInitScript(({bytes})=>{
  window.syncState={enabled:false,devices:[],pending:[]};window.forma.desktop=true;window.forma.soundAudio=async()=>bytes;window.forma.cancelSound=async()=>{};
  window.forma.syncStatus=async()=>structuredClone(window.syncState);window.forma.onSync=()=>()=>{};
  window.forma.syncStart=async()=>window.syncState={enabled:true,devices:[{id:'phone',name:'iPhone'}],pending:[],pairing:'forma://pair?host=192.168.1.2&code=123456'};
  window.forma.syncStop=async()=>window.syncState={enabled:false,devices:[],pending:[]};
  window.forma.syncApprove=async id=>{window.confirmedExchange=id;window.syncState.pending=[];return window.syncState;};
  window.forma.syncReject=async id=>{window.rejectedExchange=id;window.syncState.pending=[];return window.syncState;};
  const old=window.forma.save;window.forma.save=async state=>{window.savedState=state;await old(state);};
},{bytes});
try{
  await page.goto(process.env.FORMA_TEST_URL||'http://localhost:5173');await page.locator('.track-row').first().waitFor();await page.getByRole('button',{name:'Слушать Пульс',exact:true}).click();await page.waitForFunction(()=>window.testYTPlayer?.getCurrentTime()>1);
  const first=await page.evaluate(()=>({id:'yt_'+window.testYTPlayer.id,title:document.querySelector('.now-playing strong').textContent}));
  await page.getByRole('button',{name:'Не нравится',exact:true}).click();
  await page.waitForFunction(id=>window.testYTPlayer.id!==id,first.id.slice(3));
  await page.waitForFunction(()=>window.savedState?.dislikes.length===1);
  const rejected=await page.evaluate(id=>window.savedState.events.filter(e=>e.trackId===id),first.id);
  assert.equal(rejected.filter(e=>e.type==='dislike').length,1);assert.equal(rejected.some(e=>e.type==='listen'||e.type==='skip'),false,'explicit dislike must not also record a listen/skip');
  const nextId=await page.evaluate(()=>window.testYTPlayer.id);
  await page.getByRole('textbox',{name:'Поиск треков и исполнителей'}).fill(first.title);
  const oldRow=page.locator('.track-row').filter({has:page.locator('.track-name strong',{hasText:first.title})}).first();await oldRow.waitFor();
  await oldRow.getByRole('button',{name:'Действия с треком '+first.title,exact:true}).click();
  await page.getByRole('button',{name:'Снять дизлайк',exact:true}).click();await page.waitForFunction(()=>window.savedState?.dislikes.length===0);
  assert.equal(await page.evaluate(()=>window.testYTPlayer.id),nextId,'undo must not advance playback');
  await oldRow.getByRole('button',{name:'Действия с треком '+first.title,exact:true}).click();await page.getByRole('button',{name:'Не нравится',exact:true}).last().click();
  await page.waitForFunction(()=>window.savedState?.dislikes.length===1);assert.equal(await page.evaluate(()=>window.testYTPlayer.id),nextId,'rating a different track must not advance playback');
  await oldRow.getByRole('button',{name:'Действия с треком '+first.title,exact:true}).click();await page.getByRole('button',{name:'Снять дизлайк',exact:true}).click();await page.waitForFunction(()=>window.savedState?.dislikes.length===0);
  // A regular queue advances too, even with single-track repeat enabled.
  await page.getByRole('textbox',{name:'Поиск треков и исполнителей'}).fill('');await page.getByRole('textbox',{name:'Поиск треков и исполнителей'}).fill('Test Artist');
  await page.locator('.track-row').nth(2).waitFor();await page.locator('.track-row').first().locator('.track-number').click();
  await page.waitForFunction(()=>window.testYTPlayer.state===1);const queuedFirst=await page.evaluate(()=>window.testYTPlayer.id);
  await page.getByRole('button',{name:'Повторить трек',exact:true}).click();
  await page.getByRole('button',{name:'Не нравится',exact:true}).click();await page.waitForFunction(id=>window.testYTPlayer.id!==id,queuedFirst);
  await page.waitForFunction(()=>window.testYTPlayer.state===1);
  // At the end of a queue, dislike stops instead of replaying the rejected track.
  await page.locator('.track-row').last().locator('.track-number').click();await page.waitForFunction(()=>window.testYTPlayer.state===1);
  const lastId=await page.evaluate(()=>window.testYTPlayer.id);await page.getByRole('button',{name:'Не нравится',exact:true}).click();
  await page.waitForFunction(()=>window.testYTPlayer.state===2);assert.equal(await page.evaluate(()=>window.testYTPlayer.id),lastId);
  await page.getByRole('button',{name:'Снять дизлайк',exact:true}).click();await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>window.testYTPlayer.state),2,'undo at the end of a queue must not resume playback');
  await page.waitForFunction(()=>Object.values(window.savedState?.tracks||{}).some(t=>t.soundProfile?.version===1),{},{timeout:20000});
  const profile=await page.evaluate(()=>Object.values(window.savedState.tracks).find(t=>t.soundProfile)?.soundProfile);assert.ok(profile.seconds>=8);assert.ok(profile.brightness<.1);assert.ok(profile.tempoConfidence>.3);
  await page.getByRole('button',{name:'Настройки',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Войти через Google',exact:true}).count(),0);
  await page.getByRole('button',{name:'Подключить iPhone',exact:true}).click();await page.getByRole('textbox',{name:'Код подключения iPhone'}).waitFor();
  const draft={id:'preview-test',deviceName:'iPhone',summary:{toPC:{likesAdded:2,details:['Лайк: Артист — Трек']},toPhone:{playlistsAdded:1,details:['Добавить плейлист: Любимое']}}};
  await page.evaluate(p=>window.syncState.pending=[p],draft);await page.getByRole('article',{name:'Обмен ожидает подтверждения'}).waitFor();assert.equal(await page.evaluate(()=>window.confirmedExchange),undefined);
  await page.getByText('Новые лайки: 2',{exact:true}).waitFor();await page.getByRole('button',{name:'Отклонить обмен',exact:true}).click();assert.equal(await page.evaluate(()=>window.rejectedExchange),'preview-test');
  await page.evaluate(p=>window.syncState.pending=[p],draft);await page.getByRole('button',{name:'Применить на обоих устройствах',exact:true}).click();assert.equal(await page.evaluate(()=>window.confirmedExchange),'preview-test');
  assert.deepEqual(errors,[]);
  console.log('PASS: dislike advances Pulse/queue, no extra positive feedback, undo and non-current ratings preserve playback, empty queue stops, actual AAC decoding + PCM worker profile, Wi-Fi preview, explicit approval/rejection and absence of Google UI (controlled paired-device transport).');
}finally{await browser.close();}
