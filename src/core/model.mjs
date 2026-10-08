export const GENRES = ['Electronic', 'House', 'Techno', 'Hip-Hop/Rap', 'Alternative', 'Pop', 'Ambient', 'Jazz', 'Rock', 'R&B/Soul', 'Lo-Fi', 'Drum & Bass'];
export const initialState = () => ({ version: 1, tracks: {}, likes: [], playlists: [], events: [], hidden: [], settings: { genres: [], discovery: 0.3, offlineOnly: false, volume: 0.7 }, onboarded: false });
export function normalizeTrack(t) {
  const artwork = t.artwork || {};
  const download = t.download || {};
  return {
    id: String(t.id), title: t.title || 'Без названия', artist: t.user?.name || t.artist || 'Неизвестный исполнитель',
    artistId: String(t.user?.id || t.artistId || ''), genre: t.genre || '', mood: t.mood || '',
    tags: (Array.isArray(t.tags) ? t.tags : String(t.tags || '').split(',')).map(x => x.trim().toLowerCase()).filter(Boolean).slice(0, 30),
    duration: Number(t.duration) || 0, bpm: Number(t.bpm) || 0, musicalKey: t.musical_key || '',
    artwork: typeof artwork === 'string' ? artwork : artwork['480x480'] || artwork._480x480 || artwork['150x150'] || '',
    playCount: Number(t.play_count ?? t.playCount) || 0, favoriteCount: Number(t.favorite_count ?? t.favoriteCount) || 0,
    releaseDate: t.release_date || t.releaseDate || '',
    streamable: t.is_streamable !== false && t.is_streamable !== 'false' && t.is_stream_gated !== true && !t.stream_conditions && !t.is_delete && !t.is_unlisted,
    downloadable: Boolean(t.is_downloadable ?? t.downloadable ?? download.is_downloadable) && !download.requires_follow && !download.requiresFollow && !t.is_download_gated && !t.download_conditions,
    permalink: t.permalink || ''
  };
}
export function mergeTracks(state, tracks) {
  const next = { ...state.tracks };
  for (const t of tracks) if (t?.id) next[t.id] = t;
  // Preserve library/history metadata while bounding the discovery cache.
  const keep = new Set([...state.likes, ...state.hidden, ...state.playlists.flatMap(p => p.trackIds), ...state.events.map(e => e.trackId)]);
  const ids = Object.keys(next);
  if (ids.length > 6000) for (const id of ids) { if (Object.keys(next).length <= 6000) break; if (!keep.has(id)) delete next[id]; }
  return { ...state, tracks: next };
}
export function recordEvent(state, trackId, type, extra = {}, now = Date.now()) {
  return { ...state, events: [...state.events, { trackId, type, at: now, ...extra }].slice(-3000) };
}
