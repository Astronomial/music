import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {YouTubeCatalog,youtubeTrack,validVideoID} from '../src/core/youtube.mjs';
import {collectYouTubeCandidates} from '../src/core/catalog.mjs';
import {initialState,mergeTracks,recordEvent} from '../src/core/model.mjs';
import {rankTracks} from '../src/core/recommender.mjs';
import {musicSearchResponse} from './fixtures-youtube.mjs';
const require=createRequire(import.meta.url),{OfflineLibrary}=require('../electron/offline.cjs'),{importLocalFile,folderFiles}=require('../electron/local.cjs');
const item=(id='abcdefghijk',artist='Artist')=>({id,title:'Song',artists:[{name:artist,channel_id:'UCabcdefghijklmnop'}],duration:{seconds:200},thumbnails:[{url:'https://i.ytimg.com/test.jpg'}]});
test('installed YouTube.js parser handles raw music song and artist responses without requesting stream data',async()=>{
 const {Innertube}=await import('youtubei.js');let asArtist=false;const calls=[];
 const c=new YouTubeCatalog(()=>Innertube.create({generate_session_locally:true,retrieve_player:false,retrieve_innertube_config:false,fetch:async(url)=>{calls.push(url.url||String(url));return Response.json(musicSearchResponse({artist:asArtist}));}}));
 const songs=await c.request('/tracks/search',{query:'Soft Focus'});assert.equal(songs.items[0].artist,'Test Artist');assert.equal(songs.items[0].duration,200);asArtist=true;
 const artists=await c.request('/users/search',{query:'Test Artist'});assert.equal(artists.items[0].id,'yt_UCabcdefghijklmnop');assert.equal(artists.items[0].name,'Test Artist');assert.ok(calls.every(u=>u.includes('/search')));
});
test('YouTube metadata keeps clean song/artist fields and never exposes downloadable media URLs',()=>{
 const t=youtubeTrack(item());assert.equal(t.id,'yt_abcdefghijk');assert.equal(t.source,'youtube');assert.equal(t.artist,'Artist');assert.equal(t.downloadable,false);assert.equal(t.duration,200);
 assert.equal(validVideoID('bad/path'),false);assert.equal(youtubeTrack({...item(),id:'bad'}),null);
});
test('YouTube catalog shares parallel searches, uses continuation and rejects arbitrary routes',async()=>{
 let requests=0;const next={contents:{contents:[item('12345678901')]},has_continuation:false};
 const catalog=new YouTubeCatalog(async()=>({music:{search:async()=>{requests++;return {contents:[{contents:[item()]}],has_continuation:true,getContinuation:async()=>next};}}}));
 const result=await Promise.all([catalog.request('/tracks/search',{query:'Song'}),catalog.request('/tracks/search',{query:'Song'})]);assert.equal(requests,1);assert.equal(result[0].hasMore,true);
 assert.equal((await catalog.request('/tracks/search',{query:'Song',offset:40})).items[0].videoId,'12345678901');assert.equal((await catalog.request('/tracks/search',{query:'Song',offset:80})).items.length,0);
 await assert.rejects(catalog.request('https://evil.com',{}),/Недопустимый/);
});
test('saved YouTube seeds drive candidate retrieval and taste ranks related music above unrelated music',async()=>{
 const anchor=youtubeTrack(item()),related=youtubeTrack(item('12345678901','New artist'),[anchor.id]),unrelated=youtubeTrack(item('abcdefghij2','Other'));
 let state=mergeTracks(initialState(),[anchor,related,unrelated]);state.likes=[anchor.id];const calls=[];
 const found=await collectYouTubeCandidates(state,async route=>{calls.push(route);return route.startsWith('/related/')?[related]:[unrelated];});assert.ok(calls.includes('/related/abcdefghijk'));assert.equal(found.length,2);
 assert.equal(rankTracks([related,unrelated],state)[0].track.id,related.id);
 state.likes=[];for(let i=0;i<3;i++)state=recordEvent(state,anchor.id,'skip',{seconds:5,ratio:.025});assert.equal(rankTracks([related,unrelated],state)[0].track.id,unrelated.id);
});
test('local file import copies and parses real audio, deduplicates by contents and survives removal of the original',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forma-local-'));
 try{
 const b=Buffer.alloc(16044);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);
 const file=path.join(dir,'Test artist — My song.wav');await fs.writeFile(file,b);await fs.writeFile(path.join(dir,'ignored.txt'),'x');assert.equal((await folderFiles(dir)).length,1);
 const offline=new OfflineLibrary(path.join(dir,'library'));await offline.init();const stored=await importLocalFile(file,offline);assert.equal(stored.track.artist,'Test artist');assert.equal(stored.track.title,'My song');assert.equal(stored.track.source,'local');assert.equal(stored.track.duration,1);
 await importLocalFile(file,offline);assert.equal(Object.keys(offline.list()).length,1);await fs.rm(file);const restarted=new OfflineLibrary(offline.dir);await restarted.init();const response=await restarted.respond(stored.track.id,'bytes=100-199');assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,100);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
