const DAY = 86400000;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export function features(t) {
  const f = {};
  if (t.genre) f[`genre:${t.genre}`] = 1.8;
  if (t.mood) f[`mood:${t.mood}`] = 0.9;
  if (t.artistId) f[`artist:${t.artistId}`] = 1.2;
  for (const tag of (t.tags || []).slice(0, 12)) f[`tag:${tag}`] = 0.55;
  return f;
}
export function cosine(a, b) {
  let dot = 0, aa = 0, bb = 0;
  for (const [k, v] of Object.entries(a)) { dot += v * (b[k] || 0); aa += v * v; }
  for (const v of Object.values(b)) bb += v * v;
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
export function eventWeight(e) {
  if (e.type === 'hide') return -7;
  if (e.type === 'listen') return (e.ratio || 0) >= 0.8 ? 1.5 : (e.ratio || 0) >= 0.5 ? 0.5 : 0;
  // Actual listened time, rather than the seek position, defines an early skip.
  if (e.type === 'skip') return e.seconds < 30 && (e.ratio || 0) < 0.25 ? -2.5 : (e.ratio || 0) < 0.65 ? -0.8 : 0;
  return 0;
}
export function buildProfile(state, now = Date.now()) {
  const weights = new Map();
  for (const id of state.likes) weights.set(id, 5);
  for (const p of state.playlists) for (const id of new Set(p.trackIds)) weights.set(id, Math.min(9, (weights.get(id) || 0) + 3));
  // Saturation stops one repeatedly played/skipped track from dominating taste.
  const implicit = new Map();
  for (const e of state.events) {
    const value = eventWeight(e) * Math.pow(0.5, Math.max(0, now - e.at) / (30 * DAY));
    implicit.set(e.trackId, clamp((implicit.get(e.trackId) || 0) + value, -7, 4));
  }
  for (const [id, weight] of implicit) weights.set(id, (weights.get(id) || 0) + weight);
  const positive = {}, negative = {};
  let negativeEvidence = 0;
  for (const [id, weight] of weights) {
    const track = state.tracks[id]; if (!track) continue;
    if(weight<0)negativeEvidence+=Math.min(2.5,Math.abs(weight));
    const target = weight >= 0 ? positive : negative;
    for (const [key, value] of Object.entries(features(track))) target[key] = (target[key] || 0) + Math.abs(weight) * value;
  }
  for (const g of state.settings.genres || []) positive[`genre:${g}`] = (positive[`genre:${g}`] || 0) + 3;
  return { positive, negative, weights, negativeEvidence };
}
export function trackSimilarity(a,b) {
  const metadata=cosine(features(a),features(b));
  if(!a.bpm||!b.bpm)return metadata;
  // Half/double tempo equivalence handles tracks tagged at different beat levels.
  const distance=Math.min(Math.abs(a.bpm-b.bpm),Math.abs(a.bpm*2-b.bpm),Math.abs(a.bpm-b.bpm*2));
  const tempo=Math.exp(-(distance*distance)/(2*18*18));
  return metadata*0.85+tempo*0.15;
}
export function rankTracks(candidates, state, options = {}) {
  const { now = Date.now(), limit = 30, exclude = [], context = null, seed = Math.floor(now / 3600000), allowRecent = false } = options;
  const profile = buildProfile(state, now);
  const anchors=[...profile.weights].filter(([,w])=>w>0).sort((a,b)=>b[1]-a[1]).slice(0,45).map(([id,w])=>({track:state.tracks[id],weight:w})).filter(a=>a.track);
  const banned = new Set([...state.hidden, ...exclude]);
  const recent = new Set(state.events.filter(e => e.type === 'play' && now - e.at < 2 * 3600000).map(e => e.trackId));
  const last = [...state.events].reverse().find(e => e.type === 'listen' || e.type === 'play');
  const lastTrack = last && state.tracks[last.trackId];
  const lastVector = lastTrack ? features(lastTrack) : {};
  const discovery = state.settings.discovery ?? 0.3;
  const unique = new Map(candidates.map(t => [t.id, t]));
  const ranked = [...unique.values()].filter(t => t.streamable && !banned.has(t.id) && (allowRecent || !recent.has(t.id))).map(track => {
    const vector = features(track);
    const globalAffinity = cosine(vector, profile.positive);
    const closestAnchor = anchors.length?Math.max(...anchors.map(a=>trackSimilarity(track,a.track)*Math.min(1,a.weight/3))):globalAffinity;
    // Preserve several distinct musical interests instead of averaging them away.
    const affinity = globalAffinity*0.65+closestAnchor*0.35;
    // One early skip is useful feedback, but should not erase a whole genre.
    const avoidance = cosine(vector, profile.negative)*Math.min(1,profile.negativeEvidence/8);
    const known = (profile.weights.get(track.id) || 0) > 0;
    const popular = Math.min(1, Math.log1p(track.favoriteCount || 0) / 12);
    const noise = stableNoise(track.id, seed);
    let contextScore = context?.genres?.includes(track.genre) ? 0.6 : 0;
    if (context?.moods?.includes(track.mood)) contextScore += 0.55;
    const session = Math.max(0, cosine(vector, lastVector)) * 0.15;
    // Novel candidates still need a taste match: exploration is not random genre drift.
    const novelty = !known ? discovery * (0.2 + affinity * 0.45) : (1 - discovery) * 0.12;
    let score = 2.2 * affinity - 1.65 * avoidance + novelty + session + popular * 0.12 + noise * 0.06 + contextScore;
    const ownWeight = profile.weights.get(track.id) || 0;
    if (ownWeight < 0) score -= Math.min(1.8, Math.abs(ownWeight) * 0.3);
    let reason = 'Новое из каталога Audius';
    if (contextScore) reason = `Под настроение · ${track.mood || track.genre}`;
    else if (state.likes.includes(track.id)) reason = 'Из твоих любимых';
    else if (profile.positive[`artist:${track.artistId}`]) reason = 'Ты слушаешь этого исполнителя';
    else if (profile.positive[`genre:${track.genre}`]) reason = `В твоём вкусе · ${track.genre}`;
    else if (affinity > 0.1) reason = 'Похоже на музыку в твоей библиотеке';
    return { track, score, reason, vector, known };
  });
  // Greedy MMR balances relevance with artist and content diversity.
  const result = [], artistCounts = new Map();
  while (ranked.length && result.length < limit) {
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < ranked.length; i++) {
      const item = ranked[i];
      const artistKey = item.track.artistId || item.track.artist;
      const count = artistCounts.get(artistKey) || 0;
      const similarity = result.length ? Math.max(...result.slice(-4).map(r => cosine(item.vector, r.vector))) : 0;
      const previousArtist = result.at(-1)?.track.artistId;
      const adjusted = item.score - similarity * (0.2 + discovery * 0.25) - count * 0.32 - (previousArtist && previousArtist === item.track.artistId ? 0.65 : 0);
      if (adjusted > bestScore) { bestScore = adjusted; best = i; }
    }
    const [item] = ranked.splice(best, 1);
    result.push(item);
    const key = item.track.artistId || item.track.artist;
    artistCounts.set(key, (artistCounts.get(key) || 0) + 1);
  }
  return result.map(({ vector, ...item }) => item);
}
function stableNoise(id, seed) {
  let hash = seed | 0;
  for (const c of id) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967295;
}
export function retrievalSeeds(state) {
  const p = buildProfile(state);
  const top = prefix => Object.entries(p.positive).filter(([k]) => k.startsWith(prefix)).sort((a,b) => b[1]-a[1]).slice(0, 4).map(([k]) => k.slice(prefix.length));
  return { genres: top('genre:'), artists: top('artist:'), tags: top('tag:') };
}
