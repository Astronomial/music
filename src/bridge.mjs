import { requestPublicYandexPlaylist } from './core/yandex.mjs';
let importController;
export const bridge = window.forma || {
  desktop: false,
  yandexPlaylist: url => {importController?.abort();importController=new AbortController();return requestPublicYandexPlaylist(url,fetch,{signal:importController.signal});},
  cancelImport: () => importController?.abort(),
  load: async () => { try { return JSON.parse(localStorage.getItem('forma-library')); } catch { return null; } },
  save: async state => localStorage.setItem('forma-library', JSON.stringify(state)),
  catalogRequest:async()=>{throw new Error('Поиск YouTube доступен в Windows-приложении.');},
  openYouTube:id=>{if(/^[\w-]{11}$/.test(id))window.open('https://www.youtube.com/watch?v='+id,'_blank','noopener');},
  importLocal:async()=>{throw new Error('Локальные файлы доступны в Windows-приложении.');},
  sources:async()=>{throw new Error('Воспроизведение доступно в Windows-приложении.');},
  downloads: async () => ({}),
  download: async () => { throw new Error('Скачивание на диск доступно в Windows-приложении Forma.'); },
  onProgress: () => () => {},
  onBeforeClose: () => () => {},
  openFolder: async () => {},
  exportProfile: async () => {
    const state = JSON.parse(localStorage.getItem('forma-library') || '{}');
    if (state.settings) delete state.settings.apiKey;
    const url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='Forma-library.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return true;
  },
  windowControl: () => {}
};
