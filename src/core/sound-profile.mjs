// Derived only from decoded PCM. No title/artist/genre guesses enter this vector.
export function validateSoundProfile(p){
  if(!p||p.version!==1||!Array.isArray(p.bands)||p.bands.length!==8||p.bands.some(x=>!Number.isFinite(x)||x<0||x>1)||p.bands.reduce((a,b)=>a+b,0)<.5)return null;
  const norm=p.bands.reduce((sum,x)=>sum+x*x,0);if(norm<.9||norm>1.1)return null;
  for(const k of ['seconds','tempo','tempoConfidence','dynamicRange','brightness','onsetRate'])if(!Number.isFinite(p[k]))return null;
  if(p.seconds<8||p.seconds>30||p.tempo<0||p.tempo>220||['tempoConfidence','dynamicRange','brightness','onsetRate'].some(k=>p[k]<0||p[k]>1))return null;
  return {version:1,seconds:p.seconds,bands:[...p.bands],tempo:p.tempo,tempoConfidence:p.tempoConfidence,dynamicRange:p.dynamicRange,brightness:p.brightness,onsetRate:p.onsetRate};
}
function fft(re,im){const n=re.length;for(let i=1,j=0;i<n;i++){let b=n>>1;for(;j&b;b>>=1)j^=b;j^=b;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}}for(let len=2;len<=n;len*=2){const a=-2*Math.PI/len;for(let start=0;start<n;start+=len){for(let j=0;j<len/2;j++){const c=Math.cos(a*j),s=Math.sin(a*j),i=start+j,k=i+len/2,x=re[k]*c-im[k]*s,y=re[k]*s+im[k]*c;re[k]=re[i]-x;im[k]=im[i]-y;re[i]+=x;im[i]+=y;}}}}
export function analyzePCM(samples,sampleRate=16000){
  if(sampleRate!==16000||samples.length<sampleRate*8)return null;
  const length=Math.min(samples.length,480000),bands=Array(8).fill(0),bounds=[120,250,500,1000,2000,4000,6000,8001],energies=[],onsets=[];let previous=0;
  const re=new Float64Array(1024),im=new Float64Array(1024);
  for(let start=0;start+1024<=length;start+=512){let energy=0;im.fill(0);for(let i=0;i<1024;i++){const x=Number.isFinite(samples[start+i])?Math.max(-1,Math.min(1,samples[start+i])):0;energy+=x*x;re[i]=x*(.5-.5*Math.cos(2*Math.PI*i/1023));}energy=Math.sqrt(energy/1024);energies.push(energy);onsets.push(Math.max(0,energy-previous));previous=energy;fft(re,im);let band=0;for(let i=4;i<=512;i++){const hz=i*sampleRate/1024;while(band<7&&hz>=bounds[band])band++;bands[band]+=re[i]*re[i]+im[i]*im[i];}}
  const total=bands.reduce((a,b)=>a+b,0);if(total<1e-6)return null;
  const normalized=bands.map(x=>Math.sqrt(x/total)),norm=Math.sqrt(normalized.reduce((a,b)=>a+b*b,0));
  const sorted=[...energies].sort((a,b)=>a-b),p10=sorted[Math.floor(sorted.length*.1)],p90=sorted[Math.floor(sorted.length*.9)],mean=onsets.reduce((a,b)=>a+b,0)/onsets.length;
  let best=0,tempo=0;for(let lag=11;lag<=31;lag++){let dot=0,a=0,b=0;for(let i=lag;i<onsets.length;i++){const x=onsets[i]-mean,y=onsets[i-lag]-mean;dot+=x*y;a+=x*x;b+=y*y;}const c=a*b>1e-12?Math.max(0,dot/Math.sqrt(a*b)):0;if(c>best){best=c;tempo=60*sampleRate/(512*lag);}}
  return validateSoundProfile({version:1,seconds:length/sampleRate,bands:normalized.map(x=>x/norm),tempo:best>=.15?tempo:0,tempoConfidence:best,dynamicRange:Math.min(1,Math.max(0,(p90-p10)/Math.max(.0001,p90))),brightness:normalized.slice(4).reduce((s,x)=>s+x*x,0),onsetRate:Math.min(1,onsets.filter(x=>x>Math.max(.002,mean*2)).length/(length/sampleRate)/6)});
}
export function soundSimilarity(a,b){a=validateSoundProfile(a);b=validateSoundProfile(b);if(!a||!b)return null;return compareSoundProfiles(a,b);}
function compareSoundProfiles(a,b){const timbre=a.bands.reduce((s,x,i)=>s+x*b.bands[i],0),tempo=a.tempo&&b.tempo?Math.exp(-Math.min(...[1,2,.5].map(m=>Math.abs(a.tempo*m-b.tempo)/b.tempo))*5):.5;return Math.max(0,Math.min(1,timbre*.6+tempo*.2+(1-Math.abs(a.dynamicRange-b.dynamicRange))*.1+(1-Math.abs(a.onsetRate-b.onsetRate))*.1));}
export function createSoundMatcher(positive=[],negative=[]){
  const positives=positive.slice(0,12).map(x=>({profile:validateSoundProfile(x.profile),weight:Math.min(1,Math.max(0,x.weight/3))})).filter(x=>x.profile),negatives=negative.slice(-24).map(validateSoundProfile).filter(Boolean),cache=new WeakMap();
  return source=>{if(!source||typeof source!=='object')return {fit:null,avoidance:0};if(cache.has(source))return cache.get(source);const p=validateSoundProfile(source);const result=p?{fit:positives.length?Math.max(...positives.map(x=>compareSoundProfiles(p,x.profile)*x.weight)):null,avoidance:negatives.length?Math.max(...negatives.map(x=>compareSoundProfiles(p,x))):0}:{fit:null,avoidance:0};cache.set(source,result);return result;};
}
