// One calculation at a time; playback outranks shelf refreshes. Pending shelf
// requests coalesce so rapid feedback cannot build an ever-growing work queue.
export class RecommendationClient {
  constructor(worker){
    this.worker=worker;this.sequence=0;this.active=null;this.queue=[];this.closed=false;
    worker.onmessage=({data})=>{
      if(!this.active||data.id!==this.active.id)return;
      const item=this.active;this.active=null;
      if(data.error)item.reject(new Error(data.error));else item.resolve(data.result);
      this.pump();
    };
    worker.onerror=()=>this.close(new Error('Не удалось выполнить расчёт Пульса. Перезапусти приложение.'));
  }
  request(job){
    if(this.closed)return Promise.reject(new Error('Расчёт Пульса остановлен.'));
    return new Promise((resolve,reject)=>{
      // Superseded requests resolve null, which callers must ignore.
      const kind=job.kind,lane=job.lane||kind;
      this.queue=this.queue.filter(item=>{if((item.job.lane||item.job.kind)===lane){item.resolve(null);return false;}return true;});
      this.queue.push({id:++this.sequence,job,resolve,reject});this.pump();
    });
  }
  pump(){
    if(this.active||this.closed||!this.queue.length)return;
    let priority=this.queue.findIndex(item=>item.job.lane==='playback');
    if(priority<0)priority=this.queue.findIndex(item=>item.job.kind==='rank');
    this.active=this.queue.splice(priority<0?0:priority,1)[0];
    try{this.worker.postMessage({id:this.active.id,job:this.active.job});}
    catch(error){const item=this.active;this.active=null;item.reject(error);this.pump();}
  }
  close(error=new Error('Расчёт Пульса отменён.')){
    this.closed=true;this.worker.terminate();this.active?.reject(error);
    for(const item of this.queue)item.reject(error);this.active=null;this.queue=[];
  }
}
export function createRecommendationClient(){return new RecommendationClient(new Worker(new URL('./recommendation-worker.mjs',import.meta.url),{type:'module'}));}
