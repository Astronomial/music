import policy from './taste-policy.json' with {type:'json'};
import {genreFold,hardGenreVeto,HARD_EXCLUDED_GENRES} from './genre-evidence.mjs';
import {semanticGenres} from './semantic-audio.mjs';
export const TASTE_POLICY=policy;
const excluded=policy.excludedArtists.map(genreFold);
export function recommendationVeto(track){
  if(hardGenreVeto(track))return true;
  if(semanticGenres(track.soundProfile?.semantic).some(g=>HARD_EXCLUDED_GENRES.has(g)))return true;
  const artist=' '+genreFold(track.artist)+' ';
  return excluded.some(name=>artist.includes(' '+name+' '));
}
