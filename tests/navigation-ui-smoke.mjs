import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const source=await fs.readFile('tests/youtube-ui-smoke.mjs','utf8'),start=source.indexOf('await page.addInitScript(()=>{')+'await page.addInitScript(()=>{'.length,end=source.indexOf('\n});\ntry{',start),fixture=source.slice(start,end);
const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/same key|unique.*key/.test(m.text()))errors.push(m.text());});
await page.addInitScript(fixture);
await page.route('https://forma-artwork.test/**',route=>route.fulfill({status:404,body:'missing'}));
const playlist='Для долгих прогулок по вечернему городу';
await page.addInitScript(({playlist})=>{
 const load=window.forma.load,save=window.forma.save,catalog=window.forma.catalogRequest;
 window.forma.catalogRequest=async(...args)=>(await catalog(...args)).map(t=>t.source==='youtube'?{...t,artwork:'https://forma-artwork.test/missing.jpg',mood:'Peaceful',discoveryMoods:['calm']}:t);
 window.forma.load=async()=>{const s=await load();return {...s,settings:{...s.settings,volume:.23},playlists:[{id:'navigation-test',name:playlist,trackIds:['yt_abcdefghijk','yt_12345678901','yt_zyxwvutsrqp'],createdAt:1}]};};
 window.forma.save=async s=>{window.savedState=s;return save(s);};
},{playlist});
const base=process.env.FORMA_TEST_URL||'http://localhost:5173';
try{
 await page.goto(base);await page.locator('.track-row').first().waitFor();
 await expect(page.getByRole('button',{name:'Назад',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Главная',exact:true}).click();await page.getByRole('button',{name:'Главная',exact:true}).click();await expect(page.getByRole('button',{name:'Назад',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Свернуть боковую панель'}).click();await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-collapsed','true');
 assert.equal(await page.locator('.sidebar').evaluate(el=>Math.round(el.getBoundingClientRect().width)),84);
 for(const label of ['Поиск','Любимые треки','Скачанное','Перенос библиотеки','Настройки','Главная']){const nav=page.locator('.sidebar').getByRole('button',{name:label,exact:true});await expect(nav).toHaveAttribute('title',label);await nav.click();await expect(nav).toHaveAttribute('aria-current','page');}
 await page.locator('.sidebar').getByRole('button',{name:playlist,exact:true}).click();await expect(page.getByRole('heading',{name:playlist,exact:true})).toBeVisible();
 await page.reload();await page.locator('.track-row').first().waitFor();await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-collapsed','true');
 const search=page.getByRole('textbox',{name:'Поиск треков и исполнителей'});await search.fill('Night');await page.locator('.best-match').waitFor();await expect(page.locator('.best-cover .cover svg')).toBeVisible();
 await page.locator('.sidebar').getByRole('button',{name:'Любимые треки',exact:true}).click();await page.getByRole('button',{name:'Назад',exact:true}).click();await expect(search).toHaveValue('Night');await page.locator('.best-match').waitFor();
 await page.getByRole('button',{name:'Очистить поиск'}).click();await expect(search).toHaveValue('');await page.getByRole('button',{name:'Назад',exact:true}).click();await expect(page.locator('#pulse-title')).toBeVisible();
 await page.getByRole('button',{name:'Слушать Пульс',exact:true}).click();await page.waitForFunction(()=>window.testYTPlayer?.state===1);
 assert.equal(await page.locator('audio').evaluate(a=>a.volume),.23);assert.equal(await page.evaluate(()=>window.testYTPlayer.volume),23);
 await page.getByRole('button',{name:'Выключить звук'}).click();await page.getByRole('button',{name:'Включить звук'}).click();assert.equal(await page.evaluate(()=>window.testYTPlayer.volume),23);
 await page.locator('.mix-card').filter({hasText:'Спокойствие'}).click();await page.getByRole('button',{name:'Слушать подборку',exact:true}).click();await page.waitForFunction(()=>window.savedState?.events.findLast(e=>e.type==='play')?.surface==='mood');
 await page.locator('.sidebar').getByRole('button',{name:'Главная',exact:true}).click();await page.getByRole('button',{name:'Слушать Пульс',exact:true}).click();await page.waitForFunction(()=>window.savedState?.events.findLast(e=>e.type==='play')?.surface==='pulse');
 const sidebarToggle=page.getByRole('button',{name:'Развернуть боковую панель'});await sidebarToggle.focus();await page.keyboard.press('Space');await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar-collapsed','false');assert.equal(await page.evaluate(()=>window.testYTPlayer.state),1);
 const like=page.getByRole('button',{name:'Нравится текущий трек',exact:true});await like.focus();await page.keyboard.press('Space');await expect(like).toHaveAttribute('aria-pressed','true');assert.equal(await page.evaluate(()=>window.testYTPlayer.state),1);
 const create=page.getByRole('button',{name:'Создать плейлист',exact:true});await create.click();await expect(page.getByRole('textbox',{name:'Название плейлиста',exact:true})).toBeFocused();await expect(page.locator('.main-shell')).toHaveAttribute('inert','');await page.keyboard.press('Escape');await expect(create).toBeFocused();
 const pulse=page.getByRole('button',{name:'Настройка Пульса',exact:true});await pulse.click();const modal=page.getByRole('dialog');await expect(modal).toBeVisible();
 await modal.getByRole('button',{name:'Сбросить настройки Пульса'}).focus();await page.keyboard.press('Tab');await expect(modal.getByRole('button',{name:'Свернуть настройки Пульса'})).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(modal.getByRole('button',{name:'Сбросить настройки Пульса'})).toBeFocused();
 await page.keyboard.press('Escape');await expect(pulse).toBeFocused();assert.equal(await page.evaluate(()=>window.testYTPlayer.state),1);
 await search.fill('Test Artist');await page.locator('.track-row').nth(2).waitFor();await page.locator('.artist-card').first().click();await page.locator('.artist-hero').waitFor();await page.keyboard.press('Alt+ArrowLeft');await page.locator('.best-match').waitFor();await expect(search).toHaveValue('Test Artist');const firstRow=page.locator('.track-row').first(),title=await firstRow.locator('strong').innerText(),opener=firstRow.getByRole('button',{name:'Действия с треком '+title,exact:true});
 await opener.click();await page.getByRole('button',{name:'Добавить в плейлист',exact:true}).click();await page.keyboard.press('Escape');await expect(opener).toBeFocused();
 await firstRow.locator('.track-number').click();await page.waitForFunction(()=>window.testYTPlayer.state===1);
 const lastRow=page.locator('.track-row').last(),lastTitle=await lastRow.locator('strong').innerText();
 for(let i=0;i<2;i++){await lastRow.getByRole('button',{name:'Действия с треком '+lastTitle,exact:true}).click();await page.getByRole('button',{name:'Добавить в очередь',exact:true}).click();}
 const queue=page.getByRole('button',{name:'Очередь воспроизведения',exact:true});await queue.click();await expect(page.getByRole('button',{name:'Закрыть очередь'})).toBeFocused();await expect(page.locator('.queue-track')).toHaveCount(4);
 await page.locator('.queue-track').nth(2).click();await expect(page.locator('.queue-track')).toHaveCount(1);await expect(page.locator('.now-playing strong')).toHaveText(lastTitle);
 await page.keyboard.press('Escape');await expect(queue).toBeFocused();await expect(page.locator('.queue-panel')).toHaveCount(0);
 await page.locator('.sidebar').getByRole('button',{name:'Настройки',exact:true}).click();await page.getByRole('button',{name:'Ещё крупнее',exact:true}).click();await page.getByRole('button',{name:'Свернуть боковую панель'}).click();
 for(const width of [1920,1280,1024,760,600]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await expect(page.getByRole('button',{name:'Развернуть боковую панель'})).toBeInViewport();await expect(page.locator('.sidebar').getByRole('button',{name:'Настройки',exact:true})).toBeInViewport();}
 await page.setViewportSize({width:1440,height:1050});await page.getByRole('button',{name:'Обычный',exact:true}).click();await page.locator('.sidebar').getByRole('button',{name:'Главная',exact:true}).click();await page.screenshot({path:'artifacts/forma-sidebar-compact.png'});
 assert.deepEqual(errors,[]);
 // A rejected load must never autosave an empty replacement; retry reopens the original library.
 const broken=await browser.newPage();await broken.addInitScript(fixture);await broken.addInitScript(()=>{const load=window.forma.load,save=window.forma.save;window.saveCalls=0;window.forma.load=async()=>{if(!sessionStorage.getItem('allow-retry'))throw new Error('TEST_READ_FAILURE');return {...await load(),likes:['yt_abcdefghijk']};};window.forma.save=async s=>{window.saveCalls++;window.savedState=s;return save(s);};});
 await broken.goto(base);await broken.getByRole('heading',{name:'Библиотека не загрузилась'}).waitFor();await broken.waitForTimeout(400);await broken.evaluate(()=>window.dispatchEvent(new Event('beforeunload')));assert.equal(await broken.evaluate(()=>window.saveCalls),0);
 await broken.evaluate(()=>sessionStorage.setItem('allow-retry','1'));await broken.getByRole('button',{name:'Повторить загрузку'}).click();await broken.locator('.track-row').first().waitFor();await broken.waitForFunction(()=>window.savedState?.likes.includes('yt_abcdefghijk'));await broken.close();
 console.log('PASS: persistent icon sidebar with all routes/playlists, search Back/clear, saved-volume mute, native Space on buttons, modal autofocus/inert/focus restore and visible Tab cycle, duplicate queue and jump/escape, large-text narrow layouts, protected failed-load recovery.');
}finally{await browser.close()}
