import {sanitizePortable} from './sync.mjs';
const MAX_RECORDS=30000;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export const emptyCloudDocument=actor=>({schema:2,actor,clock:0,counter:0,records:{}});
export function cloudFields(library){
  const l=sanitizePortable(library),fields={};
  for(const [id,t] of Object.entries(l.tracks))fields['track:'+id]=t;
  for(const id of new Set([...l.likedIDs,...l.dislikedIDs]))fields['preference:'+id]=l.dislikedIDs.includes(id)?'disliked':'liked';
  for(const id of l.hiddenIDs)fields['hidden:'+id]=true;
  l.playlists.forEach((p,index)=>{fields['playlist:'+p.id]={id:p.id,name:p.name,order:index};p.trackIDs.forEach((id,index)=>{fields['member:'+p.id+':'+id]=index;});});
  for(const [k,v] of Object.entries(l.settings))fields['setting:'+k]=v;
  for(const e of l.events)fields[`event:${e.trackID}:${e.kind}:${Math.round(e.at)}:${Math.round(e.seconds*1000)}:${Math.round(e.ratio*1000)}`]=e;
  return fields;
}
const compare=(a,b)=>a.time-b.time||a.counter-b.counter||(a.actor<b.actor?-1:a.actor>b.actor?1:0);
export function validateCloudDocument(doc,now=Date.now()){
  if(!doc||doc.schema!==2||typeof doc.actor!=='string'||!/^[A-Za-z0-9-]{8,80}$/.test(doc.actor)||!doc.records||Array.isArray(doc.records)||Object.keys(doc.records).length>MAX_RECORDS)throw new Error('Некорректные данные облачной библиотеки');
  const records={};let clock=0,counter=0;
  for(const [key,entry] of Object.entries(doc.records)){
    if(key.length>400||!(/^(track|preference|hidden|playlist|member|setting|event):/.test(key))||!entry||!entry.stamp)throw new Error('Некорректная запись синхронизации');
    const s=entry.stamp;if(!Number.isSafeInteger(s.time)||s.time<0||s.time>now+86400000||!Number.isSafeInteger(s.counter)||s.counter<0||s.counter>1e7||typeof s.actor!=='string'||!/^[A-Za-z0-9-]{8,80}$/.test(s.actor))throw new Error('Некорректные часы синхронизации');
    if(JSON.stringify(entry.value).length>50000)throw new Error('Слишком большая запись синхронизации');
    Object.defineProperty(records,key,{value:structuredClone(entry),enumerable:true,writable:true,configurable:true});
    if(s.time>clock){clock=s.time;counter=s.counter;}else if(s.time===clock)counter=Math.max(counter,s.counter);
  }
  return {schema:2,actor:doc.actor,clock,counter,records};
}
export function captureCloudChanges(doc,current,base=null,now=Date.now()){
  const next=validateCloudDocument(doc,now),before=base?cloudFields(base):{},after=cloudFields(current);
  for(const key of new Set([...Object.keys(before),...Object.keys(after)])){
    const old=before[key]??null,value=after[key]??null;if(equal(old,value))continue;
    // On first connection existing account data wins collisions; local unique
    // tracks/preferences/playlists are still imported. Later edits use HLC.
    const time=base?Math.max(now,next.clock):1;
    next.counter=time===next.clock?next.counter+1:0;next.clock=time;
    next.records[key]={stamp:{time,counter:next.counter,actor:next.actor},value};
  }
  return validateCloudDocument(next,now);
}
export function mergeCloudDocuments(local,remote,now=Date.now()){
  const a=validateCloudDocument(local,now),b=validateCloudDocument(remote,now);
  for(const [key,value] of Object.entries(b.records)){const old=a.records[key];if(!old||compare(old.stamp,value.stamp)<0)a.records[key]=value;else if(compare(old.stamp,value.stamp)===0&&!equal(old.value,value.value))throw new Error('Конфликт идентичности устройства');}
  return validateCloudDocument(a,now);
}
export function materializeCloud(doc){
  const fields=validateCloudDocument(doc).records,tracks={},likedIDs=[],dislikedIDs=[],hiddenIDs=[],playlists=[],events=[],settings={};
  for(const [key,{value}] of Object.entries(fields)){
    if(value===null)continue;const kind=key.slice(0,key.indexOf(':')),id=key.slice(key.indexOf(':')+1);
    if(kind==='track')Object.defineProperty(tracks,id,{value,enumerable:true});
    else if(kind==='preference'){if(value==='liked')likedIDs.push(id);if(value==='disliked')dislikedIDs.push(id);}
    else if(kind==='hidden'&&value===true)hiddenIDs.push(id);
    else if(kind==='playlist'&&value&&value.id===id){const prefix='member:'+id+':';const members=Object.entries(fields).filter(([k,v])=>k.startsWith(prefix)&&Number.isInteger(v.value)&&v.value>=0).sort((a,b)=>a[1].value-b[1].value||a[0].localeCompare(b[0]));playlists.push({...value,trackIDs:members.map(([k])=>k.slice(prefix.length))});}
    else if(kind==='setting')Object.defineProperty(settings,id,{value,enumerable:true});
    else if(kind==='event')events.push(value);
  }
  playlists.sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));events.sort((a,b)=>a.at-b.at);
  return sanitizePortable({version:1,tracks,likedIDs,dislikedIDs,hiddenIDs,playlists,events:events.slice(-3000),settings});
}
