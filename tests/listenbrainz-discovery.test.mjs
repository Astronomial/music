import test from 'node:test';
import assert from 'node:assert/strict';
import {SimilarArtistCache, similarArtists, collaborativeMatch} from '../src/core/listenbrainz.mjs';
import {initialState,normalizeTrack} from '../src/core/model.mjs';
import {rankTracks} from '../src/core/recommender.mjs';
import {YouTubeCatalog} from '../src/core/youtube.mjs';

const seedID='3c1b6453-a4a0-4801-9e33-af590e33b875',otherID='b2e4a44e-e105-4325-a085-75d608753f0e';
const data={ [seedID]:[],[otherID]:[{recording_mbid:'401c1a5d-56e7-434d-b07e-a14d4e7eb83c',similar_artist_mbid:otherID,similar_artist_name:'Новый артист',total_listen_count:8}] };
const response=x=>new Response(JSON.stringify(x));
test('a collaborative pool contributes artist identities, never inferred genres or popularity scores',()=>{
 assert.deepEqual(similarArtists(data,seedID),[{mbid:otherID,name:'Новый артист'}]);
 assert.deepEqual(similarArtists({error:'unavailable'},seedID),[]);
});
test('cold collaborative lookup returns immediately, deduplicates work and caches successful identities',async()=>{
 let release,calls=0;const barrier=new Promise(r=>release=r);
 const cache=new SimilarArtistCache(async url=>{calls++;if(url.includes('musicbrainz.org')){await barrier;return response({artists:[{id:seedID,name:'Три дня дождя'}]});}return response(data);});
 assert.deepEqual(cache.peek('Три дня дождя'),[]);assert.deepEqual(cache.peek('Три дня дождя'),[]);assert.equal(calls,1);
 const pending=cache.prefetch('Три дня дождя');release();await pending;
 assert.equal(calls,2);assert.equal(cache.peek('Три дня дождя')[0].name,'Новый артист');assert.equal(calls,2);
});
test('failed or ambiguous collaborative sources cannot stall playback or hot-loop retry',async()=>{
 let now=0,calls=0;const cache=new SimilarArtistCache(async()=>{calls++;throw new Error('offline');},{now:()=>now});
 await cache.prefetch('MARKUL');cache.peek('MARKUL');assert.equal(calls,1);
 now=600001;await cache.prefetch('MARKUL');assert.equal(calls,2);
 const ambiguous=new SimilarArtistCache(async()=>response({artists:[{id:seedID,name:'MARKUL'},{id:otherID,name:'MARKUL'}]}));
 await ambiguous.prefetch('MARKUL');assert.deepEqual(ambiguous.peek('MARKUL'),[]);
});
test('external responses are bounded and one global request prevents a library-wide request storm',async()=>{
 let release,calls=0;const cache=new SimilarArtistCache(async()=>{calls++;await new Promise(r=>release=r);return response({artists:[]});});
 cache.peek('MARKUL');cache.peek('бэя');assert.equal(calls,1);release();await cache.prefetch('MARKUL');
 const large=new SimilarArtistCache(async()=>new Response(' '.repeat(2*1024*1024+1)));
 await large.prefetch('MARKUL');assert.deepEqual(large.peek('MARKUL'),[]);
});
const song=(n,extra={})=>normalizeTrack({id:'yt_'+String(n).padStart(11,'0'),videoId:String(n).padStart(11,'0'),source:'youtube',title:'Песня '+n,artist:'Artist '+n,genre:'Alternative',duration:200,...extra});
test('co-listening requires compatible recording evidence; a search label cannot manufacture a genre',()=>{
 const seed=song(1),good=song(2),unknown=song(3,{genre:'',discoveryGenres:['Alternative']}),wrong=song(4,{genre:'Jazz'});
 assert.equal(collaborativeMatch(good,seed),true);assert.equal(collaborativeMatch(unknown,seed),false);assert.equal(collaborativeMatch(wrong,seed),false);
});
test('a verified collaborative edge opens nearby discoveries without converting it to a direct track link',()=>{
 const seed=song(1),candidate=song(2,{relatedTo:[seed.id],retrievalSources:['listenbrainz-neighbour']});
 const s=initialState();s.tracks={[seed.id]:seed};s.likes=[seed.id];
 const result=rankTracks([candidate],s,{now:1800000000000});assert.equal(result.length,1);assert.equal(result[0].lane,'nearby');
 const wrong={...candidate,id:'wrong',genre:'Jazz'},unknown={...candidate,id:'unknown',genre:'',discoveryGenres:['Alternative']};
 assert.deepEqual(rankTracks([wrong,unknown],s,{now:1800000000000}),[]);
});
test('collaborative discoveries respect hard veto, dislike and late evidence in the normal ranker',()=>{
 const seed=song(1),bad=song(2,{genre:'Pop / Russian Chanson',relatedTo:[seed.id],retrievalSources:['listenbrainz-neighbour']});
 const s=initialState();s.tracks={[seed.id]:seed,[bad.id]:bad};s.likes=[seed.id,bad.id];assert.deepEqual(rankTracks([bad],s),[]);
 const good=song(3,{relatedTo:[seed.id],retrievalSources:['listenbrainz-neighbour']});s.dislikes=[good.id];assert.deepEqual(rankTracks([good],s),[]);
});
test('neighbour lookup searches only exact returned artists and never attaches a fake direct recording relationship',async()=>{
 const service=new YouTubeCatalog(async()=>{throw new Error('not required');},{neighbourLookup:()=>[{mbid:otherID,name:'Новый артист'}]});
 service.search=async()=>({items:[song(1,{artist:'Новый артист - Topic'}),song(2,{artist:'Not the artist'})]});
 const result=await service.request('/tracks/neighbours',{query:'Три дня дождя'});
 assert.equal(result.items.length,1);assert.deepEqual(result.items[0].directRelatedTo,[]);assert.deepEqual(result.items[0].retrievalSources,['listenbrainz-neighbour']);
});
