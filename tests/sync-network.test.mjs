import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {initialState} from '../src/core/model.mjs';
import {portableLibrary} from '../src/core/sync.mjs';
const require=createRequire(import.meta.url),{privateIP,lanInterfaces}=require('../electron/sync-network.cjs'),{SyncServer,LibraryCoordinator}=require('../electron/sync.cjs'),{Store}=require('../electron/storage.cjs'),{firewallScript}=require('../electron/sync-firewall.cjs');
const nic=address=>({address,family:'IPv4',internal:false});
test('real Ethernet/Wi-Fi precedes VPN, virtual and link-local adapters; public/malformed IPs never enter codes',()=>{
 const list=lanInterfaces({'VPN tun0':[nic('10.8.0.2')],'vEthernet (WSL)':[nic('172.20.1.1')],Ethernet:[nic('192.168.1.8')],WiFi:[nic('10.0.0.3')],Auto:[nic('169.254.1.2')],Public:[nic('8.8.8.8')],Bad:[nic('192.168.1.999')]});
 assert.equal(list[0].name,'Ethernet');assert.deepEqual(list.slice(0,2).map(x=>x.kind),['lan','lan']);assert.equal(list.length,5);
 for(const ip of ['192.168.1.999','10.abc.0.1','8.8.8.8','100.64.0.1','172.32.0.1','::1'])assert.equal(privateIP(ip),false,ip);
 assert.equal(privateIP('::ffff:192.168.1.9'),true);
});
async function fixture(networkInterfaces,run){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forma-lan-')),store=new Store(dir);await store.write('library.json',initialState());const server=new SyncServer({store,coordinator:new LibraryCoordinator(store),networkInterfaces,port:0});try{await run(server,store);}finally{await server.stop();await fs.rm(dir,{recursive:true,force:true});}}
async function request(server,store,route,body={},token){
 const identity=await store.read('sync-identity.json');
 return new Promise((resolve,reject)=>{const req=https.request({hostname:'127.0.0.1',port:server.server.address().port,path:route,method:'POST',ca:identity.cert,checkServerIdentity:(_host,cert)=>{if(crypto.createHash('sha256').update(cert.raw).digest('hex')!==server.pin)return Error('Wrong pin');},headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}},res=>{let data='';res.on('data',b=>data+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));});req.on('error',reject);req.end(JSON.stringify(body));});
}
test('actual TLS binds all adapters, concurrent start is safe, lost pair replies are idempotent and DHCP preserves credentials/drafts',async()=>{
 let interfaces={'VPN tun0':[nic('10.8.0.2')],Ethernet:[nic('192.168.1.8')]};
 await fixture(()=>interfaces,async(server,store)=>{
  const [a,b]=await Promise.all([server.start(),server.start()]);assert.equal(a.address,'192.168.1.8');assert.equal(a.pairing,b.pairing);assert.equal(server.server.address().address,'0.0.0.0');
  const code=new URL(a.pairing),pin=server.pin,requestID=crypto.randomUUID();assert.ok(code.searchParams.get('hosts').includes('10.8.0.2'));
  assert.equal((await request(server,store,'/health')).status,200);
  const body={code:code.searchParams.get('code'),requestID,name:'iPhone'};
  const pair=await request(server,store,'/pair',body),retry=await request(server,store,'/pair',body);assert.equal(pair.status,200);assert.deepEqual(retry.body,pair.body);assert.equal(server.devices.length,1);
  assert.equal((await request(server,store,'/pair',{...body,requestID:crypto.randomUUID()})).status,403);
  const token=pair.body.token,id=crypto.randomUUID(),library=portableLibrary(initialState());
  const draft=await request(server,store,'/sync/prepare',{id,library},token);assert.equal(draft.body.status,'pending');
  interfaces={Ethernet:[nic('192.168.2.8')]};assert.equal(server.status().address,'192.168.2.8');
  await server.stop({persist:false});await server.start();assert.equal(server.pin,pin);assert.equal((await request(server,store,'/sync/ping',{},token)).status,200);
  assert.equal((await request(server,store,'/sync/status',{id},token)).body.status,'pending');
  assert.equal((await request(server,store,'/sync/approve',{id},token)).body.status,'approved');
 });
});
test('enabling before Ethernet appears recovers without restarting; explicit adapter choice survives restart',async()=>{
 let interfaces={};await fixture(()=>interfaces,async(server)=>{
  await server.start();const pin=server.pin;assert.equal(server.status().pairing,null);
  interfaces={'VPN tun0':[nic('10.8.0.2')],Ethernet:[nic('192.168.1.8')]};assert.ok(server.status().pairing);
  await server.selectAddress('10.8.0.2');await server.stop({persist:false});await server.start();assert.equal(server.status().address,'10.8.0.2');assert.equal(server.pin,pin);
  await assert.rejects(server.selectAddress('8.8.8.8'));
 });
});
test('firewall permission is limited to one TCP port, Private profile and LocalSubnet',()=>{
 const script=firewallScript(30377);assert.match(script,/-LocalPort 30377 /);assert.match(script,/-Profile Private/);assert.match(script,/-RemoteAddress LocalSubnet/);assert.match(script,/-Protocol TCP/);assert.match(script,/-EdgeTraversalPolicy Block/);
 assert.doesNotMatch(script,/Public|Any|Set-NetFirewallProfile|Disable/);
 for(const value of [0,65536,30377.5,'30377;bad'])assert.throws(()=>firewallScript(value));
});
