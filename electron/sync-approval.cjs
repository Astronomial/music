const validID=id=>typeof id==='string'&&/^[0-9a-f-]{36}$/i.test(id);
class SyncApprovals {
  constructor({store,coordinator,onChange}){Object.assign(this,{store,coordinator,onChange});this.proposals=[];this.receipts=[];this.queue=Promise.resolve();}
  serialized(fn){this.queue=this.queue.then(fn,fn);return this.queue;}
  async persist(){if(JSON.stringify(this.proposals).length>32*1024**2)throw new Error('Слишком много данных ожидают подтверждения');await this.store.write('sync-proposals.json',this.proposals);}
  async restore(deviceIDs){
    const {sanitizePortable,applyPortable,portableLibrary}=await import('../src/core/sync.mjs');const {stableJSON}=await import('../src/core/sync-preview.mjs');
    const receipts=await this.store.read('sync-receipts.json',[]),saved=await this.store.read('sync-proposals.json',[]);
    this.proposals=[];this.receipts=(Array.isArray(receipts)?receipts:[]).filter(r=>r&&validID(r.id)&&deviceIDs.includes(r.deviceID)&&r.expiresAt>Date.now()).slice(-100);
    for(const p of Array.isArray(saved)?saved:[]){
      if(!p||!validID(p.id)||!deviceIDs.includes(p.deviceID)||!['pending','committing','approved','rejected','stale'].includes(p.status)||!Number.isFinite(p.expiresAt)||p.expiresAt<Date.now())continue;
      try{p.sent=sanitizePortable(p.sent);p.snapshot=sanitizePortable(p.snapshot);p.merged=sanitizePortable(p.merged);this.proposals.push(p);}catch{/* Invalid drafts cannot touch a library. */}
    }
    for(const p of this.proposals.filter(p=>p.status==='committing')){
      await this.coordinator.mutate(current=>{const actual=stableJSON(portableLibrary(current));if(actual===stableJSON(p.snapshot))return applyPortable(current,p.merged);if(actual===stableJSON(p.merged))return current;p.status='stale';return current;},{afterWrite:async()=>{if(p.status==='committing')p.status='approved';await this.persist();}});
    }
    await this.persist();
  }
  prune(){for(const p of this.proposals)if(p.status==='pending'&&p.expiresAt<Date.now())p.status='stale';this.proposals=this.proposals.filter(p=>p.expiresAt>Date.now()||p.status==='stale'&&p.expiresAt>Date.now()-86400000);}
  public(p){return {protocolVersion:2,id:p.id,status:p.status,deviceName:p.deviceName,createdAt:p.createdAt,expiresAt:p.expiresAt,summary:p.summary,...(p.status==='approved'?{library:p.merged}:{})};}
  pending(){this.prune();return this.proposals.filter(p=>p.status==='pending').map(p=>{const {library,...safe}=this.public(p);return safe;});}
  missing(){return Object.assign(new Error('Пакет больше не хранится на ПК. Подготовь обмен заново'),{code:'proposal_missing'});}
  find(id,deviceID){const p=this.proposals.find(p=>p.id===id&&(!deviceID||p.deviceID===deviceID));if(!p)throw this.missing();return p;}
  async prepare(device,body){return this.serialized(async()=>{
    this.prune();if(!validID(body.id))throw new Error('Некорректный идентификатор пакета');
    const duplicate=this.proposals.find(p=>p.id===body.id);if(duplicate){if(duplicate.deviceID!==device.id)throw new Error('Пакет принадлежит другому телефону');return this.public(duplicate);}
    if(this.proposals.some(p=>p.deviceID===device.id&&['pending','approved','committing'].includes(p.status)))throw new Error('Сначала заверши или отклони предыдущий пакет');
    const {sanitizePortable,portableLibrary,mergePortable}=await import('../src/core/sync.mjs');const {summarizeChanges}=await import('../src/core/sync-preview.mjs');
    const current=await this.store.read('library.json',null);if(!current)throw new Error('Открой библиотеку на ПК');
    const sent=sanitizePortable(body.library),base=body.base?sanitizePortable(body.base):null,snapshot=portableLibrary(current),merged=mergePortable(snapshot,base,sent);
    const p={id:body.id,deviceID:device.id,deviceName:device.name,status:'pending',createdAt:Date.now(),expiresAt:Date.now()+15*60000,sent,snapshot,merged,summary:{toPC:summarizeChanges(snapshot,merged),toPhone:summarizeChanges(sent,merged)}};
    this.proposals.push(p);try{await this.persist();}catch(e){this.proposals=this.proposals.filter(x=>x!==p);throw e;}return this.public(p);
  });}
  async review(deviceID,id){return this.serialized(async()=>{this.prune();return this.public(this.find(id,deviceID));});}
  async approve(id,deviceID){return this.serialized(async()=>{
    this.prune();const p=this.find(id,deviceID);if(p.status==='approved')return this.public(p);if(!['pending','committing'].includes(p.status))throw new Error('Пакет уже отклонён или устарел. Подготовь новый');
    const {portableLibrary,applyPortable}=await import('../src/core/sync.mjs');const {stableJSON}=await import('../src/core/sync-preview.mjs');
    const updated=await this.coordinator.mutate(async current=>{
      if(p.status==='committing'&&stableJSON(portableLibrary(current))===stableJSON(p.merged))return current;
      if(stableJSON(portableLibrary(current))!==stableJSON(p.snapshot)){p.status='stale';p.expiresAt=Date.now()+86400000;await this.persist();throw new Error('Библиотека ПК изменилась после подготовки. Обнови просмотр на iPhone и подтверди новый пакет');}
      p.status='committing';p.expiresAt=Date.now()+86400000;await this.persist();return applyPortable(current,p.merged);
    },{afterWrite:async()=>{p.status='approved';await this.persist();}});
    this.onChange?.(updated);return this.public(p);
  });}
  async reject(id,deviceID){return this.serialized(async()=>{const p=this.find(id,deviceID);if(['approved','committing'].includes(p.status))throw new Error('Обмен уже подтверждён');p.status='rejected';p.expiresAt=Date.now()+86400000;await this.persist();return this.public(p);});}
  async acknowledge(id,deviceID){return this.serialized(async()=>{
    const p=this.proposals.find(p=>p.id===id&&p.deviceID===deviceID);
    if(!p){if(this.receipts.some(r=>r.id===id&&r.deviceID===deviceID&&r.expiresAt>Date.now()))return {protocolVersion:2};throw this.missing();}
    if(p.status==='pending'||p.status==='committing')throw new Error('Пакет ещё ожидает решения');
    this.receipts=this.receipts.filter(r=>r.id!==id&&r.expiresAt>Date.now()).slice(-99);this.receipts.push({id,deviceID,expiresAt:Date.now()+86400000});
    await this.store.write('sync-receipts.json',this.receipts);
    this.proposals=this.proposals.filter(x=>x!==p);await this.persist();return {protocolVersion:2};
  });}
  async forget(){return this.serialized(async()=>{this.proposals=[];this.receipts=[];await this.store.write('sync-receipts.json',[]);await this.persist();});}
}
module.exports={SyncApprovals};
