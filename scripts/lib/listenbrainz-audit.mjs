// Read-only coverage audit. This module is deliberately outside the app bundle.
// MusicBrainz identities and public LB Radio pools are not personal relevance labels.
import {resolveArtist, summariseRadio} from '../../src/core/listenbrainz.mjs';
export {resolveArtist, summariseRadio};

export async function auditSeed(name,request){
 const search=new URL('https://musicbrainz.org/ws/2/artist/');
 // Quote as a Lucene literal so spaces, punctuation and operators are not queries.
 search.search=new URLSearchParams({query:'artist:"'+name.replace(/[\\"]/g,'\\$&')+'"',fmt:'json',limit:'100'});
 const lookup=await request(search.href),result={artist:name,lookup};
 if(lookup.status!=='ok')return {...result,status:'lookup_unavailable'};
 const match=resolveArtist(lookup.data,name);result.match=match;
 if(match.status==='invalid_response')return {...result,status:'lookup_unavailable'};
 if(match.status!=='resolved')return {...result,status:match.status};
 const radio=new URL('https://api.listenbrainz.org/1/lb-radio/artist/'+match.mbid);
 radio.search=new URLSearchParams({mode:'easy',max_similar_artists:'8',max_recordings_per_artist:'25',pop_begin:'0',pop_end:'100'});
 result.mbid=match.mbid;result.radio=await request(radio.href);
 if(result.radio.status!=='ok')return {...result,status:'radio_unavailable'};
 const summary=summariseRadio(result.radio.data,match.mbid);
 if(summary.status==='invalid_response')return {...result,status:'radio_unavailable',schemaError:true};
 return {...result,status:summary.status,radioSummary:summary};
}

export function auditCoverage(results){
 return {
  kind:'public-catalogue-coverage-not-personal-quality',
  requestedArtists:results.length,
  resolvedArtists:results.filter(r=>r.mbid).length,
  availableRadioArtists:results.filter(r=>r.status==='ok').length,
  emptyRadioArtists:results.filter(r=>r.status==='empty').length,
  artistsNotFound:results.filter(r=>r.status==='not_found').length,
  ambiguousArtists:results.filter(r=>r.status==='ambiguous').length,
  unavailableArtists:results.filter(r=>['lookup_unavailable','radio_unavailable'].includes(r.status)).length,
  personalTasteAccuracy:null,
  decision:'do_not_replace_yet',
  reason:'Coverage alone does not demonstrate better personal recommendations. A matched baseline, independent relevance feedback, genre evidence and playable recording resolution are required.',
  results
 };
}
