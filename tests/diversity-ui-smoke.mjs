import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
  const tracks=Array.from({length:72},(_,i)=>{const videoId=String(i).padStart(11,'0');return {id:'yt_'+videoId,videoId,title:'Song '+i,artist:i<30?'Favourite':'New artist '+i,artistId:i<30?'UCfav':'UC'+i,source:'youtube',genre:'House',streamable:true,duration:200,tags:[],relatedTo:[]};});
  const state={version:1,tracks:Object.fromEntries(tracks.map(t=>[t.id,t])),likes:tracks.slice(0,30).map(t=>t.id),playlists:[],events:[],hidden:[],settings:{provider:'youtube',genres:['House'],preferredArtists:['Favourite']},onboarded:true};
  window.savedState=state;window.trackFixture=state.tracks;
  window.forma={desktop:false,load:async()=>state,save:async s=>{window.savedState=s;},downloads:async()=>({}),onProgress:()=>()=>{},onBeforeClose:()=>()=>{},catalogRequest:async()=>[],request:async()=>[],sources:async()=>[]};
  window.YT={Player:class{
    constructor(node,options){this.options=options;this.id='';this.state=2;window.fixturePlayer=this;const frame=document.createElement('iframe');frame.src='about:blank';node.replaceWith(frame);this.frame=frame;setTimeout(()=>options.events.onReady({target:this}),0);}
    loadVideoById({videoId}){this.id=videoId;this.playVideo();}cueVideoById({videoId}){this.id=videoId;this.pauseVideo();}
    playVideo(){this.state=1;this.options.events.onStateChange({data:1});}pauseVideo(){this.state=2;this.options.events.onStateChange({data:2});}
    getCurrentTime(){return 0;}getDuration(){return 200;}getPlayerState(){return this.state;}getVideoData(){return {video_id:this.id};}setVolume(){}destroy(){this.frame.remove();}
  }};
});
try{
  await page.goto(process.env.FORMA_TEST_URL||'http://localhost:5173');
  await page.getByRole('button',{name:'Слушать Пульс',exact:true}).click();
  await page.waitForFunction(()=>window.fixturePlayer?.state===1&&!!window.fixturePlayer.id);
  const sequence=[];
  for(let i=0;i<18;i++){
    const id=await page.evaluate(()=>window.fixturePlayer.id);sequence.push(await page.evaluate(id=>window.trackFixture['yt_'+id],id));
    if(i<17){await page.getByRole('button',{name:'Следующий трек',exact:true}).click();await page.waitForFunction(previous=>window.fixturePlayer.id!==previous&&window.fixturePlayer.state===1,id);}
  }
  assert.equal(new Set(sequence.map(t=>t.id)).size,18);
  assert.ok(new Set(sequence.map(t=>t.artist)).size>=14);
  for(let i=1;i<sequence.length;i++)assert.ok(!sequence.slice(Math.max(0,i-3),i).some(t=>t.artist===sequence[i].artist));
  await page.waitForFunction(()=>window.savedState.events.filter(e=>e.type==='play').length===18);
  assert.ok((await page.evaluate(()=>window.savedState.events)).some(e=>e.newArtist===true));
  assert.deepEqual(errors,[]);
  console.log(`PASS: actual Pulse worker + 18 Next clicks: ${new Set(sequence.map(t=>t.artist)).size} artists, no nearby artist repeats, unique recordings and persisted discovery exposure (mocked YouTube transport).`);
}finally{await browser.close();}
