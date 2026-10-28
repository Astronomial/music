import Foundation

public struct Recommendation: Identifiable, Sendable {
    public var id: String { track.id }
    public var track: Track
    public var score: Double
    public var reason: String
    public var newArtist = false
    public var known = false
    public var nearby = false
    public var languageFit = 0.0
    public var taste = 0.0
    public var exposure: RecommendationContext? = nil
    public var scoredAt: Date = .distantPast
    public var freshness = 0.0
    public var recentRelease = false
    public var releasePreference = 0.6
}
public struct MoodMix: Identifiable, Sendable {
    public let id: String
    public let title: String
    public let query: String
    public let subtitle: String
    public static let all: [MoodMix] = MoodFitness.rules.map { .init(id: $0.id, title: $0.title, query: $0.query, subtitle: $0.subtitle) }
}

/// iOS engine v3: complete explicit-library profile -> independent musical evidence
/// -> feedback scoring -> constrained sequence. Retrieval hints are never labels.
public enum PulseEngine {
    private static let separators = try! NSRegularExpression(pattern: "[^\\p{L}\\p{N}]+")
    public static func fold(_ text: String) -> String {
        let value = text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX")).replacingOccurrences(of: "ё", with: "е")
        return separators.stringByReplacingMatches(in: value, range: NSRange(value.startIndex..., in: value), withTemplate: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }
    public struct RankingIndex: Sendable {
        fileprivate let artists: [String: Set<String>]
        fileprivate let recordings: [String: String]
        fileprivate let genres: [String: [String]]
        fileprivate let moods: [String: [String: Double]]
        fileprivate let utility: [String: Bool]
    }
    public static func makeIndex(_ candidates: [Track], library: Library) -> RankingIndex {
        let tracks = library.tracks.merging(Dictionary(candidates.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }), uniquingKeysWith: { _, b in b })
        return RankingIndex(artists: tracks.mapValues(PulseDiversity.artists), recordings: tracks.mapValues(PulseDiversity.recording), genres: tracks.mapValues(GenreClassifier.genres), moods: tracks.mapValues(MoodFitness.scores), utility: tracks.mapValues(RecordingQuality.utility))
    }
    public static func anchors(in library: Library, limit: Int = 6, now: Date = Date()) -> [Track] { Array(TasteProfile(library: library, now: now).seeds.prefix(max(0, limit))) }
    public static func genreMetadataAnchors(in library: Library, limit: Int = 24, now: Date = Date()) -> [Track] {
        var source = library; source.settings.genreMode = "prefer"; source.settings.excludedGenres = []
        return anchors(in: source, limit: limit, now: now)
    }
    private static func profileSource(_ library: Library, playlistID: String?, trackID: String?) -> Library? {
        if let trackID { guard let seed = library.tracks[trackID] else { return nil }; return TrackPulse.profile(library, seed: seed) }
        guard let playlistID else { return library }
        guard let playlist = library.playlists.first(where: { $0.id == playlistID && !$0.trackIDs.isEmpty }) else { return nil }
        var result = library; result.likedIDs = []; result.playlists = [playlist]; result.settings.playlistSource = "all"; result.settings.genres = []
        let ids = Set(playlist.trackIDs); result.events = library.events.filter { ids.contains($0.trackID) }; return result
    }
    private struct Evidence {
        var fit: Double; var genre: Double; var hasGenre: Bool; var direct: Int; var sameArtist: Bool; var preferredArtist: Bool; var artistNeighbour: Bool; var audio: Double?; var match: Track?; var known: Bool; var eligible: Bool
        var nearby: Bool { known || sameArtist || preferredArtist || artistNeighbour || direct > 0 || (audio ?? 0) >= 0.92 || (genre > 0 && (audio ?? 0) >= 0.85) }
    }
    private static func focusMatch(_ track: Track, context: String?) -> Bool {
        context == "focus" && MoodFitness.scores(track)["focus", default: 0] >= 0.75 && !Set(GenreClassifier.genres(track)).isDisjoint(with: ["Ambient", "Lo-Fi", "Jazz", "Classical"])
    }
    private static func evidence(_ track: Track, profile: TasteProfile, index: RankingIndex, library: Library, familiarIDs: Set<String>, liveMetadata: Bool = false) -> Evidence {
        func compatible(_ seed: Track) -> Bool {
            guard let similarity = SemanticAudioProfile.similarity(track.soundProfile?.semantic, seed.soundProfile?.semantic) else { return true }
            return similarity >= 0.65
        }
        let names = liveMetadata ? PulseDiversity.artists(track) : (index.artists[track.id] ?? PulseDiversity.artists(track)), genres = liveMetadata ? GenreClassifier.genres(track) : (index.genres[track.id] ?? GenreClassifier.genres(track))
        let sameArtist = !names.isDisjoint(with: profile.artists.keys), known = familiarIDs.contains(track.id)
        let directIDs = Set(track.directRelatedTo).intersection(profile.positiveIDs).filter { id in
            guard let seed = library.tracks[id], compatible(seed) else { return false }
            let sourceGenres = liveMetadata ? GenreClassifier.genres(seed) : (index.genres[id] ?? GenreClassifier.genres(seed))
            return genres.isEmpty || sourceGenres.isEmpty || GenreClassifier.relation(genres, sourceGenres) > 0
        }
        let direct = Set(directIDs.compactMap { library.tracks[$0] }.flatMap { index.artists[$0.id] ?? PulseDiversity.artists($0) }).count
        let genreFit = GenreClassifier.relation(genres, Array(profile.genres.keys))
        let genreAffinity = profile.genreStrength.map { name, strength in GenreClassifier.relation(genres, [name]) * strength }.max() ?? 0
        let artistAffinity = names.compactMap { profile.artistStrength[$0] }.max() ?? 0
        let topSeedWeight = profile.maxSeedWeight
        let rootAffinity = directIDs.compactMap { profile.weights[$0] }.max().map { $0 / max(1, topSeedWeight) } ?? 0
        let comparable = !genres.isEmpty && !profile.genres.isEmpty
        let artistNeighbour = track.relatedTo.contains { id in
            guard profile.positiveIDs.contains(id), let seed = library.tracks[id], compatible(seed) else { return false }
            if track.retrievalSources.contains("listenbrainz-neighbour"), CollaborativeDiscovery.matches(track, seed: seed) { return true }
            guard track.retrievalSources.contains("artist-neighbour") else { return false }
            let sourceGenres = liveMetadata ? GenreClassifier.genres(seed) : (index.genres[id] ?? GenreClassifier.genres(seed))
            return genres.isEmpty || sourceGenres.isEmpty || GenreClassifier.relation(genres, sourceGenres) > 0
        }
        let audio = profile.soundSeeds.compactMap { SoundProfile.similarity(track.soundProfile, $0.soundProfile) }.max()
        // A general-purpose mix is not a song discovery, even when YouTube radio
        // returned it and attached the same broad Pop label as a favourite song.
        let utility = liveMetadata ? RecordingQuality.utility(track) : (index.utility[track.id] ?? RecordingQuality.utility(track))
        // Saving a sleep/ambient mix authorizes that recording and its compatible
        // neighbours, not every generic upload linked to an ordinary favourite.
        let utilityMatch = profile.utilityIDs.contains(track.id) || !Set(directIDs).isDisjoint(with: profile.utilityIDs)
        let referenceAllowed = profile.positiveIDs.isEmpty || !track.retrievalSources.contains("mood-reference") || known || sameArtist || artistNeighbour || direct > 0 || (audio ?? 0) >= 0.92
        let allowed = referenceAllowed && (!utility || utilityMatch) && !library.dislikedIDs.contains(track.id)
        let preferred = library.settings.preferredArtists.contains { names.contains(fold($0)) }
        let compatibleDirect = direct > 0 && (!comparable || genreFit > 0)
        let eligible = allowed && (profile.positiveIDs.isEmpty || known || sameArtist || artistNeighbour || compatibleDirect || genreFit > 0 || (!comparable && (audio ?? 0) >= 0.92) || preferred)
        let fit: Double
        if known { fit = 0.65 + 0.35 * min(1, (profile.weights[track.id] ?? 0) / max(1, topSeedWeight)) }
        else if sameArtist { fit = 0.65 + artistAffinity * 0.2 }
        else if preferred { fit = 0.72 }
        else if compatibleDirect { fit = min(0.95, 0.58 + rootAffinity * 0.1 + Double(max(0, direct - 1)) * 0.09) }
        else if artistNeighbour { fit = 0.6 }
        else { fit = max(genreAffinity * 0.42, (audio ?? 0) >= 0.9 ? (audio ?? 0) * 0.7 : 0) }
        let match = directIDs.sorted().compactMap { library.tracks[$0] }.first
        return Evidence(fit: fit, genre: genreFit, hasGenre: !genres.isEmpty, direct: compatibleDirect ? direct : 0, sameArtist: sameArtist, preferredArtist: preferred, artistNeighbour: artistNeighbour, audio: audio, match: match, known: known, eligible: eligible)
    }
    public static func rank(_ candidates: [Track], library: Library, limit: Int = 30, mood: String? = nil, exclude: Set<String> = [], allowRecent: Bool = false, now: Date = Date(), currentID: String? = nil, index: RankingIndex? = nil, playlistID: String? = nil, trackID: String? = nil, retainFamiliarPool: Bool = false) -> [Recommendation] {
        guard limit > 0, let source = profileSource(library, playlistID: playlistID, trackID: trackID) else { return [] }
        let prepared = index ?? makeIndex(candidates, library: library), profile = TasteProfile(library: source, now: now), familiarPool = FamiliarRotation.ids(source)
        let knownRecordings = Set(source.likedIDs + source.playlists.flatMap(\.trackIDs))
        let context = mood ?? (library.settings.mood == "any" ? nil : library.settings.mood)
        let recent = recentIDs(library, now: now), saved = Set(library.likedIDs + library.playlists.flatMap(\.trackIDs))
        let personalAvailable = candidates.contains { track in VideoID.isValid(track.id) && !exclude.contains(track.id) && (allowRecent || !recent.contains(track.id)) && (context.map { (prepared.moods[track.id]?[$0] ?? 0) > 0 } ?? true) && !knownRecordings.contains(track.id) && !library.hiddenIDs.contains(track.id) && !library.dislikedIDs.contains(track.id) && !PulseDiversity.blocked(track, settings: library.settings) && !(prepared.utility[track.id] ?? false) && (!(prepared.artists[track.id] ?? []).isDisjoint(with: profile.artists.keys) || track.directRelatedTo.contains { id in profile.positiveIDs.contains(id) && (prepared.genres[track.id]?.isEmpty != false || prepared.genres[id]?.isEmpty != false || GenreClassifier.relation(prepared.genres[track.id] ?? [], prepared.genres[id] ?? []) > 0) }) }
        let feedback = ConsumptionFeedback.model(library, now: now), learner = ContextualLearning.model(library, now: now)
        let newReleaseTarget = ReleaseDiscovery.target(library, now: now)
        let heardIDs: [String] = library.events.filter { $0.at <= now && now.timeIntervalSince($0.at) < 30 * 86400 }.map(\.trackID)
        let familiarIDs = saved.union(heardIDs)
        var familiar = Set<String>()
        for id in familiarIDs { familiar.formUnion(prepared.artists[id] ?? []) }
        let session = library.events.suffix(24).filter { $0.at <= now && now.timeIntervalSince($0.at) < 5400 && $0.reward != nil }
        var moodTaste: [String: Double] = [:]
        for id in profile.positiveIDs { for (mood, value) in prepared.moods[id] ?? [:] { moodTaste[mood] = max(moodTaste[mood] ?? 0, value) } }
        var seen = Set<String>(), ranked: [Recommendation] = []
        for track in candidates {
            if Task.isCancelled { return [] }
            guard VideoID.isValid(track.id), seen.insert(track.id).inserted, !exclude.contains(track.id), !library.hiddenIDs.contains(track.id), !PulseDiversity.blocked(track, settings: library.settings), library.settings.includeLibrary || !saved.contains(track.id), allowRecent || !recent.contains(track.id) else { continue }
            if let seed = trackID.flatMap({ library.tracks[$0] }), TrackPulse.sameSong(track, seed) || TrackPulse.fit(track, seed: seed) <= 0.1 { continue }
            let moodFit = context.flatMap { prepared.moods[track.id]?[$0] } ?? 0
            if context != nil, moodFit <= 0 { continue }
            let e = evidence(track, profile: profile, index: prepared, library: source, familiarIDs: knownRecordings)
            let focus = focusMatch(track, context: context) && !(prepared.utility[track.id] ?? false) && !library.dislikedIDs.contains(track.id)
            guard e.eligible || focus else { continue }
            let names = prepared.artists[track.id] ?? [], genres = prepared.genres[track.id] ?? []
            let language = DiscoveryPolicy.languageFit(track, preference: library.settings.languagePreference), newArtist = names.isDisjoint(with: familiar) && !names.contains { $0.hasPrefix("unknown:") }
            let artistNegative = names.compactMap { profile.negativeArtists[$0] }.max() ?? 0
            let genreNegative = genres.compactMap { profile.negativeGenres[$0] }.max() ?? 0
            var sessionFit = 0.0
            for event in session {
                guard let other = library.tracks[event.trackID], let reward = event.reward else { continue }
                let artist = !names.isDisjoint(with: prepared.artists[other.id] ?? [])
                let genre = GenreClassifier.relation(genres, prepared.genres[other.id] ?? [])
                let weight = pow(0.5, now.timeIntervalSince(event.at) / 1800)
                sessionFit += (reward >= 0.7 ? 0.12 : -0.24) * max(artist ? 1 : 0, genre * 0.5) * weight
            }
            sessionFit = max(-0.8, min(0.6, sessionFit)) * library.settings.sessionInfluence / 0.65
            let moodAffinity = context != nil ? moodFit : (prepared.moods[track.id] ?? [:]).map { min($0.value, moodTaste[$0.key] ?? 0) }.max() ?? 0
            let snapshot = ContextualLearning.features(taste: e.fit, nearby: e.direct > 0 ? 0.8 : e.sameArtist ? 0.7 : e.genre * 0.3, session: sessionFit, newArtist: newArtist, known: e.known, language: language, context: moodFit, metadata: !genres.isEmpty, genre: e.genre, artist: e.sameArtist ? 1 : 0, mood: moodAffinity, sound: e.audio ?? 0)
            let consumption = ConsumptionFeedback.predict(track, model: feedback, mood: context)
            let learned = ContextualLearning.predict(learner, features: snapshot)
            let preferred = library.settings.preferredArtists.contains { names.contains(fold($0)) } ? 1.0 : 0
            let fresh = ReleaseDiscovery.freshness(track, now: now), personal = e.sameArtist || e.preferredArtist || e.artistNeighbour || e.direct > 0 || (e.audio ?? 0) >= 0.92
            var score: Double = e.fit * 3 + e.genre * 0.45 + (e.sameArtist ? 0.3 : 0)
            score += Double(min(3, e.direct)) * 0.65
            score += (e.audio ?? 0) * 0.3 + preferred + sessionFit
            score += moodFit * 0.6 + moodAffinity * 0.2 + PulseDirections.score(track, settings: library.settings)
            score += GenreClassifier.relation(genres, library.settings.genres.flatMap(GenreClassifier.canonical)) * 0.7
            score += (consumption.mean - 0.5) * 0.6 + learned.correction * 0.45 + language * 0.12
            if !e.known && personal { score += fresh.score * (newReleaseTarget - 0.4) * 3 }
            if !e.known && !personal && personalAvailable && !focus { score -= 0.8 }
            score -= min(2, artistNegative * 0.16) + min(0.5, genreNegative * 0.035)
            score -= min(3, max(0, -(profile.weights[track.id] ?? 0)) * 0.5)
            if let seed = trackID.flatMap({ library.tracks[$0] }) { score += 3 * TrackPulse.fit(track, seed: seed) }
            let nearby = e.nearby || focus || (context != nil && e.genre > 0 && moodFit >= 0.75)
            let lane = e.known ? "familiar" : nearby ? "nearby" : "stretch"
            var reason = e.known ? "Из твоей библиотеки" : e.sameArtist ? "Исполнитель из твоей библиотеки" : e.match.map { "Похоже на «\($0.title)» · \($0.artist)" } ?? (!genres.isEmpty ? "Близкий жанр · \(genres.joined(separator: ", "))" : "Рядом с твоим вкусом")
            if focus && !e.eligible { reason = "Инструментальная музыка для концентрации" }
            if context != nil { reason = "Под настроение · " + reason.lowercased() }
            if !e.known && personal && fresh.recent && context == nil { reason = fresh.verified ? "Свежий релиз · рядом с твоим вкусом" : "Свежая публикация · близкий исполнитель" }
            ranked.append(Recommendation(track: track, score: score, reason: reason, newArtist: newArtist, known: e.known, nearby: nearby, languageFit: language, taste: e.fit, exposure: RecommendationContext(features: snapshot, lane: lane), scoredAt: now, freshness: fresh.score, recentRelease: fresh.recent, releasePreference: newReleaseTarget))
        }
        ranked.sort { $0.score == $1.score ? $0.id < $1.id : $0.score > $1.score }
        var recordings = Set<String>()
        let recentRecordings = Set(recent.compactMap { prepared.recordings[$0] })
        ranked = ranked.filter { (allowRecent || !recentRecordings.contains(prepared.recordings[$0.id] ?? $0.id)) && recordings.insert(prepared.recordings[$0.id] ?? $0.id).inserted }
        let ordered = sequence(ranked, library: library, limit: limit, now: now, currentID: currentID, index: prepared, hasTaste: !profile.positiveIDs.isEmpty)
        if retainFamiliarPool {
            let selected = Set(ordered.map(\.id))
            return ordered + ranked.filter { familiarPool.contains($0.id) && !selected.contains($0.id) }
        }
        return ordered
    }
    private static func recentIDs(_ library: Library, now: Date, exposureOnly: Bool = false) -> Set<String> { Set(library.events.filter { ($0.kind == .play || (!exposureOnly && [.listen, .skip].contains($0.kind))) && $0.at <= now && now.timeIntervalSince($0.at) < library.settings.repeatHours * 3600 }.map(\.trackID)) }
    public static func selectCached(_ cached: [Recommendation], library: Library, exclude: Set<String>, currentID: String? = nil, now: Date = Date(), index: RankingIndex? = nil, mood: String? = nil) -> Recommendation? {
        let prepared = index ?? makeIndex(cached.map { library.tracks[$0.id] ?? $0.track }, library: library), profile = TasteProfile(library: library, now: now)
        let recent = recentIDs(library, now: now, exposureOnly: true), recentRecordings = Set(recent.compactMap { prepared.recordings[$0] })
        let saved = Set(library.likedIDs + library.playlists.flatMap(\.trackIDs)), context = mood ?? (library.settings.mood == "any" ? nil : library.settings.mood)
        let heard = library.events.filter { $0.at <= now && now.timeIntervalSince($0.at) < 30 * 86400 }.map(\.trackID)
        let familiarArtists = Set(saved.union(heard).flatMap { prepared.artists[$0] ?? [] })
        var live: [Recommendation] = []
        let newReleaseTarget = ReleaseDiscovery.target(library, now: now)
        for item in cached {
            let track = library.tracks[item.id] ?? item.track
            guard !exclude.contains(item.id), !recent.contains(item.id), !recentRecordings.contains(prepared.recordings[item.id] ?? item.id), !library.hiddenIDs.contains(item.id), !PulseDiversity.blocked(track, settings: library.settings), library.settings.includeLibrary || !saved.contains(item.id), context.map({ MoodFitness.scores(track)[$0, default: 0] > 0 }) ?? true else { continue }
            // Refresh changed recording metadata, not a stale genre index.
            let updatedEvidence = evidence(track, profile: profile, index: prepared, library: library, familiarIDs: saved, liveMetadata: true)
            let focus = focusMatch(track, context: context) && !RecordingQuality.utility(track) && !library.dislikedIDs.contains(track.id)
            guard updatedEvidence.eligible || focus else { continue }
            var choice = item
            choice.track = track
            choice.taste = updatedEvidence.fit
            choice.score += (updatedEvidence.fit - item.taste) * 3
            let fresh = ReleaseDiscovery.freshness(track, now: now)
            let personal = updatedEvidence.sameArtist || updatedEvidence.preferredArtist || updatedEvidence.artistNeighbour || updatedEvidence.direct > 0 || (updatedEvidence.audio ?? 0) >= 0.92
            if personal && !updatedEvidence.known { choice.score += fresh.score * (newReleaseTarget - 0.4) * 3 - item.freshness * (item.releasePreference - 0.4) * 3 }
            choice.freshness = fresh.score; choice.recentRelease = fresh.recent
            choice.releasePreference = newReleaseTarget
            if !updatedEvidence.known && personal && fresh.recent && context == nil { choice.reason = fresh.verified ? "Свежий релиз · рядом с твоим вкусом" : "Свежая публикация · близкий исполнитель" }
            choice.known = updatedEvidence.known
            choice.nearby = updatedEvidence.nearby || focus || (context.map { updatedEvidence.genre > 0 && MoodFitness.scores(track)[$0, default: 0] >= 0.75 } ?? false)
            choice.languageFit = DiscoveryPolicy.languageFit(track, preference: library.settings.languagePreference)
            let names = PulseDiversity.artists(track)
            choice.newArtist = names.isDisjoint(with: familiarArtists) && !names.contains { $0.hasPrefix("unknown:") }
            if var snapshot = choice.exposure, snapshot.isValid {
                snapshot.features[5] = choice.newArtist ? 1 : 0; snapshot.features[6] = choice.known ? 1 : 0
                snapshot.features[1] = min(1, max(0, updatedEvidence.fit))
                snapshot.features[2] = updatedEvidence.direct > 0 ? 0.8 : updatedEvidence.sameArtist ? 0.7 : updatedEvidence.genre * 0.3
                snapshot.features[7] = choice.languageFit
                snapshot.features[9] = updatedEvidence.hasGenre ? 1 : 0
                if snapshot.features.count == 14 {
                    snapshot.features[10] = updatedEvidence.genre; snapshot.features[11] = updatedEvidence.sameArtist ? 1 : 0
                    snapshot.features[13] = updatedEvidence.audio ?? 0
                }
                snapshot.lane = choice.known ? "familiar" : choice.nearby ? "nearby" : "stretch"; choice.exposure = snapshot
            } else { choice.exposure = nil }
            for event in library.events.suffix(12) where event.kind == .skip && event.at > item.scoredAt && event.at <= now && event.reward != nil {
                guard let skipped = library.tracks[event.trackID] else { continue }
                let artist = !(prepared.artists[item.id] ?? []).isDisjoint(with: prepared.artists[skipped.id] ?? [])
                let genre = GenreClassifier.relation(prepared.genres[item.id] ?? [], prepared.genres[skipped.id] ?? [])
                choice.score -= max(artist ? 1 : 0, genre * 0.65) * (library.settings.skipSensitivity == "soft" ? 0.25 : 1) * 0.8
            }
            live.append(choice)
        }
        return sequence(live, library: library, limit: 1, now: now, currentID: currentID, index: prepared, hasTaste: !profile.positiveIDs.isEmpty).first
    }
    private static func sequence(_ initial: [Recommendation], library: Library, limit: Int, now: Date, currentID: String?, index: RankingIndex, hasTaste: Bool) -> [Recommendation] {
        var pool = initial, result: [Recommendation] = []
        let history = DiscoveryPolicy.history(library, now: now), spacing = PulseDiversity.limits(library.settings.artistDiversity)
        let rotation = FamiliarRotation.times(library, now: now), rotationSeed = Int(now.timeIntervalSince1970 / 3600)
        let familiarPool = FamiliarRotation.ids(library)
        var rolling = PulseDiversity.history(library, now: now, currentID: currentID).map { index.artists[$0.id] ?? PulseDiversity.artists($0) }
        var newCount = history.newTracks, languageCount = history.preferredLanguage, surpriseCount = history.surprises
        var freshArtists = history.newArtists, freshTracks = history.freshTracks
        let newReleaseTarget = ReleaseDiscovery.target(library, now: now)
        while !pool.isEmpty, result.count < limit {
            if Task.isCancelled { return [] }
            let recentArtists = Set(rolling.suffix(spacing.gap).flatMap { $0 })
            let counts = rolling.reduce(into: [String: Int]()) { counts, names in for name in names { counts[name, default: 0] += 1 } }
            var indices = Array(pool.indices)
            let deficit = library.settings.discovery * Double(history.classifiedCount + result.count + 1) - Double(newCount)
            if deficit < 0.5 {
                let saved = indices.filter { pool[$0].known }, favourites = saved.filter { familiarPool.contains(pool[$0].id) }
                let own = favourites.isEmpty ? saved : favourites
                let spaced = own.filter { (index.artists[pool[$0].id] ?? []).isDisjoint(with: recentArtists) && (index.artists[pool[$0].id] ?? []).allSatisfy { (counts[$0] ?? 0) < spacing.count } }
                let othersSpaced = indices.contains { (index.artists[pool[$0].id] ?? []).isDisjoint(with: recentArtists) && (index.artists[pool[$0].id] ?? []).allSatisfy { (counts[$0] ?? 0) < spacing.count } }
                let allowed = !spaced.isEmpty ? spaced : library.settings.artistDiversity > 0 && othersSpaced ? [] : own
                if let oldest = allowed.map({ rotation[pool[$0].id] ?? 0 }).min() { indices = allowed.filter { (rotation[pool[$0].id] ?? 0) == oldest } }
            }
            if library.settings.artistDiversity > 0 {
                let spaced = indices.filter { (index.artists[pool[$0].id] ?? []).isDisjoint(with: recentArtists) }
                let capped = spaced.filter { (index.artists[pool[$0].id] ?? []).allSatisfy { (counts[$0] ?? 0) < spacing.count } }
                if !capped.isEmpty { indices = capped } else if !spaced.isEmpty { indices = spaced }
            }
            if library.settings.explorationStyle != "adventurous", deficit >= 0.5 {
                let close = indices.filter { !pool[$0].known && pool[$0].taste >= 0.58 }
                if !close.isEmpty { indices = close }
            }
            let languageDeficit = 0.75 * Double(history.exposureCount + result.count + 1) - Double(languageCount)
            if deficit >= 0.5, library.settings.languagePreference != "any", languageDeficit >= 0.5 {
                let preferred = indices.filter { pool[$0].languageFit >= 0.6 }; if !preferred.isEmpty { indices = preferred }
            }
            let surpriseDeficit = history.surpriseRate * Double(history.classifiedCount + result.count + 1) - Double(surpriseCount)
            if hasTaste && surpriseDeficit < 0.5 {
                let safer = indices.filter { pool[$0].nearby }
                // An empty close pool cannot turn an explicit exploration limit
                // into permission to play every adjacent-genre candidate.
                guard !safer.isEmpty else { break }
                indices = safer
            }
            let balanced = indices.filter { pool[$0].known != (deficit >= 0.5) }; if !balanced.isEmpty { indices = balanced }
            if deficit >= 0.5, newReleaseTarget * Double(newCount + 1) - Double(freshTracks) >= 0.5 {
                let recent = indices.filter { !pool[$0].known && pool[$0].nearby && pool[$0].recentRelease }; if !recent.isEmpty { indices = recent }
            }
            let artistDeficit = library.settings.discovery * (0.6 + library.settings.artistDiversity * 0.25) * Double(history.classifiedCount + result.count + 1) - Double(freshArtists)
            if deficit >= 0.5, artistDeficit >= 0.5, library.settings.artistDiversity > 0 {
                let fresh = indices.filter { pool[$0].newArtist }; if !fresh.isEmpty { indices = fresh }
            }
            func selectionScore(_ position: Int) -> Double {
                let names = index.artists[pool[position].id] ?? []
                let occurrences: Int = names.map { counts[$0] ?? 0 }.max() ?? 0
                return pool[position].score - Double(occurrences) * library.settings.artistDiversity * 0.75
            }
            let rotateFamiliar = indices.allSatisfy { pool[$0].known }
            var best = indices[0]
            for candidate in indices.dropFirst() {
                if rotateFamiliar {
                    if FamiliarRotation.precedes(pool[candidate].id, pool[best].id, times: rotation, seed: rotationSeed) { best = candidate }
                    continue
                }
                let a = selectionScore(best), b = selectionScore(candidate)
                if b > a || (b == a && pool[candidate].id < pool[best].id) { best = candidate }
            }
            let item = pool.remove(at: best); result.append(item)
            if !item.nearby { surpriseCount += 1 }
            if !item.known { newCount += 1; if item.recentRelease { freshTracks += 1 } }; if item.languageFit >= 0.6 { languageCount += 1 }
            if item.newArtist { freshArtists += 1 }
            rolling.append(index.artists[item.id] ?? []); rolling = Array(rolling.suffix(12))
        }
        return result
    }
}
