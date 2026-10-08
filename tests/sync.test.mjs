import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {initialState,normalizeTrack} from '../src/core/model.mjs';
import {portableLibrary,mergePortable,applyPortable,mergeDesktop,mergeObjects} from '../src/core/sync.mjs';
const require=createRequire(import.meta.url),{Store}=require('../electron/storage.cjs'),{SyncServer,LibraryCoordinator}=require('../electron/sync.cjs'),{createIdentity}=require('../electron/sync-certificate.cjs');
function library(){const s=initialState();for(let i=0;i<3;i++){const videoId=String(i).padStart(11,'0'),t=normalizeTrack({id:'yt_'+videoId,videoId,source:'youtube',title:'Песня '+i,artist:'Артист '+i,genre:'House',duration:200});s.tracks[t.id]=t;}s.likes=['yt_00000000000'];s.playlists=[{id:'pc',name:'На ПК',trackIds:[s.likes[0]]}];s.events=[{trackId:s.likes[0],type:'play',at:1800000000000,newArtist:true,surface:'pulse'}];s.settings.apiKey='never-export-me';s.tracks.local_file={id:'local_file',source:'local',title:'Local',path:'C:/private/music.mp3'};return s;}
test('portable library excludes secrets/files and preserves exposure, exclusions and diversity preferences',()=>{
 const s=library();s.hidden=['yt_00000000002','local_file'];s.settings.excludedGenres=['Rock'];s.settings.artistDiversity=1;
 const p=portableLibrary(s),bytes=JSON.stringify(p);assert.ok(!bytes.includes('never-export-me'));assert.ok(!bytes.includes('C:/'));assert.ok(!bytes.includes('local_file'));
 assert.equal(p.events[0].kind,'play');assert.equal(p.events[0].newArtist,true);assert.equal(p.settings.artistDiversity,1);assert.deepEqual(p.settings.excludedGenres,['Rock']);assert.deepEqual(p.hiddenIDs,['00000000002']);
 const result=applyPortable(s,p);assert.equal(result.events[0].newArtist,true);assert.equal(result.events[0].surface,'pulse');assert.equal(result.settings.apiKey,'never-export-me');assert.equal(result.tracks.local_file.path,'C:/private/music.mp3');
});
test('three-way sync propagates unlikes, playlist removal and simultaneous PC/phone additions',()=>{
 const base=portableLibrary(library()),pc=structuredClone(base),phone=structuredClone(base);pc.likedIDs.push('00000000001');phone.likedIDs=[];phone.playlists=[];phone.playlists.push({id:'phone',name:'Телефон',trackIDs:['00000000002']});
 const result=mergePortable(pc,base,phone);assert.deepEqual(result.likedIDs,['00000000001']);assert.deepEqual(result.playlists.map(p=>p.id),['phone']);
 const first=mergePortable(base,null,{...phone,likedIDs:['00000000002']});assert.deepEqual(first.likedIDs,['00000000000','00000000002']);assert.ok(first.playlists.some(p=>p.id==='pc'));
});
test('mixed playlists and local/Audius entries survive phone edits; history reset is not undone',()=>{
 const s=library();s.likes.push('local_file');s.playlists[0].trackIds.push('local_file');s.events.push({trackId:'local_file',type:'play',at:1800000000001});
 const p=portableLibrary(s);p.playlists=[];p.events=[];const result=applyPortable(s,p);assert.deepEqual(result.playlists[0].trackIds,['local_file']);assert.ok(result.likes.includes('local_file'));assert.deepEqual(result.events.map(e=>e.trackId),['local_file']);
 const base=portableLibrary(library()),reset={...base,events:[]};assert.deepEqual(mergePortable(reset,base,base).events,[]);
});
test('stale renderer snapshots retain concurrent phone changes and explicit desktop history reset',()=>{
 const base=library(),phone=structuredClone(base),desktop=structuredClone(base);phone.likes.push('yt_00000000001');desktop.settings.volume=.2;
 const result=mergeDesktop(phone,base,desktop);assert.ok(result.likes.includes('yt_00000000001'));assert.equal(result.settings.volume,.2);
 desktop.events=[];assert.deepEqual(mergeDesktop(phone,base,desktop).events,[]);
});
test('JSON dictionary keys cannot mutate object prototypes during merge',()=>{
 const incoming=JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}');
 const result=mergeObjects({}, {}, incoming);assert.equal({}.polluted,undefined);assert.ok(Object.hasOwn(result,'__proto__'));assert.equal(Object.getPrototypeOf(result),Object.prototype);
});
test('each installation generates a distinct verifiable P-256 certificate',()=>{const a=createIdentity(),b=createIdentity(),cert=new crypto.X509Certificate(a.cert);assert.notEqual(a.cert,b.cert);assert.equal(cert.verify(crypto.createPublicKey(a.key)),true);});
function request(server,route,body,{token,origin,chunks=false}={}){
 return new Promise((resolve,reject)=>{const bytes=Buffer.from(JSON.stringify(body));const req=https.request({hostname:'127.0.0.1',port:server.server.address().port,path:route,method:'POST',ca:server.testCertificate,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(origin?{Origin:origin}:{})}},res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(parts).toString())}));});req.on('error',reject);if(chunks){for(let i=0;i<bytes.length;i++)req.write(bytes.subarray(i,i+1));req.end();}else req.end(bytes);});
}
test('actual pinned TLS server pairs once, syncs Unicode data, persists credentials and rejects unauthorized/browser requests',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forma-sync-')),store=new Store(dir);await store.write('library.json',library());let notifications=0;
 const server=new SyncServer({store,coordinator:new LibraryCoordinator(store),host:'127.0.0.1',port:0,onChange:()=>notifications++});
 try{
  await server.start();server.testCertificate=(await store.read('sync-identity.json')).cert;const code=new URL(server.status().pairing).searchParams.get('code'),pin=server.pin;
  assert.equal((await request(server,'/sync',{library:portableLibrary(library())})).status,401);
  const paired=await request(server,'/pair',{code,name:'Мой iPhone'},{chunks:true});assert.equal(paired.status,200);const token=paired.body.token;
  assert.equal((await request(server,'/pair',{code})).status,403);
  assert.equal((await request(server,'/sync',{}, {token,origin:'https://evil.example'})).status,403);
  const base=portableLibrary(library()),mobile=structuredClone(base);mobile.likedIDs=[];mobile.playlists.push({id:'phone',name:'Музыка 🎶 на iPhone',trackIDs:['00000000001']});
  const response=await request(server,'/sync',{base,library:mobile},{token,chunks:true});assert.equal(response.status,200);assert.equal(response.body.library.playlists.at(-1).name,'Музыка 🎶 на iPhone');assert.deepEqual(response.body.library.likedIDs,[]);assert.equal(notifications,1);
  await server.stop({persist:false});await server.start();assert.equal(server.pin,pin);assert.equal((await request(server,'/sync',{base:response.body.library,library:response.body.library},{token})).status,200);
  await server.forget();assert.equal((await request(server,'/sync',{library:mobile},{token})).status,401);
 }finally{await server.stop();await fs.rm(dir,{recursive:true,force:true});}
});
