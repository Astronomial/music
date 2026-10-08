import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,normalizeTrack} from '../src/core/model.mjs';
import {searchCatalog,searchLocal} from '../src/core/search.mjs';
import {parseYandexPlaylistURL,parseYandexPlaylist,parseImportFile,matchConfidence,matchLibrary,applyLibraryImport} from '../src/core/library-import.mjs';
import {requestPublicYandexPlaylist} from '../src/core/yandex.mjs';
import {appearanceVariables} from '../src/core/appearance.mjs';
const raw=(id,title,artist='Artist')=>({id,title,user:{id:'ArtistOne',name:artist},duration:200,is_streamable:true});
test('artist search expands beyond a title-only track index and deduplicates saved tracks',async()=>{
 const calls=[],song=raw('a','Unrelated title','Björk');
 const result=await searchCatalog('bjork',async(path)=>{calls.push(path);return path==='/users/search'?[{id:'ArtistOne',name:'Björk'}]:path.includes('/users/')?[song]:[];},{localTracks:[normalizeTrack(song)]});
 assert.deepEqual(result.tracks.map(t=>t.id),['a']);assert.equal(result.artists[0].name,'Björk');assert.ok(calls.includes('/users/ArtistOne/tracks'));
});
test('offline search normalizes accents, case and ё and never calls the network',async()=>{
 const tracks=[normalizeTrack(raw('a','Ещё один день','Björk'))];
 assert.equal(searchLocal(tracks,'еще').tracks[0].id,'a');
 const result=await searchCatalog('BJORK',()=>{throw Error('network');},{offline:true,localTracks:tracks});assert.equal(result.tracks.length,1);
});
test('partial search succeeds, total failure throws and an aborted search cannot advance',async()=>{
 const result=await searchCatalog('Song',async path=>{if(path==='/users/search')throw Error('down');return[raw('a','Song')];});assert.equal(result.partial,true);assert.equal(result.tracks.length,1);
 await assert.rejects(searchCatalog('x',async()=>{throw Error('down');}));
 const controller=new AbortController();await assert.rejects(searchCatalog('x',async()=>{controller.abort();return [];},{signal:controller.signal}),{name:'AbortError'});
});
test('public playlist links use fixed endpoints and reject spoofed and unrelated URLs',()=>{
 assert.equal(parseYandexPlaylistURL('https://music.yandex.ru/users/name/playlists/123?utm_source=x').path,'/users/name/playlists/123');
 assert.equal(parseYandexPlaylistURL('https://music.yandex.ru/playlists/12345678-1234-1234-1234-123456789abc').path,'/playlist/12345678-1234-1234-1234-123456789abc');
 for(const url of ['http://music.yandex.ru/users/x/playlists/1','https://music.yandex.ru.evil.com/users/x/playlists/1','https://x:secret@music.yandex.ru/users/x/playlists/1','https://music.yandex.ru:444/users/x/playlists/1','https://music.yandex.ru/album/1','https://localhost/users/x/playlists/1'])assert.throws(()=>parseYandexPlaylistURL(url));
});
test('Yandex reader hydrates short track metadata and rejects partial playlist responses',async()=>{
 const calls=[];const lib=await requestPublicYandexPlaylist('https://music.yandex.ru/users/test/playlists/1',async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/tracks')?{result:[{id:12,title:'Song',artists:[{name:'Artist'}],durationMs:200000}]}:{result:{title:'List',trackCount:1,tracks:[{id:12}]}});});
 assert.equal(lib.tracks[0].duration,200);assert.ok(calls.every(c=>c.url.startsWith('https://api.music.yandex.net/')));assert.equal(calls[1].options.method,'POST');assert.match(calls[1].options.body,/track-ids=12/);
 assert.throws(()=>parseYandexPlaylist({result:{title:'Incomplete',trackCount:2,tracks:[{title:'Song'}]}}),/неполный/);
 await assert.rejects(requestPublicYandexPlaylist('https://music.yandex.ru/users/test/playlists/1',async()=>new Response('',{status:403})),/не разрешил/);
});
test('file imports preserve quoted CSV, Russian headers, multiple artists and text lists',()=>{
 assert.equal(parseImportFile('Исполнитель;Название\n"Артист";"Песня; часть 2"','songs.csv').tracks[0].title,'Песня; часть 2');
 assert.equal(parseImportFile(JSON.stringify({name:'Liked',tracks:[{title:'Song',artists:[{name:'A'},{name:'B'}]}]})).tracks[0].artists.length,2);
 assert.equal(parseImportFile('Artist — Song\nOther — Another','x.txt').tracks.length,2);
 assert.throws(()=>parseImportFile('artist,title\nA,"bad','x.csv'),/кавычки/);
});
test('matching accepts exact artist/title and rejects automatic covers, wrong artists and missing artist names',()=>{
 const source={title:'Song',artists:['Artist'],duration:200};
 assert.equal(matchConfidence(source,normalizeTrack(raw('a','Song'))).automatic,true);
 assert.equal(matchConfidence(source,normalizeTrack(raw('a','Song (Cover)'))).automatic,false);
 assert.equal(matchConfidence(source,normalizeTrack(raw('a','Song','Another artist'))).automatic,false);
 assert.equal(matchConfidence({...source,artists:[]},normalizeTrack(raw('a','Song'))).automatic,false);
});
test('library matching keeps missing tracks, deduplicates imports and preserves the existing library',async()=>{
 const library=parseImportFile(JSON.stringify({title:'From Yandex',tracks:[{title:'Song',artist:'Artist'},{title:'Missing',artist:'Other'},{title:'Song',artist:'Artist'}]}));
 let requests=0;const items=await matchLibrary(library,async(_route,p)=>{requests++;return p.query.includes('Missing')?[]:[raw('a','Song')];});
 assert.equal(items[0].selectedId,'a');assert.equal(items[1].status,'missing');assert.equal(requests,3);
 const state=initialState();state.likes=['existing'];state.playlists=[{id:'old',trackIds:['existing']}];const next=applyLibraryImport(state,library,items,{id:'imported',at:1});
 assert.deepEqual(next.likes,['existing']);assert.deepEqual(next.playlists[1].trackIds,['a']);assert.equal(next.imports[0].entries.length,3);assert.equal(next.imports[0].entries[1].trackId,null);
 assert.throws(()=>applyLibraryImport(state,library,items.map(i=>({...i,selectedId:null}))),/подтверди/);
});
test('appearance rejects unrecognized palettes and non-supported scale values',()=>{
 assert.equal(appearanceVariables({palette:'unknown',textScale:30})['--accent'],'#c4b5fd');assert.equal(appearanceVariables({palette:'ocean',textScale:1.12})['--text-scale'],1.12);
});
