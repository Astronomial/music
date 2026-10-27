import policy from './taste-policy.json' with {type:'json'};
import {genreFold,hardGenreVeto} from './genre-evidence.mjs';
export const TASTE_POLICY=policy;
const excluded=policy.excludedArtists.map(genreFold);
export function recommendationVeto(track){
  if(hardGenreVeto(track))return true;
  const artist=' '+genreFold(track.artist)+' ';
  return excluded.some(name=>artist.includes(' '+name+' '));
}
