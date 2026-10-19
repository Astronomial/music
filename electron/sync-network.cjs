const os=require('node:os');
function privateIP(value){
  const ip=String(value).replace(/^::ffff:/,''),p=ip.split('.');
  if(p.length!==4||p.some(x=>!/^\d{1,3}$/.test(x)||Number(x)>255))return false;
  const [a,b]=p.map(Number);return a===127||a===10||a===192&&b===168||a===172&&b>=16&&b<=31||a===169&&b===254;
}
function lanInterfaces(interfaces=os.networkInterfaces()){
  const virtual=/virtual|vmware|vbox|hyper-v|vethernet|wsl|tailscale|zerotier|tunnel|tun\d*|tap\d*|wireguard|wintun|vpn|docker|bridge|ppp/i,seen=new Set(),result=[];
  for(const [name,rows] of Object.entries(interfaces))for(const row of rows||[]){
    if(!row||!['IPv4',4].includes(row.family)||row.internal||!privateIP(row.address)||row.address.startsWith('127.')||seen.has(row.address))continue;
    seen.add(row.address);const kind=virtual.test(name)?'virtual':row.address.startsWith('169.254.')?'link-local':'lan';result.push({name,address:row.address,kind});
  }
  return result.sort((a,b)=>({lan:0,'link-local':1,virtual:2}[a.kind]-{lan:0,'link-local':1,virtual:2}[b.kind])||a.name.localeCompare(b.name)||a.address.localeCompare(b.address)).slice(0,8);
}
module.exports={privateIP,lanInterfaces};
