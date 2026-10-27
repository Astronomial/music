import {analyzePCM} from './core/sound-profile.mjs';
import {analyzeSemantic} from './semantic-inference.mjs';
let busy=false;
self.onmessage=async({data})=>{
 if(busy){self.postMessage({profile:null,error:'ANALYSIS_BUSY'});return;}
 busy=true;
 try{
  const profile=analyzePCM(data.pcm);let semanticError='';
  if(profile){try{profile.semantic=await analyzeSemantic(data.pcm);}catch(error){semanticError=String(error?.message||'SEMANTIC_FAILED');}}
  self.postMessage({profile,...(semanticError?{semanticError}:{})});
 }catch{self.postMessage({profile:null});}finally{busy=false;}
};
