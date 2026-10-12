import {genresOf,blockedByPreferences,waveQuery} from './wave-settings.mjs';

const ruGenres={Electronic:'электронная',House:'хаус',Techno:'техно','Hip-Hop/Rap':'рэп хип-хоп',Alternative:'альтернатива',Pop:'поп',Ambient:'эмбиент',Jazz:'джаз',Rock:'рок','R&B/Soul':'соул ритм-н-блюз','Lo-Fi':'лоу-фай','Drum & Bass':'драм-н-бейс'};
const ruMoods={calm:'спокойная',bright:'радостная',melancholic:'грустная',energetic:'энергичная',focus:'для концентрации',night:'ночная'};
export function tasteGenres(anchors,settings){
  const learned=[...new Set(anchors.filter(t=>!blockedByPreferences(t,settings)).flatMap(t=>genresOf(t).values))];
  const genres=settings.genreMode==='strict'?settings.genres:[...new Set([...settings.genres,...learned])];
  return (genres.length?genres:['Pop','Alternative','Electronic']).filter(g=>!settings.excludedGenres.includes(g)).slice(0,12);
}
export function discoveryQuery(genre,settings,artist=''){
  if(settings.languagePreference!=='ru')return [artist,waveQuery(genre,settings),settings.mood==='night'?'late night':'',settings.languagePreference==='en'?'english songs':''].filter(Boolean).join(' ');
  return [artist,ruGenres[genre]||genre,ruMoods[settings.mood],{low:'медленная',medium:'средний темп',high:'быстрая'}[settings.energy],{instrumental:'без вокала',vocal:'с вокалом'}[settings.vocals],'русская музыка'].filter(Boolean).join(' ');
}
