export const PALETTES = [
  {id:'iris',name:'Ирис',description:'Фиолетовый и ледяной голубой',accent:'#c4b5fd',rgb:'196,181,253',secondary:'111,180,255'},
  {id:'ocean',name:'Океан',description:'Голубой и бирюзовый',accent:'#8bdafc',rgb:'139,218,252',secondary:'90,240,215'},
  {id:'mint',name:'Мята',description:'Мятный и мягкий лайм',accent:'#a2e7cd',rgb:'162,231,205',secondary:'198,235,151'},
  {id:'ember',name:'Янтарь',description:'Тёплый янтарный и персиковый',accent:'#ffd0a0',rgb:'255,208,160',secondary:'242,151,124'},
  {id:'rose',name:'Роза',description:'Розовый и сиреневый',accent:'#f5b5d3',rgb:'245,181,211',secondary:'184,153,249'},
  {id:'mono',name:'Графит',description:'Серебро на почти чёрном',accent:'#e2e8f0',rgb:'226,232,240',secondary:'148,163,184'}
];
export function appearanceVariables(settings) {
  const palette=PALETTES.find(p=>p.id===settings.palette)||PALETTES[0];
  const scale=[1,1.12,1.24].includes(Number(settings.textScale))?Number(settings.textScale):1;
  return {'--accent':palette.accent,'--accent-rgb':palette.rgb,'--secondary-rgb':palette.secondary,'--text-scale':scale};
}
