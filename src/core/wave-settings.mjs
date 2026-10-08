export const WAVE_GENRES=['Electronic','House','Techno','Hip-Hop/Rap','Alternative','Pop','Ambient','Jazz','Rock','R&B/Soul','Lo-Fi','Drum & Bass'];
export const MOODS=[
  {id:'any',name:'Любое',query:'',values:[]},
  {id:'calm',name:'Спокойное',query:'calm relaxing',values:['peaceful','calm','relaxing']},
  {id:'bright',name:'Светлое',query:'happy uplifting',values:['happy','upbeat','uplifting','cheerful']},
  {id:'melancholic',name:'Меланхоличное',query:'melancholic sad',values:['sad','melancholy','melancholic','brooding']},
  {id:'energetic',name:'Заряженное',query:'energetic upbeat',values:['energetic','excited','upbeat','motivating']},
  {id:'focus',name:'Для концентрации',query:'focus study',values:['focused','sophisticated','calm','peaceful']}
];
export const DEFAULT_WAVE_SETTINGS={genres:[],excludedGenres:[],genreMode:'prefer',discovery:0.3,mood:'any',energy:'any',vocals:'any',artistDiversity:0.6,repeatCooldown:2,includeLibrary:true,preferredArtists:[],blockedArtists:[],playlistSource:'all',seedPlaylistIds:[]};
const clamp=(n,min,max,fallback)=>Number.isFinite(Number(n))?Math.max(min,Math.min(max,Number(n))):fallback;
export const fold=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const strings=(a,max=40)=>Array.isArray(a)?[...new Map(a.filter(v=>typeof v==='string').map(v=>v.trim().slice(0,100)).filter(Boolean).map(v=>[fold(v),v])).values()].slice(0,max):[];
export function waveSettings(settings={}){
  const excludedGenres=strings(settings.excludedGenres).filter(g=>WAVE_GENRES.includes(g));
  const genres=strings(settings.genres).filter(g=>WAVE_GENRES.includes(g)&&!excludedGenres.includes(g));
  return {...DEFAULT_WAVE_SETTINGS,
    genres,excludedGenres,
    genreMode:settings.genreMode==='strict'&&genres.length?'strict':'prefer',discovery:clamp(settings.discovery,0,1,0.3),
    mood:MOODS.some(m=>m.id===settings.mood)?settings.mood:'any',energy:['low','medium','high'].includes(settings.energy)?settings.energy:'any',vocals:['instrumental','vocal'].includes(settings.vocals)?settings.vocals:'any',
    artistDiversity:clamp(settings.artistDiversity,0,1,0.6),repeatCooldown:clamp(settings.repeatCooldown,0,24,2),includeLibrary:settings.includeLibrary!==false,
    preferredArtists:strings(settings.preferredArtists),blockedArtists:strings(settings.blockedArtists),playlistSource:settings.playlistSource==='selected'?'selected':'all',seedPlaylistIds:strings(settings.seedPlaylistIds,200)
  };
}
const genreAliases={Electronic:['electronic','electronica','электроника'],House:['house','хаус'],Techno:['techno','техно'],'Hip-Hop/Rap':['hip hop','rap','хип хоп','рэп'],Alternative:['alternative','indie','альтернатива'],Pop:['pop','поп'],Ambient:['ambient','эмбиент'],Jazz:['jazz','джаз'],Rock:['rock','рок'],'R&B/Soul':['r b','rnb','soul','соул'],'Lo-Fi':['lo fi','lofi'],'Drum & Bass':['drum bass','drum and bass','dnb','драм н бэйс']};
const contains=(text,term)=>` ${fold(text)} `.includes(` ${fold(term)} `);
export function genresOf(track){
  if(!track.genre)return {values:track.discoveryGenres||[],confidence:0.35};
  const text=' '+fold(track.genre)+' ';
  const values=Object.entries(genreAliases).filter(([,aliases])=>aliases.some(a=>text.includes(' '+a+' '))).map(([g])=>g);
  return {values:values.length?values:[track.genre],confidence:1};
}
export function matchesArtist(track,name){return contains(track.artist,name);}
export function blockedByPreferences(track,settings){
  if(settings.blockedArtists.some(name=>matchesArtist(track,name)))return true;
  const {values,confidence}=genresOf(track);
  if(values.length&&(confidence===1?values.some(g=>settings.excludedGenres.includes(g)):values.every(g=>settings.excludedGenres.includes(g))))return true;
  if(settings.genreMode==='strict'&&settings.genres.length&&!values.some(g=>settings.genres.includes(g)))return true;
  return false;
}
export function activeSeedPlaylists(state,settings=waveSettings(state.settings)){
  return settings.playlistSource==='selected'?state.playlists.filter(p=>settings.seedPlaylistIds.includes(p.id)):state.playlists;
}
export function preferenceAffinity(track,settings){
  let score=0,reason='';
  const genres=genresOf(track);
  const selectedGenre=genres.values.find(g=>settings.genres.includes(g));
  if(selectedGenre){score+=0.65*genres.confidence;reason=genres.confidence===1?`Выбранный жанр · ${selectedGenre}`:`Поиск в направлении · ${selectedGenre}`;}
  if(settings.preferredArtists.some(name=>matchesArtist(track,name))){score+=1.3;reason='Исполнитель из твоих ориентиров';}
  const mood=MOODS.find(m=>m.id===settings.mood);
  if(mood.id!=='any'){
    if(mood.values.some(v=>contains(track.mood,v)||track.tags?.some(t=>contains(t,v)))){score+=0.65;reason=`Твоё настроение · ${mood.name.toLowerCase()}`;}
    else if(track.discoveryMoods?.includes(mood.id))score+=0.25;
  }
  if(settings.energy!=='any'){
    const energy=track.bpm?track.bpm<90?'low':track.bpm<=125?'medium':'high':null;
    if(energy===settings.energy)score+=0.5;
    else if(energy)score-=0.2;
    else if(track.discoveryEnergy?.includes(settings.energy))score+=0.18;
  }
  if(settings.vocals!=='any'){
    const text=[track.title,...(track.tags||[])].join(' ');
    const instrumental=['instrumental','без вокала','no vocals','karaoke'].some(v=>contains(text,v));
    const vocal=['vocals','vocal','singing'].some(v=>contains(text,v));
    if(instrumental)score+=settings.vocals==='instrumental'?0.55:-0.3;
    else if(vocal)score+=settings.vocals==='vocal'?0.55:-0.3;
    else if(track.discoveryVocals?.includes(settings.vocals))score+=0.2;
  }
  return {score,reason};
}
export function waveQuery(genre,settings){
  const mood=MOODS.find(m=>m.id===settings.mood)?.query||'';
  const energy={low:'slow mellow',medium:'mid tempo',high:'fast energetic'}[settings.energy]||'';
  const vocals={instrumental:'instrumental',vocal:'vocals'}[settings.vocals]||'';
  return [genre,mood,energy,vocals,'music'].filter(Boolean).join(' ');
}
export function retrievalContext(settings,genre){return {discoveryGenres:genre?[genre]:[],discoveryMoods:settings.mood==='any'?[]:[settings.mood],discoveryEnergy:settings.energy==='any'?[]:[settings.energy],discoveryVocals:settings.vocals==='any'?[]:[settings.vocals]};}
