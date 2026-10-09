import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,normalizeTrack,recordEvent} from '../src/core/model.mjs';
import {rankTracks,buildProfile,selectRetrievalAnchors} from '../src/core/recommender.mjs';
import {contextFeatures,buildContextualModel,predictContext,validContext} from '../src/core/contextual-learning.mjs';
import {languageEvidence,discoveryPolicy,neighbourhood} from '../src/core/discovery-policy.mjs';
import {waveSettings,upgradeWaveSettings} from '../src/core/wave-settings.mjs';
import {portableLibrary,applyPortable} from '../src/core/sync.mjs';
const now=1800000000000;
const song=(id,extra={})=>normalizeTrack({id,title:'Трек '+id,artist:'Исполнитель '+id,artistId:id,genre:'Pop',duration:200,...extra});
const context=extra=>({version:1,lane:'nearby',features:contextFeatures({taste:.5,nearby:.6,session:.2,newArtist:true,known:false,language:.8,context:0,metadata:1,...extra})});

test('PC upgrade applies 70/30 once, preserves other settings and subsequent user edits',()=>{
  const old={discovery:.3,mood:'calm',genres:['Pop'],blockedArtists:['Blocked']};
  const first=upgradeWaveSettings(old);assert.equal(first.discovery,.7);assert.equal(first.mood,'calm');assert.deepEqual(first.blockedArtists,['Blocked']);
  assert.equal(upgradeWaveSettings({...first,discovery:.2}).discovery,.2);
  assert.equal(waveSettings({explorationStyle:'invalid',languagePreference:'invalid',sessionInfluence:5}).sessionInfluence,1);
});
test('language evidence distinguishes explicit metadata, Cyrillic titles and weak search hints',()=>{
  assert.equal(languageEvidence(song('a',{language:'en',title:'Русское название'}),'ru').fit,0);
  assert.equal(languageEvidence(song('a',{language:'ru-RU'}),'ru').fit,1);
  assert.equal(languageEvidence(song('a'),'ru').fit,.8);
  assert.equal(languageEvidence(song('a',{title:'Latin',artist:'Artist',discoveryLanguages:['ru']}),'ru').fit,.3);
  assert.equal(languageEvidence(song('a',{title:'Latin',artist:'Artist'}),'en').fit,0);
  assert.equal(languageEvidence(song('a',{title:'Тіні'}),'ru').fit,0);
});
test('direct links from distinct favourite artists corroborate taste; second hops stay weaker',()=>{
  const a=song('a'),b=song('b'),anchors=[{track:a},{track:b}],weights=new Map([['a',5],['b',5]]);
  const indirect=neighbourhood(song('c',{relatedTo:['a','b']}),anchors,()=>0,weights);
  const direct=neighbourhood(song('d',{relatedTo:['a','b'],directRelatedTo:['a','b']}),anchors,()=>0,weights);
  assert.equal(indirect.fit,.34);assert.equal(direct.fit,.7);assert.equal(direct.corroboration,2);
});
test('strict audible skips reduce the experiment budget; startup failures, instant taps and shelves do not',()=>{
  const s=initialState();s.events=Array.from({length:3},(_,i)=>({trackId:'a'+i,type:'skip',seconds:8,ratio:.04,at:now-4000+i*1000,surface:'pulse'}));
  const reduced=discoveryPolicy(s,s.settings,now);assert.equal(reduced.earlySkips,3);assert.equal(reduced.surpriseRate,.03);
  s.events.push({trackId:'error',type:'error',at:now,surface:'pulse'},{trackId:'tap',type:'skip',seconds:1,ratio:.01,at:now,surface:'pulse'});
  assert.equal(discoveryPolicy(s,s.settings,now).surpriseRate,.03);
  s.events.push({trackId:'good',type:'listen',seconds:190,ratio:.95,at:now,surface:'mood'});
  assert.equal(discoveryPolicy(s,s.settings,now).surpriseRate,.12);
  assert.equal(buildContextualModel(s,now).samples,0);
});
test('context learner generalises to unheard artists using chronological selection snapshots',()=>{
  const s=initialState(),positive=context(),negative=context({nearby:0,language:0,session:-.8,metadata:0});
  for(let i=0;i<24;i++)s.events.push({trackId:'good'+i,type:'listen',ratio:.95,seconds:190,at:now-10000+i,recommendation:positive},{trackId:'bad'+i,type:'skip',ratio:.04,seconds:8,at:now-10000+i,recommendation:negative});
  const model=buildContextualModel(s,now),good=predictContext(model,positive.features),bad=predictContext(model,negative.features);
  assert.ok(good.correction>0);assert.ok(bad.correction<0);assert.ok(good.mean>bad.mean+.3);
  // Neither artist IDs nor current catalogue metadata are needed to train this model.
  const changed={...s,tracks:{unheard:song('unheard')},likes:['unheard']};
  assert.deepEqual(buildContextualModel(changed,now),model);
  changed.events=[...s.events,{trackId:'future',type:'like',at:now+1,recommendation:positive}];
  assert.deepEqual(buildContextualModel(changed,now),model);
});
test('context feedback is bounded per recording per day and rejects invalid context or errors',()=>{
  const s=initialState(),snapshot=context();s.events=Array.from({length:100},(_,i)=>({trackId:'same',type:'listen',ratio:1,seconds:200,at:now-1000+i,recommendation:snapshot}));
  assert.equal(buildContextualModel(s,now).samples,1);
  s.events.push({trackId:'broken',type:'like',at:now,recommendation:{...snapshot,features:[NaN]}},{trackId:'error',type:'error',at:now,recommendation:snapshot});
  assert.equal(buildContextualModel(s,now).samples,1);assert.equal(validContext({version:2,features:snapshot.features}),false);
  const fresh=buildContextualModel(s,now);assert.ok(buildContextualModel(s,now+30*86400000).confidence<fresh.confidence);
  s.events=[{trackId:'same',type:'skip',seconds:8,ratio:.04,at:now,recommendation:snapshot}];
  const strict=buildContextualModel(s,now);s.settings.skipSensitivity='soft';assert.ok(buildContextualModel(s,now).confidence<strict.confidence);
});
test('a dominant saved artist cannot erase a minority musical interest',()=>{
  const s=initialState(),dominant=Array.from({length:180},(_,i)=>song('dominant'+i,{artist:'Dominant',artistId:'dominant',genre:'Rock'})),minor=song('minor',{genre:'Jazz'});
  s.tracks=Object.fromEntries([...dominant,minor].map(t=>[t.id,t]));s.likes=Object.keys(s.tracks);
  const profile=buildProfile(s,now);assert.ok(profile.positive['genre:Rock']/profile.positive['genre:Jazz']<6);
  assert.ok(selectRetrievalAnchors(s,{now,limit:45}).some(t=>t.id==='minor'));
  const jazz=song('new-jazz',{genre:'Jazz'}),weak=song('weak',{genre:'',discoveryGenres:['Jazz'],title:'Unknown',artist:'Unknown'});
  assert.equal(rankTracks([weak,jazz],s,{now,limit:1})[0].track.id,jazz.id);
});
test('repeated one-song ranking maintains 70/30 novelty using actual started playback, not shelf impressions',()=>{
  let s=initialState();s.settings.artistDiversity=0;
  const tracks=Array.from({length:100},(_,i)=>song('s'+i));s.tracks=Object.fromEntries(tracks.map(t=>[t.id,t]));s.likes=tracks.slice(0,40).map(t=>t.id);
  const heard=[];
  for(let i=0;i<40;i++){
    const item=rankTracks(tracks,s,{now:now+i*1000,limit:1})[0];assert.ok(item);heard.push(item);
    s=recordEvent(s,item.track.id,'play',{surface:'pulse',newArtist:item.newArtist,recommendation:item.exposure},now+i*1000);
  }
  assert.ok(heard.filter(i=>!i.known).length>=26&&heard.filter(i=>!i.known).length<=30);
  assert.equal(new Set(heard.map(i=>i.track.id)).size,40);
  assert.equal(s.events.length,40);
});
test('Russian preference keeps strong nearby international matches above weak Russian search labels and respects blocks',()=>{
  const s=initialState(),seed=song('seed',{genre:'Rock'}),good=song('good',{genre:'Rock',language:'en',title:'Song'}),weak=song('weak',{genre:'',discoveryGenres:['Rock'],discoveryLanguages:['ru'],title:'Other',artist:'Unknown'});
  s.tracks={seed,good,weak};s.likes=['seed'];assert.equal(rankTracks([weak,good],s,{now,limit:1})[0].track.id,'good');
  s.settings.blockedArtists=[good.artist,weak.artist];assert.equal(rankTracks([weak,good],s,{now,limit:1}).length,0);
});
test('phone sync preserves PC-only learning context, explicit feedback and preferences without exporting them to iOS',()=>{
  const s=initialState(),t=song('yt_abcdefghijk',{source:'youtube',videoId:'abcdefghijk',directRelatedTo:['seed'],discoveryLanguages:['ru']});s.tracks={[t.id]:t};s.likes=[t.id];
  s.events=[{trackId:t.id,type:'play',seconds:0,ratio:0,at:now,recommendation:context(),surface:'pulse'},{trackId:t.id,type:'like',at:now+1,recommendation:context()}];
  const portable=portableLibrary(s);assert.equal(portable.events[0].recommendation,undefined);assert.equal(portable.settings.languagePreference,undefined);
  const merged=applyPortable(s,portable);assert.deepEqual(merged.events[0].recommendation,s.events[0].recommendation);assert.equal(merged.events[1].type,'like');assert.equal(merged.settings.languagePreference,'ru');assert.equal(merged.settings.recommendationVersion,2);assert.deepEqual(merged.tracks[t.id].directRelatedTo,['seed']);
});
