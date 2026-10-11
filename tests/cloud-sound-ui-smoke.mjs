import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
const source=await fs.readFile('tests/youtube-ui-smoke.mjs','utf8'),start=source.indexOf('await page.addInitScript(()=>{')+'await page.addInitScript(()=>{'.length,end=source.indexOf('\n});\ntry{',start);await page.addInitScript(source.slice(start,end));
const bytes=[...await fs.readFile('tests/fixtures/acoustic-sample.m4a')];
await page.addInitScript(({bytes})=>{
  window.googleStatus={connected:false};window.forma.desktop=true;window.forma.soundAudio=async()=>bytes;window.forma.cancelSound=async()=>{};
  window.forma.googleStatus=async()=>window.googleStatus;
  window.forma.googleLogin=async config=>{window.lastGoogleConfig=config;window.googleStatus={connected:true,email:'owner@example.com',lastSync:Date.now()};return window.googleStatus;};
  window.forma.googleLogout=async()=>window.googleStatus={connected:false};window.forma.googleSync=async()=>window.googleStatus;window.forma.onSync=()=>()=>{};
  const old=window.forma.save;window.forma.save=async state=>{window.savedState=state;await old(state);};
},{bytes});
try{
  await page.goto(process.env.FORMA_TEST_URL||'http://localhost:5173');await page.locator('.track-row').first().waitFor();await page.getByRole('button',{name:'Слушать Пульс',exact:true}).click();await page.waitForFunction(()=>window.testYTPlayer?.getCurrentTime()>1);
  await page.getByRole('button',{name:'Не нравится',exact:true}).click();await page.waitForFunction(()=>window.savedState?.dislikes.length===1);

  const disliked=await page.evaluate(()=>window.savedState.dislikes[0]);assert.ok(disliked);await page.getByRole('button',{name:'Снять дизлайк',exact:true}).click();await page.waitForFunction(()=>window.savedState?.dislikes.length===0);
  await page.waitForFunction(()=>Object.values(window.savedState?.tracks||{}).some(t=>t.soundProfile?.version===1),{},{timeout:20000});
  const profile=await page.evaluate(()=>Object.values(window.savedState.tracks).find(t=>t.soundProfile)?.soundProfile);assert.ok(profile.seconds>=8);assert.ok(profile.brightness<.1);assert.ok(profile.tempoConfidence>.3);
  await page.getByRole('button',{name:'Настройки',exact:true}).click();await page.getByText('Настройка проекта Google Cloud',{exact:true}).click();await page.getByRole('textbox',{name:'Desktop Client ID'}).fill('123456-test.apps.googleusercontent.com');await page.getByLabel('Desktop client secret').fill('local-only-test-secret');await page.getByRole('button',{name:'Войти через Google',exact:true}).click();await page.getByText('owner@example.com',{exact:true}).waitFor();await page.getByRole('button',{name:'Выйти из Google',exact:true}).click();await page.getByRole('button',{name:'Войти через Google',exact:true}).waitFor();assert.deepEqual(errors,[]);
  console.log('PASS: reversible dislike, actual AAC decoding + PCM worker profile, Google configuration/login/logout UI (controlled account transport).');
}finally{await browser.close();}
