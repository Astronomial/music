import {MOODS,genresOf,fold} from './wave-settings.mjs';
export const MOOD_MIXES=[
  {id:'calm',title:'Тише внутри',subtitle:'Спокойствие в твоём звучании',label:'CALM',className:'mix-sage',context:{id:'calm',mood:'calm',energy:'low',genres:['Ambient','Lo-Fi','Jazz','R&B/Soul']}},
  {id:'bright',title:'Светлая сторона',subtitle:'Музыка, с которой легче',label:'BRIGHT',className:'mix-sand',context:{id:'bright',mood:'bright',genres:['Pop','House','Electronic']}},
  {id:'melancholic',title:'Чуть ближе к себе',subtitle:'Когда хочется почувствовать',label:'FEEL',className:'mix-lilac',context:{id:'melancholic',mood:'melancholic',genres:['Alternative','R&B/Soul','Lo-Fi']}},
  {id:'energetic',title:'На полной',subtitle:'Твой заряд на новый день',label:'ENERGY',className:'mix-blue',context:{id:'energetic',mood:'energetic',energy:'high',genres:['Rock','Hip-Hop/Rap','Drum & Bass','Techno']}},
  {id:'focus',title:'Без лишних мыслей',subtitle:'Меньше шума. Больше внимания.',label:'FOCUS',className:'mix-focus',context:{id:'focus',mood:'focus',energy:'low',vocals:'instrumental',genres:['Ambient','Lo-Fi','Jazz']}},
  {id:'night',title:'После полуночи',subtitle:'Мягкий свет и глубокий ритм',label:'NIGHT',className:'mix-night',context:{id:'night',mood:'night',genres:['House','Electronic','Techno','R&B/Soul']}}
];
export function moodEvidence(track,context){
  if(!context?.mood)return 0;
  const mood=MOODS.find(m=>m.id===context.mood),values=mood?.values||['brooding','sophisticated','dark','night'];
  const text=' '+fold([track.mood,...(track.tags||[])].join(' '))+' ';
  if(values.some(v=>text.includes(' '+fold(v)+' ')))return 1;
  if(track.mood)return 0; // Known conflicting mood beats a weak query label.
  if(track.discoveryMoods?.includes(context.mood))return .45;
  const genres=genresOf(track),style=genres.values.some(g=>context.genres?.includes(g));
  if(style)return .25*genres.confidence;
  return 0;
}
