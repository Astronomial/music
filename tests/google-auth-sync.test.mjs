import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {GoogleAuth} from '../electron/google-auth.cjs';import {GoogleSync} from '../electron/google-sync.cjs';
import {initialState,normalizeTrack} from '../src/core/model.mjs';
const memory=()=>({files:new Map(),read:async function(k,f){return structuredClone(this.files.has(k)?this.files.get(k):f);},write:async function(k,v){this.files.set(k,structuredClone(v));}});
const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
const clientID='123456789-test.apps.googleusercontent.com',secret='only-local-secret';
test('native OAuth checks state and PKCE, persists offline access and does not expose tokens',async()=>{
  const store=memory();let query,grant,tokenRequests=0;
  const auth=new GoogleAuth({store,safeStorage,fetch:async(url,o)=>{
    if(url.includes('/token')){tokenRequests++;grant=new URLSearchParams(o.body);return Response.json({access_token:'access-private',refresh_token:'refresh-private',expires_in:3600});}
    return Response.json({sub:'123456789012345',email:'owner@example.com'});
  },openExternal:async url=>{query=new URL(url).searchParams;assert.ok(!url.includes(secret));const callback=new URL(query.get('redirect_uri'));callback.searchParams.set('state','wrong');assert.equal((await fetch(callback)).status,400);callback.searchParams.set('state',query.get('state'));callback.searchParams.set('code','one-use-code');await fetch(callback);}});
  const status=await auth.login(clientID,secret);assert.equal(status.email,'owner@example.com');assert.equal(status.connected,true);assert.ok(!JSON.stringify(status).includes('private'));assert.equal(query.get('code_challenge'),createHash('sha256').update(grant.get('code_verifier')).digest('base64url'));assert.equal(grant.get('client_secret'),secret);assert.equal(tokenRequests,1);assert.ok(query.get('scope').includes('drive.appdata'));
  const restored=new GoogleAuth({store,safeStorage,fetch:auth.fetch,openExternal:()=>{}});await restored.restore();assert.equal(restored.status().connected,true);await restored.logout();assert.equal(restored.status().connected,false);
});
test('concurrent API requests coalesce refresh and never send credentials to arbitrary hosts',async()=>{
  let refreshes=0,requests=0;const auth=new GoogleAuth({store:memory(),safeStorage,fetch:async(url,o)=>{if(url.includes('/token')){refreshes++;await new Promise(r=>setTimeout(r,10));return Response.json({access_token:'fresh',expires_in:3600});}requests++;assert.equal(o.headers.Authorization,'Bearer fresh');assert.equal(o.redirect,'error');return Response.json({});}});
  auth.credentials={clientID,secret,sub:'123456789012345',refreshToken:'refresh',accessToken:'old',expires:0};await Promise.all(Array.from({length:10},()=>auth.authorizedFetch('https://www.googleapis.com/drive/v3/files')));assert.equal(refreshes,1);assert.equal(requests,10);await assert.rejects(auth.authorizedFetch('https://elsewhere.invalid/path'));assert.equal(requests,10);
});
test('cloud sync retains pending edits on failure, isolates accounts and writes each device file',async()=>{
  const store=memory(),state=initialState(),video='abcdefghijk';state.tracks['yt_'+video]=normalizeTrack({id:'yt_'+video,source:'youtube',videoId:video,title:'Трек',artist:'Автор'});state.dislikes=['yt_'+video];await store.write('library.json',state);
  const files=new Map();let unavailable=true,uploaded=[];
  const auth={credentials:{sub:'123456789012345'},status:()=>({connected:true}),authorizedFetch:async(url,o)=>{
    if(unavailable)throw new Error('offline');
    if(o.method==='POST'){const multipart=o.body,body=multipart.split('Content-Type: application/json\r\n\r\n')[1].split('\r\n--')[0],doc=JSON.parse(body),id='file-'+files.size;files.set(id,doc);uploaded.push(id);return Response.json({id});}
    if(o.method==='PATCH'){const id=new URL(url).pathname.split('/').at(-1);files.set(id,JSON.parse(o.body));uploaded.push(id);return Response.json({id});}
    if(url.includes('alt=media'))return Response.json(files.get(new URL(url).pathname.split('/').at(-1)));
    return Response.json({files:[...files].map(([id,d])=>({id,appProperties:{actor:d.actor}}))});
  }};
  const coordinator={mutate:async fn=>{const state=await fn(await store.read('library.json'));await store.write('library.json',state);return state;}};
  const sync=new GoogleSync({auth,store,coordinator,onChange:()=>{}});
  try{const failed=await sync.run(true);assert.equal(failed.error,'offline');const captured=await store.read('google-cloud-123456789012345.json');assert.deepEqual(captured.base.dislikedIDs,[video]);
    unavailable=false;assert.equal((await sync.run(true)).error,'');assert.equal(files.size,1);await sync.run(true);assert.equal(files.size,1);assert.equal(uploaded[0],uploaded[1]);
    auth.credentials={sub:'987654321012345'};files.clear();await sync.reset();await sync.run(true);assert.ok(store.files.has('google-cloud-987654321012345.json'));assert.notEqual((await store.read('google-cloud-987654321012345.json')).document.actor,captured.document.actor);
  }finally{clearInterval(sync.poll);clearTimeout(sync.timer);}
});
