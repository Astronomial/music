import { normalizeTrack } from './model.mjs';
import { retrievalSeeds } from './recommender.mjs';
export const API_HOSTS = ['https://api.audius.co', 'https://discoveryprovider.audius.co', 'https://audius-discovery-1.cultur3stake.com'];
const allowedPath = /^\/(tracks\/(trending(?:\/underground)?|search|[a-zA-Z0-9]+(?:\/(?:stream|download))?)|users\/[a-zA-Z0-9]+\/tracks|playlists\/(trending|[a-zA-Z0-9]+\/tracks))$/;
export function apiURL(host, path, params = {}) {
  if (!API_HOSTS.includes(host) || !allowedPath.test(path)) throw new Error('Недопустимый запрос Audius');
  const url = new URL('/v1' + path, host);
  url.searchParams.set('app_name', 'FormaMusic');
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  return url.href;
}
export async function requestAudius(path, params = {}, fetcher = fetch, apiKey = '') {
  let lastError;
  for (const host of API_HOSTS) {
    try {
      const response = await fetcher(apiURL(host, path, params), { signal: AbortSignal.timeout(12000), headers: apiKey ? { 'x-api-key': apiKey } : {} });
      if (!response.ok) throw new Error(response.status === 429 ? 'Audius временно ограничил запросы. Попробуй позже.' : `Audius: ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body.data) && !body.data) throw new Error('Audius вернул пустой ответ');
      return body.data;
    } catch (error) { lastError = error; }
  }
  throw new Error(lastError?.message || 'Не удалось подключиться к Audius');
}
export async function collectCandidates(state, request) {
  const seeds = retrievalSeeds(state);
  const jobs = [
    ['/tracks/trending', { time: 'week', limit: 100 }],
    ['/tracks/trending/underground', { limit: 100 }],
    ...seeds.genres.map(genre => ['/tracks/search', { genre, sort_method: 'popular', limit: 70 }]),
    ...seeds.genres.slice(0,2).map(genre => ['/tracks/search', { genre, sort_method: 'recent', limit: 40 }]),
    ...seeds.artists.slice(0,3).map(id => [`/users/${id}/tracks`, { limit: 40 }]),
    ...seeds.tags.slice(0,2).map(query => ['/tracks/search', { query, limit: 35 }])
  ];
  const tracks = new Map(); let successes = 0;
  // Small batches keep discovery from overwhelming public nodes.
  for (let i = 0; i < jobs.length; i += 3) {
    const batch = await Promise.allSettled(jobs.slice(i,i+3).map(([path, params]) => request(path,params)));
    for (const r of batch) if (r.status === 'fulfilled') { successes++; for (const t of r.value) { const n = normalizeTrack(t); if (n.streamable) tracks.set(n.id,n); } }
  }
  if (!successes) throw new Error('Audius недоступен. Сохранённая библиотека остаётся доступной.');
  return [...tracks.values()];
}
