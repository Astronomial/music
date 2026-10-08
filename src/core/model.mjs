import {WAVE_GENRES,DEFAULT_WAVE_SETTINGS} from './wave-settings.mjs';
export const GENRES = WAVE_GENRES;
export const initialState = () => ({ version: 1, tracks: {}, likes: [], playlists: [], events: [], hidden: [], imports: [], settings: { ...structuredClone(DEFAULT_WAVE_SETTINGS), offlineOnly: false, volume: 0.7, palette: 'iris', textScale: 1, provider:'youtube' }, onboarded: false });
export function normalizeTrack(t) {
  const artwork = t.artwork || {};
  const download = t.download || {};
  return {
    source:t.source||'audius',videoId:t.videoId||'',relatedTo:t.relatedTo||[],retrievalSources:t.retrievalSources||[],discoveryGenres:t.discoveryGenres||[],discoveryMoods:t.discoveryMoods||[],discoveryEnergy:t.discoveryEnergy||[],discoveryVocals:t.discoveryVocals||[],album:t.album||'',
    id: String(t.id), title: t.title || 'Без названия', artist: t.user?.name || t.artist || 'Неизвестный исполнитель',
    artistId: String(t.user?.id || t.artistId || ''), genre: t.genre || '', mood: t.mood || '',
    tags: (Array.isArray(t.tags) ? t.tags : String(t.tags || '').split(',')).map(x => x.trim().toLowerCase()).filter(Boolean).slice(0, 30),
    duration: Number(t.duration) || 0, bpm: Number(t.bpm) || 0, musicalKey: t.musical_key || '',
    artwork: typeof artwork === 'string' ? artwork : artwork['480x480'] || artwork._480x480 || artwork['150x150'] || '',
    playCount: Number(t.play_count ?? t.playCount) || 0, favoriteCount: Number(t.favorite_count ?? t.favoriteCount) || 0,
    releaseDate: t.release_date || t.releaseDate || '',
    streamable: t.streamable !== false && t.is_streamable !== false && t.is_streamable !== 'false' && t.is_stream_gated !== true && !t.stream_conditions && !t.is_delete && !t.is_unlisted,
    downloadable: Boolean(t.is_downloadable ?? t.downloadable ?? download.is_downloadable) && !download.requires_follow && !download.requiresFollow && !t.is_download_gated && !t.download_conditions,
    permalink: t.permalink || ''
  };
}
export function mergeTracks(state, tracks) {
  const next = { ...state.tracks };
  for (const t of tracks) if (t?.id) {
    const merged={...t};
    for(const key of ['relatedTo','discoveryGenres','discoveryMoods','discoveryEnergy','discoveryVocals','retrievalSources'])merged[key]=[...new Set([...(next[t.id]?.[key]||[]),...(t[key]||[])])].slice(-15);
    next[t.id]=merged;
  }
  // Preserve library/history metadata while bounding the discovery cache.
  const keep = new Set([...state.likes, ...state.hidden, ...state.playlists.flatMap(p => p.trackIds), ...state.events.map(e => e.trackId)]);
  const ids = Object.keys(next);
  let count=ids.length;
  if (count > 6000) for (const id of ids) { if (count <= 6000) break; if (!keep.has(id)){delete next[id];count--;} }
  return { ...state, tracks: next };
}
export function recordEvent(state, trackId, type, extra = {}, now = Date.now()) {
  return { ...state, events: [...state.events, { trackId, type, at: now, ...extra }].slice(-3000) };
}
