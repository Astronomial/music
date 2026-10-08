const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2'};
// A loopback origin lets the official IFrame API validate postMessage origins.
// The server serves immutable UI assets only; native operations remain behind IPC.
async function startStaticServer(root){
  const server=http.createServer(async(req,res)=>{
    try{
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
      const url=new URL(req.url,'http://localhost');
      const relative=decodeURIComponent(url.pathname).replace(/^\/+/,''),file=path.resolve(root,relative||'index.html');
      if(!file.startsWith(root+path.sep)||!mime[path.extname(file)]){res.writeHead(404);res.end();return;}
      const data=await fs.readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Content-Length':data.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});res.end(req.method==='HEAD'?undefined:data);
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {server,url:`http://127.0.0.1:${server.address().port}/index.html`};
}
module.exports={startStaticServer};
