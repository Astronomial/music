import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {initialState,normalizeTrack} from '../../src/core/model.mjs';
const require=createRequire(import.meta.url),{Store}=require('../../electron/storage.cjs'),{SyncServer,LibraryCoordinator}=require('../../electron/sync.cjs');
const dir=process.argv[2];if(!dir)throw new Error('Expected temporary directory');
// A delayed loopback WAV response exercises AVPlayer's real buffering state.
// This is generated test audio, with no live music/CDN request.
const samples=22050*5,wav=Buffer.alloc(44+samples*2);
wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
wav.writeUInt32LE(22050,24);wav.writeUInt32LE(44100,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
wav.write('data',36);wav.writeUInt32LE(samples*2,40);
for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(Math.sin(i*440*2*Math.PI/22050)*650),44+i*2);
const audioServer=http.createServer((request,response)=>{
  const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers.range||'');
  const start=range?Math.min(wav.length-1,Number(range[1])):0;
  const end=range&&range[2]?Math.min(wav.length-1,Number(range[2])):wav.length-1;
  const bytes=wav.subarray(start,Math.max(start,end)+1);
  response.writeHead(range?206:200,{'Content-Type':'audio/wav','Accept-Ranges':'bytes','Content-Length':bytes.length,...(range?{'Content-Range':`bytes ${start}-${Math.max(start,end)}/${wav.length}`}:{})});
  response.flushHeaders();
  const timer=setTimeout(()=>response.end(bytes),4000);
  response.on('close',()=>clearTimeout(timer));
});
await new Promise(resolve=>audioServer.listen(0,'127.0.0.1',resolve));
await fs.writeFile(path.join(dir,'audio-fixture-url.txt'),`http://127.0.0.1:${audioServer.address().port}/slow.wav`);
const store=new Store(dir),state=initialState();
for(let i=0;i<4;i++){const videoId=String(i).padStart(11,'0'),t=normalizeTrack({id:'yt_'+videoId,videoId,source:'youtube',title:'Проверка '+i,artist:'Artist '+i,duration:5,genre:'House'});state.tracks[t.id]=t;}
state.likes=['yt_00000000000'];await store.write('library.json',state);
const server=new SyncServer({store,coordinator:new LibraryCoordinator(store),host:'127.0.0.1',port:0});
// The simulator runner watches this file's mtime. Publish the complete code
// atomically so it cannot observe a truncated file between open and write.
async function publishPairing(pairing){
  const target=path.join(dir,'pair-code.txt'),temporary=target+'.tmp';
  await fs.writeFile(temporary,pairing);await fs.rename(temporary,target);
}
await server.start();await publishPairing(server.status().pairing);
console.log('Ready: ephemeral pinned TLS test server');
process.on('SIGUSR1',async()=>{await publishPairing(server.newPairing().pairing);});
process.on('SIGTERM',async()=>{audioServer.closeAllConnections();audioServer.close();await server.stop();process.exit(0);});
