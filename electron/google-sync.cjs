const {randomUUID}=require('node:crypto');
class GoogleSync {
  constructor({auth,store,coordinator,onChange}){Object.assign(this,{auth,store,coordinator,onChange});this.busy=false;this.error='';this.lastSync=null;this.nextTry=0;this.timer=null;this.epoch=0;this.cloud=null;this.sub=null;this.poll=setInterval(()=>this.run().catch(()=>{}),60000);this.poll.unref();}
  status(){return {...this.auth.status(),busy:this.busy,error:this.error,lastSync:this.lastSync};}
  schedule(){if(!this.auth.status().connected||this.timer)return;this.timer=setTimeout(()=>{this.timer=null;this.run().catch(()=>{});},2000);this.timer.unref();}
  async reset(){this.epoch++;this.sub=null;this.cloud=null;this.error='';this.lastSync=null;this.nextTry=0;clearTimeout(this.timer);this.timer=null;}
  async run(manual=false){if(this.busy||!this.auth.status().connected||!manual&&Date.now()<this.nextTry)return this.status();this.busy=true;const epoch=this.epoch,sub=this.auth.credentials.sub;
    try{const {portableLibrary,applyPortable,mergePortable}=await import('../src/core/sync.mjs');const {emptyCloudDocument,captureCloudChanges,mergeCloudDocuments,materializeCloud,publishCloudDocument}=await import('../src/core/cloud-sync.mjs');const {GoogleDriveLibrary}=await import('../src/core/google-drive.mjs');
      if(this.sub!==sub){this.cloud=await this.store.read('google-cloud-'+sub+'.json',null)||{document:emptyCloudDocument(randomUUID()),base:null};this.sub=sub;}
      const sentState=await this.store.read('library.json',null);if(!sentState)return this.status();const sent=portableLibrary(sentState);
      this.cloud={document:captureCloudChanges(this.cloud.document,sent,this.cloud.base),base:sent};await this.store.write('google-cloud-'+sub+'.json',this.cloud);
      const drive=new GoogleDriveLibrary((u,o)=>{if(epoch!==this.epoch||this.auth.credentials?.sub!==sub)throw new Error('Аккаунт изменён');return this.auth.authorizedFetch(u,o);}),files=await drive.files();let document=this.cloud.document;
      for(const file of files){if(epoch!==this.epoch)throw new Error('Аккаунт изменён');document=mergeCloudDocuments(document,await drive.download(file.id));}
      if(epoch!==this.epoch)throw new Error('Аккаунт изменён');document=publishCloudDocument(document);const remote=materializeCloud(document);
      const updated=await this.coordinator.mutate(current=>applyPortable(current,mergePortable(remote,sent,portableLibrary(current))));
      if(epoch!==this.epoch)return this.status();this.cloud={document,base:remote};await this.store.write('google-cloud-'+sub+'.json',this.cloud);this.onChange(updated,sentState);
      await drive.upload(document,files);if(epoch!==this.epoch)return this.status();this.lastSync=Date.now();this.error='';this.nextTry=0;
    }catch(e){if(epoch===this.epoch){this.error=e.message;this.nextTry=Date.now()+120000;}}finally{this.busy=false;}
    return this.status();
  }
}
module.exports={GoogleSync};
