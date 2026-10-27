// Independently implemented from Essentia's documented EffNet input contract:
// PCM16k -> Hann512/power FFT/hop256 -> 96 area-normalized Slaney mel bands
// -> log10(1+10000*x). No metadata participates in these features.
const N=512,BANDS=96,RATE=16000;
const hzToMel=f=>f<1000?f*3/200:15+27*Math.log(f/1000)/Math.log(6.4);
const melToHz=m=>m<15?m*200/3:1000*6.4**((m-15)/27);
const window=Float64Array.from({length:N},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/(N-1)));
const centers=Float64Array.from({length:BANDS+2},(_,i)=>melToHz(hzToMel(8000)*i/(BANDS+1)));
const filters=Array.from({length:BANDS},(_,b)=>{
 const [lo,mid,hi]=[centers[b],centers[b+1],centers[b+2]],out=[];
 for(let k=0;k<=256;k++){const f=k*RATE/N;if(f>lo&&f<hi){const v=(f<=mid?(f-lo)/(mid-lo):(hi-f)/(hi-mid))*2/(hi-lo);if(v>0)out.push([k,v]);}}
 return out;
});
function spectrum(pcm,start){
 const re=Float64Array.from({length:N},(_,i)=>{const v=pcm[start+i];return (Number.isFinite(v)?Math.max(-1,Math.min(1,v)):0)*window[i];}),im=new Float64Array(N);
 for(let i=1,j=0;i<N;i++){let bit=N>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j)[re[i],re[j]]=[re[j],re[i]];}
 for(let size=2;size<=N;size*=2)for(let base=0;base<N;base+=size)for(let i=0;i<size/2;i++){
  const a=-2*Math.PI*i/size,c=Math.cos(a),s=Math.sin(a),p=base+i,q=p+size/2,x=re[q]*c-im[q]*s,y=re[q]*s+im[q]*c;
  re[q]=re[p]-x;im[q]=im[p]-y;re[p]+=x;im[p]+=y;
 }
 return re.subarray(0,257).map((x,i)=>x*x+im[i]*im[i]);
}
export function effnetPatches(pcm,sampleRate=16000){
 if(sampleRate!==RATE||!pcm||pcm.length<8*RATE)return null;
 const length=Math.min(pcm.length,30*RATE),frames=Math.floor((length-N)/256)+1;
 const starts=[0,Math.floor((frames-128)/2),frames-128],data=new Float32Array(3*128*96);
 for(let patch=0;patch<3;patch++)for(let frame=0;frame<128;frame++){
  const power=spectrum(pcm,(starts[patch]+frame)*256);
  for(let band=0;band<BANDS;band++){let value=0;for(const [bin,weight] of filters[band])value+=power[bin]*weight;data[(patch*128+frame)*BANDS+band]=Math.log10(1+10000*value);}
 }
 return {data,count:3};
}
