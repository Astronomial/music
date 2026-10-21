// Optional metadata only; audio resolution and playback never await this service.
class GenreCatalog {
  constructor(fetcher=fetch){this.fetch=fetcher;this.lastRequest=0;this.cache=new Map();this.inflight=new Map();this.releaseCache=new Map();this.lastReleaseRequest=0;}
  async releases(artist){
    if(typeof artist!=='string'||!artist.trim()||artist.length>200)return [];
    const key=artist.trim().toLowerCase(),hit=this.releaseCache.get(key);if(hit&&Date.now()-hit.at<3600000)return hit.rows;
    if(Date.now()-this.lastReleaseRequest<30000)return [];this.lastReleaseRequest=Date.now();
    const {recentReleaseRows}=await import('../src/core/release-discovery.mjs'),{artistIdentity}=await import('../src/core/genre-evidence.mjs');
    const rows=[];let received=false;
    for(const country of ['us','ru']){
      try{
        const url=new URL('https://itunes.apple.com/search');url.search=new URLSearchParams({term:artist,entity:'musicArtist',limit:'5',country}).toString();
        const response=await this.fetch(url.href,{signal:AbortSignal.timeout(3000)});if(!response.ok)continue;
        const data=await response.json(),id=data.results?.find(r=>artistIdentity(r.artistName)===artistIdentity(artist)&&Number.isSafeInteger(r.artistId)&&r.artistId>0)?.artistId;if(!id)continue;
        const lookup=new URL('https://itunes.apple.com/lookup');lookup.search=new URLSearchParams({id:String(id),entity:'song',sort:'recent',limit:'200',country}).toString();
        const result=await this.fetch(lookup.href,{signal:AbortSignal.timeout(3000)});if(!result.ok)continue;const body=await result.json();if(Array.isArray(body.results)){received=true;rows.push(...body.results.slice(0,201));}
        if(recentReleaseRows(rows,artist).length)break;
      }catch{}
    }
    const found=recentReleaseRows(rows,artist);if(!received)return [];
    this.releaseCache.set(key,{at:Date.now(),rows:found});if(this.releaseCache.size>100)this.releaseCache.delete(this.releaseCache.keys().next().value);return found;
  }
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
