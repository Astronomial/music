// Runs inside the real Electron main process. The extractor is controlled, but
// CDN bytes, redirects and cancellation use Chromium's actual network stack.
export async function installMediaFixture({net,app},{audio,hlsFiles={}}){
  const require=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/electron/main.cjs');
  const assert=require('node:assert/strict'),http=require('node:http');
  const {mediaFetch}=require('./media-fetch.cjs'),bytes=Buffer.from(audio,'base64');
  const seen=[];let closedSlow=0,closedStall=0;
  const server=http.createServer((request,response)=>{
    const url=new URL(request.url,'http://localhost');
    seen.push({path:url.pathname,range:url.searchParams.get('range'),headers:request.headers});
    if(url.pathname==='/stall'){response.once('close',()=>closedStall++);return;}
    if(url.pathname==='/redirect'){response.writeHead(302,{Location:'/direct'});response.end();return;}
    if(url.pathname.includes('/hls/')){
      const name=url.pathname.split('/').at(-1),encoded=hlsFiles[name];
      if(!encoded){response.writeHead(404);response.end();return;}
      const data=Buffer.from(encoded,'base64'),range=url.searchParams.get('range'),[start,end]=range?range.split('-').map(Number):[0,data.length-1],part=data.subarray(start,Math.min(end+1,data.length));
      response.writeHead(200,{'Content-Type':name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'application/octet-stream','Content-Length':String(part.length)});response.end(part);return;
    }
    if(url.pathname.startsWith('/r1.googlevideo.com/')){response.writeHead(302,{Location:'https://r2.googlevideo.com/native-audio'});response.end();return;}
    if(url.pathname==='/slow'){response.once('close',()=>closedSlow++);response.writeHead(200,{'Content-Type':'audio/mp4'});response.write(bytes.subarray(0,1024));return;}
    const range=url.searchParams.get('range'),[start,end]=range?range.split('-').map(Number):[0,bytes.length-1],part=bytes.subarray(start,Math.min(end+1,bytes.length));
    response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':String(part.length)});response.end(part);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  app.once('will-quit',()=>{server.closeAllConnections();server.close();});
  const headers={Accept:'*/*','Accept-Encoding':'identity',Origin:'https://www.youtube.com','User-Agent':'FormaNativeTest/1'};
  const direct=await mediaFetch(net,base+'/direct',{headers});
  assert.equal(direct.status,200);assert.deepEqual(Buffer.from(await direct.arrayBuffer()),bytes);
  assert.equal(seen.at(-1).headers.origin,headers.Origin);assert.equal(seen.at(-1).headers['user-agent'],headers['User-Agent']);
  const redirect=await mediaFetch(net,base+'/redirect',{headers});assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),base+'/direct');
  const partial=await mediaFetch(net,base+'/direct?range=8-31',{headers});assert.equal((await partial.arrayBuffer()).byteLength,24);
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(mediaFetch(net,base+'/direct',{signal:cancelled.signal}),{name:'AbortError'});
  const stalled=new AbortController(),pending=mediaFetch(net,base+'/stall',{signal:stalled.signal});setTimeout(()=>stalled.abort(),50);await assert.rejects(pending,{name:'AbortError'});
  const active=new AbortController(),stream=await mediaFetch(net,base+'/slow',{signal:active.signal}),reader=stream.body.getReader();await reader.read();active.abort();await assert.rejects(reader.read());
  const probe=await mediaFetch(net,base+'/slow');await probe.body.cancel();
  const deadline=Date.now()+3000;while((closedSlow<2||closedStall<1)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(closedSlow,2,'aborted playback and cancelled probe must close network connections');assert.equal(closedStall,1);
  const original=net.request.bind(net);
  net.request=options=>{
    const parsed=new URL(typeof options==='string'?options:options.url);
    if(/(^|\.)googlevideo\.com$/.test(parsed.hostname)){
      assert.equal(parsed.protocol,'https:');
      options={...options,url:base+'/'+parsed.hostname+parsed.pathname+parsed.search};
    }
    return original(options);
  };
  globalThis.nativeMediaRequests=seen;
  return{direct:true,redirect:true,range:true,abortBeforeHeaders:true,abortDuringBody:true,cancelProbe:true};
}
