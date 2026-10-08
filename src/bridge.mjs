import { requestAudius, API_HOSTS, apiURL } from './core/audius.mjs';
export const bridge = window.forma || {
  desktop: false,
  load: async () => { try { return JSON.parse(localStorage.getItem('forma-library')); } catch { return null; } },
  save: async state => localStorage.setItem('forma-library', JSON.stringify(state)),
  request: (path,params) => { let state; try { state=JSON.parse(localStorage.getItem('forma-library')); } catch {} return requestAudius(path,params,fetch,state?.settings?.apiKey); },
  sources: async id => API_HOSTS.map(host=>apiURL(host,`/tracks/${id}/stream`)),
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
