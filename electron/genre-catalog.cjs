// Optional metadata only; audio resolution and playback never await this service.
class GenreCatalog {
  constructor(fetcher=fetch){this.fetch=fetcher;this.lastRequest=0;this.cache=new Map();this.inflight=new Map();}
  async lookup(track){
    const {artistIdentity,recordingIdentity,matchRecordingGenre}=await import('../src/core/genre-evidence.mjs');
    if(!track||typeof track.title!=='string'||typeof track.artist!=='string'||track.title.length>200||track.artist.length>200)return null;
    const key=JSON.stringify([artistIdentity(track.artist),recordingIdentity(track.title),Math.round(Number(track.duration)||0)]);
    if(!artistIdentity(track.artist)||!recordingIdentity(track.title))return null;
    const cached=this.cache.get(key);if(cached&&Date.now()-cached.checkedAt<86400000)return cached;
    if(this.inflight.has(key))return this.inflight.get(key);
    const work=(async()=>{
      let received=false,rows=[];
      for(const country of ['us','ru']){
        const wait=Math.max(0,3000-(Date.now()-this.lastRequest));if(wait)await new Promise(resolve=>setTimeout(resolve,wait));this.lastRequest=Date.now();
        const url=new URL('https://itunes.apple.com/search');url.search=new URLSearchParams({term:track.artist+' '+track.title,entity:'song',limit:'25',country}).toString();
        try{const response=await this.fetch(url.href,{signal:AbortSignal.timeout(4000)});if(!response.ok)continue;const body=await response.json();if(!Array.isArray(body.results))continue;received=true;rows.push(...body.results.slice(0,25));if(matchRecordingGenre(track,rows).values.length)break;}catch{/* No network: remain unknown; bounded retry in the caller. */}
      }
      if(!received)return null;
      const evidence=matchRecordingGenre(track,rows);this.cache.set(key,evidence);while(this.cache.size>1000)this.cache.delete(this.cache.keys().next().value);return evidence;
    })();this.inflight.set(key,work);try{return await work;}finally{this.inflight.delete(key);}
  }
}
module.exports={GenreCatalog};
