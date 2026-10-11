const https=require('node:https'),crypto=require('node:crypto'),os=require('node:os'),fs=require('node:fs/promises'),path=require('node:path');
const {createIdentity}=require('./sync-certificate.cjs');
const {SyncApprovals}=require('./sync-approval.cjs');
const privateIP=ip=>/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip.replace(/^::ffff:/,''));
class LibraryCoordinator {
  constructor(store){this.store=store;this.queue=Promise.resolve();}
  mutate(fn,{afterWrite}={}){const run=async()=>{const current=await this.store.read('library.json',null);const next=await fn(current);await this.store.write('library.json',next);await afterWrite?.(next);return next;};this.queue=this.queue.then(run,run);return this.queue;}
}
class SyncServer {
  constructor({store,coordinator,onChange,host,port=30377}){Object.assign(this,{store,coordinator,onChange,host,port});this.server=null;this.pairing=null;this.devices=[];this.attempts=new Map();this.approvals=new SyncApprovals({store,coordinator,onChange});}
  async start(){
    if(this.server)return this.status();
    const addresses=Object.values(os.networkInterfaces()).flat().filter(x=>x&&x.family==='IPv4'&&!x.internal&&privateIP(x.address));
    this.address=this.host||addresses[0]?.address;if(!this.address)throw new Error('Подключи ПК к домашней Wi-Fi сети.');
    let identity=await this.store.read('sync-identity.json',null);if(!identity||identity.address!==this.address){identity=createIdentity(new Date(),this.address);await this.store.write('sync-identity.json',identity);await fs.chmod(path.join(this.store.dir,'sync-identity.json'),0o600).catch(()=>{});}
    this.pin=new crypto.X509Certificate(identity.cert).fingerprint256.replace(/:/g,'').toLowerCase();
    this.devices=await this.store.read('sync-devices.json',[]);
    await this.approvals.restore(this.devices.map(d=>d.id));
    const server=https.createServer({key:identity.key,cert:identity.cert,minVersion:'TLSv1.2'},(req,res)=>this.handle(req,res).catch(()=>{if(!res.headersSent)res.writeHead(400);res.end(JSON.stringify({error:'Некорректный запрос синхронизации'}));}));
    server.requestTimeout=20000;server.headersTimeout=10000;server.maxConnections=12;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(this.port,this.address,resolve);});this.server=server;await this.store.write('sync-settings.json',{enabled:true});this.newPairing();return this.status();
  }
  newPairing(){if(!this.server)throw new Error('Сначала включи синхронизацию');this.pairing={code:crypto.randomInt(100000,1000000).toString(),expires:Date.now()+300000};return this.status();}
  status(){return {protocolVersion:2,pending:this.approvals.pending(),enabled:!!this.server,address:this.address||'',devices:this.devices.map(d=>({id:d.id,name:d.name})),pairing:this.server&&this.pairing&&this.pairing.expires>Date.now()?`forma://pair?host=${this.address}&port=${this.server.address().port}&pin=${this.pin}&code=${this.pairing.code}`:null};}
  async stop({persist=true}={}){const server=this.server;this.server=null;this.pairing=null;if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(persist)await this.store.write('sync-settings.json',{enabled:false});return this.status();}
  async forget(){await this.approvals.forget();this.devices=[];await this.store.write('sync-devices.json',[]);return this.status();}
  async handle(req,res){
    const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    if(!privateIP(req.socket.remoteAddress||'')||req.method!=='POST'||req.headers.origin)return send(403,{error:'Доступ разрешён только приложению в локальной сети'});
    if(!['/pair','/sync','/sync/prepare','/sync/status','/sync/approve','/sync/reject','/sync/ack'].includes(req.url))return send(404,{error:'Не найдено'});
    if(Number(req.headers['content-length'])>8*1024**2)return send(413,{error:'Библиотека слишком большая'});
    const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>8*1024**2){req.destroy();return;}chunks.push(part);}
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(req.url==='/pair'){
      const key=req.socket.remoteAddress,record=this.attempts.get(key)||{at:Date.now(),count:0};if(Date.now()-record.at>60000){record.at=Date.now();record.count=0;}record.count++;this.attempts.set(key,record);
      if(record.count>8)return send(429,{error:'Подожди минуту перед следующей попыткой'});
      if(!this.pairing||this.pairing.expires<Date.now()||body.code!==this.pairing.code)return send(403,{error:'Код подключения истёк. Создай новый на ПК'});
      const token=crypto.randomBytes(32).toString('hex'),device={id:crypto.randomUUID(),name:String(body.name||'iPhone').slice(0,60),hash:crypto.createHash('sha256').update(token).digest('hex')};
      this.pairing=null;this.devices.push(device);this.devices=this.devices.slice(-5);await this.store.write('sync-devices.json',this.devices);return send(200,{token,deviceID:device.id,protocolVersion:2});
    }
    const token=(req.headers.authorization||'').replace(/^Bearer /,'');const hash=crypto.createHash('sha256').update(token).digest();
    const device=this.devices.find(d=>{const expected=Buffer.from(d.hash,'hex');return expected.length===hash.length&&crypto.timingSafeEqual(expected,hash);});
    if(!device)return send(401,{error:'Подключи телефон к ПК заново'});
    if(req.url==='/sync')return send(426,{error:'Обнови Forma на обоих устройствах: теперь каждый обмен требует подтверждения'});
    try {
      const data=req.url==='/sync/prepare'?await this.approvals.prepare(device,body)
        :req.url==='/sync/status'?await this.approvals.review(device.id,body.id)
        :req.url==='/sync/approve'?await this.approvals.approve(body.id,device.id)
        :req.url==='/sync/reject'?await this.approvals.reject(body.id,device.id)
        :await this.approvals.acknowledge(body.id,device.id);
      send(200,data);
    } catch(e){send(409,{error:e.message});}
  }
}
module.exports={SyncServer,LibraryCoordinator,privateIP};
