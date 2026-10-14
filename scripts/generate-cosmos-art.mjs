import fs from 'node:fs/promises';
// Original, deterministic vector artwork. No remote textures or runtime particle simulation.
let seed=76143;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const f=n=>n.toFixed(2),colors=['#ece3ff','#cdb4ff','#ad76f6','#8d63eb','#c4d1ff'];
const paths=[],dust=[];
for(let arm=0;arm<4;arm++){
  const points=Array.from({length:100},(_,i)=>{const t=i/99,r=14+Math.pow(t,1.25)*414,a=arm*Math.PI/2+t*Math.PI*2.2;return `${i?'L':'M'}${f(512+Math.cos(a)*r)},${f(512+Math.sin(a)*r)}`;}).join(' ');
  paths.push(`<path d="${points}" fill="none" stroke="url(#arm)" stroke-width="${arm%2?12:25}" stroke-linecap="round" opacity="${arm%2?.12:.3}"/>`);
}
for(let i=0;i<2450;i++){
  const t=Math.pow(random(),.8),r=12+Math.pow(t,1.25)*410,arm=i%4,a=arm*Math.PI/2+t*Math.PI*2.2;
  const spread=(random()+random()+random()-1.5)*(5+31*t),along=(random()-.5)*17;
  const x=512+Math.cos(a)*(r+along)-Math.sin(a)*spread,y=512+Math.sin(a)*(r+along)+Math.cos(a)*spread;
  dust.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(.35+random()*(1.4-t*.7))}" fill="${colors[i%colors.length]}" opacity="${f((.18+random()*.62)*(1-t*.45))}"/>`);
}
const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><radialGradient id="halo"><stop stop-color="#e1c1ff" stop-opacity=".55"/><stop offset=".2" stop-color="#a567ff" stop-opacity=".28"/><stop offset=".65" stop-color="#6728c4" stop-opacity=".14"/><stop offset="1" stop-color="#451689" stop-opacity="0"/></radialGradient><radialGradient id="arm"><stop stop-color="#f4e7ff"/><stop offset=".3" stop-color="#d4a2ff"/><stop offset=".7" stop-color="#9d61ed"/><stop offset="1" stop-color="#6f43d9" stop-opacity="0"/></radialGradient><radialGradient id="core"><stop stop-color="#fff9ff"/><stop offset=".08" stop-color="#fff4ff" stop-opacity=".98"/><stop offset=".25" stop-color="#e5c5ff" stop-opacity=".8"/><stop offset=".55" stop-color="#ac6aff" stop-opacity=".3"/><stop offset="1" stop-color="#9a50f0" stop-opacity="0"/></radialGradient><filter id="soft"><feGaussianBlur stdDeviation="7"/></filter></defs><circle cx="512" cy="512" r="470" fill="url(#halo)"/><g filter="url(#soft)">${paths.join('')}</g>${paths.join('')}${dust.join('')}<circle cx="512" cy="512" r="90" fill="url(#core)"/><circle cx="512" cy="512" r="4" fill="#fff9ff"/></svg>`;
await fs.mkdir(new URL('../src/assets/',import.meta.url),{recursive:true});
await fs.writeFile(new URL('../src/assets/pulse-galaxy.svg',import.meta.url),svg);
const stars=Array.from({length:230},(_,i)=>`<circle cx="${f(random()*1600)}" cy="${f(random()*1000)}" r="${f(.45+random()*.65)}" fill="${i%4?'#f0eff6':'#ffffff'}" opacity="${f(.14+random()*.48)}"/>`);
await fs.writeFile(new URL('../src/assets/starfield.svg',import.meta.url),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000">${stars.join('')}</svg>`);
