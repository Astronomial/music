import {genreFold} from './genre-evidence.mjs';
// Functional search uploads are not evidence of a listener's song taste. A user
// can still search/play/save them explicitly, which opts that library into them.
const cache=new WeakMap();
export function utilityRecording(track){
  const old=cache.get(track);if(old&&old.title===track.title&&old.artist===track.artist)return old.result;
  const result=classifyUtility(track);cache.set(track,{title:track.title,artist:track.artist,result});return result;
}
function classifyUtility(track){
  const title=genreFold(track.title),artist=genreFold(track.artist);
  const functional=/^(?:(?:royalty free|copyright free|no copyright|stock|instrumental) )?(?:energetic|energy|upbeat|happy|sad|calm|relaxing|relaxation|motivational|inspiring|inspirational|workout|background|study|sleep|meditation|focus|chill)(?: background)? music(?:$| for | vol | mix | playlist | [0-9])/;
  return functional.test(title)||/^(?:music for |музыка для |спокойная музыка(?:$| )|энергичная музыка(?:$| )|фоновая музыка(?:$| ))/.test(title)||/^(?:energetic music|background music|relaxing music|royalty free music|music for |музыка для )/.test(artist);
}
