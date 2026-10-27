// Frozen Discogs-EffNet backbone. Quantized vectors are model-versioned and
// syncable; they contain no audio and are not treated as verified genre labels.
import labels from './effnet-styles.json' with {type:'json'};
export const SEMANTIC_MODEL_ID='discogs-effnet-bsdynamic-1:a280825b334797cf';
export const SEMANTIC_DIMENSIONS=1280;
const cache=new WeakMap();
export function validateSemanticProfile(value){
  if(!value||typeof value!=='object')return null;
  if(cache.has(value))return cache.get(value)?.profile||null;
  if(value.version!==1||value.model!==SEMANTIC_MODEL_ID||typeof value.vector!=='string'||value.vector.length!==1708||!Number.isFinite(value.seconds)||value.seconds<8||value.seconds>30||!Array.isArray(value.styles)||value.styles.length>16)return null;
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(value.vector))return null;
  let bytes;try{bytes=Uint8Array.from(atob(value.vector),c=>c.charCodeAt(0));}catch{return null;}
  if(bytes.length!==SEMANTIC_DIMENSIONS)return null;
  const vector=new Int8Array(bytes.buffer);let norm=0;for(const x of vector)norm+=x*x;
  if(norm===0)return null;
  const seen=new Set();
  for(const s of value.styles){if(!s||!Number.isInteger(s.index)||s.index<0||s.index>=400||seen.has(s.index)||!Number.isFinite(s.score)||s.score<0||s.score>1)return null;seen.add(s.index);}
  const profile={version:1,model:SEMANTIC_MODEL_ID,seconds:value.seconds,vector:value.vector,styles:value.styles.map(s=>({index:s.index,score:s.score}))};
  const entry={profile,vector,norm:Math.sqrt(norm)};cache.set(value,entry);cache.set(profile,entry);return profile;
}
export function packSemantic(embedding,scores,seconds){
  if(embedding?.length!==1280||scores?.length!==400||!Array.from(embedding).every(Number.isFinite)||!Array.from(scores).every(x=>Number.isFinite(x)&&x>=0&&x<=1))return null;
  const max=Math.max(...Array.from(embedding,Math.abs));if(max<1e-10)return null;
  const vector=Int8Array.from(embedding,x=>Math.max(-127,Math.min(127,Math.round(x/max*127))));
  const bytes=new Uint8Array(vector.buffer),text=Array.from(bytes,x=>String.fromCharCode(x)).join('');
  const styles=Array.from(scores,(score,index)=>({index,score})).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,16);
  return validateSemanticProfile({version:1,model:SEMANTIC_MODEL_ID,seconds,vector:btoa(text),styles});
}
export function semanticSimilarity(first,second){
  const a=validateSemanticProfile(first),b=validateSemanticProfile(second);if(!a||!b||a.model!==b.model)return null;
  const x=cache.get(a),y=cache.get(b);let dot=0;
  for(let i=0;i<1280;i++)dot+=x.vector[i]*y.vector[i];
  return Math.max(0,Math.min(1,dot/(x.norm*y.norm)));
}
export function semanticGenres(value){
 const profile=validateSemanticProfile(value);if(!profile)return [];
 const ordered=profile.styles.slice().sort((a,b)=>b.score-a.score);
 const top=ordered[0];if(!top||top.score<.65)return [];
 const category=index=>{
  const label=labels[index],family=label.split('---')[0],style=label.split('---')[1]||'';
  if(family==="Children's")return "Children's Music";
  if(label==='Pop---Chanson')return 'Chanson';
  if(family==='Hip Hop')return 'Hip-Hop/Rap';
  if(family==='Electronic')return /Drum n Bass|Jungle/.test(style)?'Drum & Bass':/House/.test(style)?'House':/Techno/.test(style)?'Techno':/Ambient/.test(style)?'Ambient':'Electronic';
  if(family==='Rock')return /Metal|Thrash|Grindcore/.test(style)?'Metal':/Alternative|Indie/.test(style)?'Alternative':'Rock';
  return {Pop:'Pop',Jazz:'Jazz',Reggae:'Reggae',Classical:'Classical','Funk / Soul':'R&B/Soul','Folk, World, & Country':'Folk/Country'}[family]||'';
 };
 const genre=category(top.index);if(!genre)return [];
 // Independent sigmoid heads are not calibrated probabilities. A broad or
 // conflicting prediction must remain unknown rather than become a hard label.
 if(ordered.some(s=>s.score>top.score-.15&&category(s.index)&&category(s.index)!==genre))return [];
 return [genre];
}
