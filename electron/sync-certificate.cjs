const crypto=require('node:crypto');
// Minimal DER X.509 writer. Each installation gets its own P-256 key, pinned by the phone.
const der=(tag,...parts)=>{const b=Buffer.concat(parts.map(x=>Buffer.from(x)));const len=b.length<128?Buffer.from([b.length]):(()=>{let h=b.length.toString(16);if(h.length%2)h='0'+h;const n=Buffer.from(h,'hex');return Buffer.concat([Buffer.from([128+n.length]),n]);})();return Buffer.concat([Buffer.from([tag]),len,b]);};
const seq=(...x)=>der(0x30,...x),oid=h=>der(6,Buffer.from(h,'hex')),int=b=>der(2,b),text=s=>der(12,Buffer.from(s));
function createIdentity(now=new Date()) {
  const keys=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}), algorithm=seq(oid('2a8648ce3d040302'));
  const name=seq(der(0x31,seq(oid('550403'),text('Forma local sync'))));
  const stamp=d=>der(0x17,Buffer.from(d.toISOString().replace(/[-:]/g,'').slice(2,14)+'Z'));
  const until=new Date(now);until.setFullYear(until.getFullYear()+5);
  const serial=crypto.randomBytes(16);serial[0]&=0x7f;
  const tbs=seq(der(0xa0,int([2])),int(serial),algorithm,name,seq(stamp(new Date(now.getTime()-86400000)),stamp(until)),name,keys.publicKey.export({type:'spki',format:'der'}));
  const certificate=seq(tbs,algorithm,der(3,Buffer.from([0]),crypto.sign('sha256',tbs,keys.privateKey)));
  return {key:keys.privateKey.export({type:'pkcs8',format:'pem'}),cert:'-----BEGIN CERTIFICATE-----\n'+certificate.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----\n'};
}
module.exports={createIdentity};
