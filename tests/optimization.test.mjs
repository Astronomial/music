import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,normalizeTrack,recordEvent,mergeTracks} from '../src/core/model.mjs';
import {rankTracks,playlistPulseContext,playlistSeedState,selectRetrievalAnchors} from '../src/core/recommender.mjs';
import {collectYouTubeCandidates} from '../src/core/catalog.mjs';
import {YouTubeCatalog} from '../src/core/youtube.mjs';
import {RecommendationClient} from '../src/core/recommendation-client.mjs';
import {runRecommendationJob} from '../src/core/recommendation-jobs.mjs';
const now=1800000000000;
const song=(id,artist,genre='')=>normalizeTrack({id,artist,title:id,genre,duration:200,source:'youtube',videoId:id.replace(/^yt_/,'')});
function library(){const s=initialState();s.tracks={jazz:song('jazz','Jazz musician','Jazz'),rock:song('rock','Rock musician','Rock')};s.likes=['rock'];s.playlists=[{id:'j',name:'Jazz night',trackIds:['jazz']},{id:'r',name:'Rock day',trackIds:['rock']}];return s;}
test('playlist Pulse follows that playlist instead of unrelated favorites and leaves the global profile intact',()=>{
  const s=library();for(let day=0;day<10;day++)s.events.push({trackId:'rock',type:'listen',ratio:1,seconds:200,at:now-day*86400000});
  const before=JSON.stringify(s),ctx=playlistPulseContext(s,'j');
  assert.deepEqual(selectRetrievalAnchors(playlistSeedState(s,ctx),{now}).map(t=>t.id),['jazz']);
  const tracks=[song('candidateR','Rock musician','Rock'),song('candidateJ','Jazz musician','Jazz')];
  assert.equal(rankTracks(tracks,s,{now})[0].track.id,'candidateR');
  const ranked=rankTracks(tracks,s,{now,context:ctx});assert.equal(ranked[0].track.id,'candidateJ');assert.match(ranked[0].reason,/Jazz night/);
  assert.equal(JSON.stringify(s),before);assert.equal(playlistPulseContext(s,'missing'),null);
  s.playlists=[];assert.deepEqual(rankTracks(tracks,s,{now,context:ctx}),[]);
});
test('playlist Pulse obeys exclusions and shared consumption feedback',()=>{
  let s=library();const ctx=playlistPulseContext(s,'j'),a=song('new1','One','Jazz'),b=song('new2','Two','Jazz');
  s.tracks={...s.tracks,a,b};for(let day=0;day<5;day++){s=recordEvent(s,'a','listen',{ratio:.95,seconds:190},now-day*86400000);s=recordEvent(s,'b','skip',{ratio:.04,seconds:8},now-day*86400000);}
  assert.equal(rankTracks([b,a],s,{now,context:ctx})[0].track.id,'new1');
  s.settings.blockedArtists=['One'];assert.equal(rankTracks([a,b],s,{now,context:ctx}).some(r=>r.track.id==='new1'),false);
});
test('playlist retrieval uses its own YouTube seeds and artists, publishes partial batches before finishing',async()=>{
  const s=library();s.tracks.jazz={...s.tracks.jazz,id:'yt_abcdefghijk',videoId:'abcdefghijk'};s.playlists[0].trackIds=['jazz'];
  const routes=[],partial=[],ctx=playlistPulseContext(s,'j');
  await collectYouTubeCandidates(s,async(route,p)=>{routes.push([route,p]);return [song('yt_12345678901','Related')];},{context:ctx,onBatch:items=>partial.push({count:items.length,calls:routes.length})});
  assert.ok(routes.some(([r])=>r==='/related/abcdefghijk'));assert.ok(routes.some(([,p])=>p.query?.includes('Jazz musician')));
  assert.equal(routes.some(([,p])=>p.query?.includes('Rock musician')),false);assert.ok(partial[0].calls<routes.length);
  assert.equal(playlistSeedState(s,ctx).likes.length,0);
});
test('YouTube related cache shares concurrent work, expires and retries failures',async()=>{
  let calls=0,fail=true;const catalog=new YouTubeCatalog(()=>({music:{getUpNext:async()=>{calls++;if(fail)throw new Error('offline');return {contents:[{video_id:'12345678901',title:'Song',artists:[{name:'Artist'}]}]};}}}));
  await assert.rejects(catalog.related('abcdefghijk'));fail=false;
  const [a,b]=await Promise.all([catalog.related('abcdefghijk'),catalog.related('abcdefghijk')]);assert.deepEqual(a,b);assert.equal(calls,2);
  catalog.relatedCache.get('abcdefghijk').at=0;await catalog.related('abcdefghijk');assert.equal(calls,3);
});
test('worker scheduler coalesces old shelves, prioritizes playback and never lets a preview cancel a playback request',async()=>{
  const sent=[],worker={postMessage:value=>sent.push(value),terminate(){}};const c=new RecommendationClient(worker);
  const old=c.request({kind:'analyze'}),superseded=c.request({kind:'analyze'}),shelf=c.request({kind:'analyze'}),play=c.request({kind:'rank',lane:'playback'}),preview=c.request({kind:'rank',lane:'preview'});
  assert.equal(await superseded,null);worker.onmessage({data:{id:sent[0].id,result:'old'}});assert.equal(await old,'old');assert.equal(sent[1].job.lane,'playback');
  worker.onmessage({data:{id:sent[1].id,result:'song'}});assert.equal(await play,'song');assert.equal(sent[2].job.lane,'preview');
  worker.onmessage({data:{id:sent[2].id,result:'queue'}});assert.equal(await preview,'queue');
  worker.onmessage({data:{id:sent[3].id,result:'shelves'}});assert.equal(await shelf,'shelves');c.close();
});
test('worker failure rejects all active and queued work rather than leaving Pulse pending',async()=>{
  const worker={postMessage(){},terminate(){this.terminated=true;}},c=new RecommendationClient(worker);
  const active=c.request({kind:'rank'}),queued=c.request({kind:'analyze'});const results=Promise.allSettled([active,queued]);worker.onerror();
  assert.ok((await results).every(r=>r.status==='rejected'));assert.equal(worker.terminated,true);await assert.rejects(c.request({kind:'rank'}));
});
test('worker analysis preserves deterministic ranking and does not alter listening history',()=>{
  const s=library(),tracks=Object.values(s.tracks),before=JSON.stringify(s);const result=runRecommendationJob({kind:'analyze',candidates:tracks,state:s,options:{now}});
  assert.deepEqual(result.recommendations,rankTracks(tracks,s,{now}));assert.equal(result.mixes.length,6);assert.equal(JSON.stringify(s),before);
});
test('large catalogue pruning retains saved and recently heard music while enforcing discovery bound',()=>{
  const s=initialState();s.likes=['t0'];s.events=[{trackId:'t1',type:'play',at:now}];const tracks=Array.from({length:7000},(_,i)=>normalizeTrack({id:'t'+i,title:'Song'}));const merged=mergeTracks(s,tracks);
  assert.equal(Object.keys(merged.tracks).length,6000);assert.ok(merged.tracks.t0);assert.ok(merged.tracks.t1);assert.equal(Object.keys(s.tracks).length,0);
});

import {ListeningClock} from '../src/core/listening-clock.mjs';
test('actual listening includes the final fraction before pause/skip and excludes seeks and long suspensions',()=>{
  const clock=new ListeningClock();clock.sample(1000,true);clock.sample(1500,true);clock.sample(1820,false);assert.ok(Math.abs(clock.seconds-.82)<1e-9);
  clock.sample(5000,false);clock.sample(5500,true);clock.sample(6000,true);assert.ok(Math.abs(clock.seconds-1.32)<1e-9);
  clock.sample(6500,true,true);clock.sample(7000,true);assert.ok(Math.abs(clock.seconds-1.32)<1e-9);
  clock.sample(100000,true);assert.ok(Math.abs(clock.seconds-2.82)<1e-9);
});
