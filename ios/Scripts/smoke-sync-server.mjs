import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {initialState,normalizeTrack} from '../../src/core/model.mjs';
const require=createRequire(import.meta.url),{Store}=require('../../electron/storage.cjs'),{SyncServer,LibraryCoordinator}=require('../../electron/sync.cjs');
const dir=process.argv[2];if(!dir)throw new Error('Expected temporary directory');
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
process.on('SIGTERM',async()=>{await server.stop();process.exit(0);});
