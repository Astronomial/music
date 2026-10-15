const {Readable}=require('node:stream');
// net.fetch rejects redirect:'manual' in Electron. Expose the redirect as a
// response so the audio resolver can validate every target before requesting it.
function mediaFetch(net,input,options={}){
  return new Promise((resolve,reject)=>{
    const request=net.request({url:String(input),method:'GET',redirect:'manual',credentials:'omit',cache:'no-store'});
    let settled=false,response;
    const cleanup=()=>options.signal?.removeEventListener('abort',abort);
    const abort=()=>{const error=options.signal?.reason||new DOMException('Aborted','AbortError');request.abort();response?.destroy(error);if(!settled){settled=true;cleanup();reject(error);}};
    request.on('error',error=>{if(!settled){settled=true;cleanup();reject(error);}else response?.destroy(error);});
    request.on('redirect',(status,_method,url)=>{
      if(settled)return;settled=true;cleanup();resolve(new Response(null,{status,headers:{Location:url}}));request.abort();
    });
    request.on('response',incoming=>{
      if(settled){incoming.destroy();return;}response=incoming;
      const headers=new Headers();for(const [key,value]of Object.entries(incoming.headers))headers.set(key,Array.isArray(value)?value.join(', '):String(value));
      const body=Readable.toWeb(incoming);settled=true;
      incoming.once('end',cleanup);incoming.once('error',cleanup);
      incoming.once('close',()=>{cleanup();if(!incoming.readableEnded)request.abort();});
      resolve(new Response(body,{status:incoming.statusCode,headers}));
    });
    try{
      options.signal?.throwIfAborted();options.signal?.addEventListener('abort',abort,{once:true});
      for(const [key,value]of new Headers(options.headers))request.setHeader(key,value);
      request.end();
    }catch(error){request.abort();if(!settled){settled=true;cleanup();reject(error);}}
  });
}
module.exports={mediaFetch};
