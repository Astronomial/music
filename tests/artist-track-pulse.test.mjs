import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,normalizeTrack,mergeTracks} from '../src/core/model.mjs';
import {rankTracks} from '../src/core/recommender.mjs';
import {sameSong,trackPulseContext} from '../src/core/track-pulse.mjs';
import {artistTracks} from '../src/core/artist-catalog.mjs';
import {publicationAgeDays,searchColumns} from '../src/core/search.mjs';
import {YouTubeCatalog} from '../src/core/youtube.mjs';

const track=(id,title,extra={})=>normalizeTrack({id:'yt_'+id,videoId:id,source:'youtube',title,artist:'Артист',duration:180,...extra});
test('track Pulse keeps a fixed seed, excludes versions/covers and rejects unrelated favourites',()=>{
  const seed=track('seed0000001','Моя песня'),near=track('near0000001','Другая песня',{artist:'Новый артист',relatedTo:[seed.id],directRelatedTo:[seed.id]}),other=track('diff0000001','Чужая песня',{artist:'Любимый артист'});
  const versions=['Моя песня (DJ Remix)','Моя песня — slowed','Моя песня (Official Audio)'].map((title,i)=>track('same000000'+i,title,{artist:'Кавер артист',relatedTo:[seed.id]}));
  let state=mergeTracks(initialState(),[seed,near,other,...versions]);state.likes=[other.id];state.settings.languagePreference='any';state.settings.repeatCooldown=0;
  const result=rankTracks(Object.values(state.tracks),state,{context:trackPulseContext(seed)});
  assert.deepEqual(result.map(r=>r.track.id),[near.id]);assert.ok(versions.every(v=>sameSong(seed,v)));assert.equal(state.likes[0],other.id);
});
test('artist lookup resolves missing channel IDs by exact name and never returns a namesake',async()=>{
  const song=track('near0000001','Песня',{artistId:'yt_UCabcdefghijklmnop'}),wrong=track('diff0000001','Не тот артист',{artist:'Другой'}),calls=[];
  const result=await artistTracks({id:'name_артист',name:'Артист'},async(route)=>{calls.push(route);return route==='/users/search'?[{id:'yt_UCabcdefghijklmnop',name:'Артист'}]:[song,wrong];});
  assert.deepEqual(result.tracks.map(t=>t.id),[song.id]);assert.ok(calls.includes('/users/yt_UCabcdefghijklmnop/tracks'));
  let network=false;await artistTracks({id:song.artistId,name:song.artist},()=>{network=true;},{offline:true,tracks:[song]});assert.equal(network,false);
});
test('search columns preserve independent server orders and survive partial failure',async()=>{
  const a=track('near0000001','А'),b=track('diff0000001','Б');const orders=[];
  const result=await searchColumns('Артист',async(route,p)=>{if(route==='/users/search')return [];orders.push(p.sort_method);return p.sort_method==='recent'?[a,b]:[b,a];});
  assert.deepEqual(orders,['recent','popular']);assert.equal(result.recent[0].id,a.id);assert.equal(result.popular[0].id,b.id);assert.equal(result.tracks.length,2);
  const partial=await searchColumns('Артист',async(route,p)=>{if(p.sort_method==='recent')throw Error('down');return route==='/users/search'?[]:[b];});assert.ok(partial.partial);assert.equal(partial.popular[0].id,b.id);
});
test('installed parser receives real upload-date/view-count filters and keeps author channels',async()=>{
  const {Innertube}=await import('youtubei.js');const calls=[];
  const raw={contents:{twoColumnSearchResultsRenderer:{primaryContents:{sectionListRenderer:{contents:[{itemSectionRenderer:{contents:[{videoRenderer:{videoId:'near0000001',title:{runs:[{text:'Песня'}]},ownerText:{runs:[{text:'Артист',navigationEndpoint:{browseEndpoint:{browseId:'UCabcdefghijklmnop'}}}]},lengthText:{simpleText:'3:00'},viewCountText:{simpleText:'12345 views'},thumbnail:{thumbnails:[{url:'https://i.ytimg.com/test.jpg'}]}}}]}}]}}}}};
  const items=raw.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents;items[0].videoRenderer.publishedTimeText={simpleText:'3 weeks ago'};const newer=structuredClone(items[0]);newer.videoRenderer.videoId='diff0000001';newer.videoRenderer.publishedTimeText={simpleText:'2 days ago'};items.push(newer);
  const c=new YouTubeCatalog(()=>Innertube.create({generate_session_locally:true,retrieve_player:false,retrieve_innertube_config:false,fetch:async(input,options)=>{calls.push(JSON.parse(options?.body||await input.clone().text()));return Response.json(raw);}}));
  const recent=await c.request('/tracks/search',{query:'Артист',sort_method:'recent'}),popular=await c.request('/tracks/search',{query:'Артист',sort_method:'popular'});
  assert.deepEqual(calls.map(c=>c.params),['EgQIBBAB','CAMSAhAB']);assert.deepEqual([...Buffer.from(calls[0].params,'base64')],[18,4,8,4,16,1]);assert.equal(recent.items[0].videoId,'diff0000001');assert.equal(popular.items[0].videoId,'near0000001');assert.ok(calls.every(c=>c.context.client.clientName==='WEB'));assert.equal(recent.items[0].artistId,'yt_UCabcdefghijklmnop');assert.equal(popular.items[0].playCount,12345);
});

test('publication labels are ordered by actual time units, unknown dates stay unknown',()=>{assert.equal(publicationAgeDays('3 недели назад'),21);assert.equal(publicationAgeDays('2 days ago'),2);assert.equal(publicationAgeDays('5 часов назад'),5/24);assert.equal(publicationAgeDays('???'),Infinity);});
