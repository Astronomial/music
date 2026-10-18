import Foundation

public struct Recommendation: Identifiable, Sendable {
    public var id: String { track.id }
    public let track: Track
    public var score: Double
    public let reason: String
    public var newArtist = false
    public var known = false
    public var nearby = false
    public var languageFit = 0.0
    public var taste = 0.0
    public var exposure: RecommendationContext? = nil
    public var scoredAt: Date = .distantPast
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
        var fit: Double; var genre: Double; var direct: Int; var sameArtist: Bool; var audio: Double?; var match: Track?; var known: Bool; var eligible: Bool
        var nearby: Bool { known || sameArtist || direct > 0 || (audio ?? 0) >= 0.9 || genre == 1 }
    }
    private static func evidence(_ track: Track, profile: TasteProfile, index: RankingIndex, library: Library, liveMetadata: Bool = false) -> Evidence {
        let names = liveMetadata ? PulseDiversity.artists(track) : (index.artists[track.id] ?? PulseDiversity.artists(track)), genres = liveMetadata ? GenreClassifier.genres(track) : (index.genres[track.id] ?? GenreClassifier.genres(track))
        let sameArtist = !names.isDisjoint(with: profile.artists.keys), known = (profile.weights[track.id] ?? 0) > 0
        let directIDs = Set(track.directRelatedTo).intersection(profile.positiveIDs)
        let direct = Set(directIDs.compactMap { library.tracks[$0] }.flatMap { index.artists[$0.id] ?? PulseDiversity.artists($0) }).count
        let genreFit = GenreClassifier.relation(genres, Array(profile.genres.keys))
        let genreAffinity = profile.genreStrength.map { name, strength in GenreClassifier.relation(genres, [name]) * strength }.max() ?? 0
        let artistAffinity = names.compactMap { profile.artistStrength[$0] }.max() ?? 0
        let topSeedWeight = profile.maxSeedWeight
        let rootAffinity = directIDs.compactMap { profile.weights[$0] }.max().map { $0 / max(1, topSeedWeight) } ?? 0
        let comparable = !genres.isEmpty && !profile.genres.isEmpty
        let audio = profile.soundSeeds.compactMap { SoundProfile.similarity(track.soundProfile, $0.soundProfile) }.max()
        // A general-purpose mix is not a song discovery, even when YouTube radio
        // returned it and attached the same broad Pop label as a favourite song.
        let utility = liveMetadata ? RecordingQuality.utility(track) : (index.utility[track.id] ?? RecordingQuality.utility(track))
        let allowed = (!utility || profile.allowsUtility) && !library.dislikedIDs.contains(track.id)
        let preferred = library.settings.preferredArtists.contains { names.contains(fold($0)) }
        let compatibleDirect = direct > 0 && (!comparable || genreFit > 0)
        let eligible = allowed && (profile.positiveIDs.isEmpty || known || sameArtist || compatibleDirect || genreFit > 0 || (!comparable && (audio ?? 0) >= 0.92) || preferred)
        let fit: Double
        if known { fit = 0.65 + 0.35 * min(1, (profile.weights[track.id] ?? 0) / max(1, topSeedWeight)) }
        else if sameArtist { fit = 0.65 + artistAffinity * 0.2 }
        else if compatibleDirect { fit = min(0.95, 0.58 + rootAffinity * 0.1 + Double(max(0, direct - 1)) * 0.09) }
        else { fit = max(genreAffinity * 0.42, (audio ?? 0) >= 0.9 ? (audio ?? 0) * 0.7 : 0) }
        let match = directIDs.sorted().compactMap { library.tracks[$0] }.first
        return Evidence(fit: fit, genre: genreFit, direct: compatibleDirect ? direct : 0, sameArtist: sameArtist, audio: audio, match: match, known: known, eligible: eligible)
    }
    public static func rank(_ candidates: [Track], library: Library, limit: Int = 30, mood: String? = nil, exclude: Set<String> = [], allowRecent: Bool = false, now: Date = Date(), currentID: String? = nil, index: RankingIndex? = nil, playlistID: String? = nil, trackID: String? = nil) -> [Recommendation] {
        guard limit > 0, let source = profileSource(library, playlistID: playlistID, trackID: trackID) else { return [] }
        let prepared = index ?? makeIndex(candidates, library: library), profile = TasteProfile(library: source, now: now)
        let context = mood ?? (library.settings.mood == "any" ? nil : library.settings.mood)
        let recent = recentIDs(library, now: now), saved = Set(library.likedIDs + library.playlists.flatMap(\.trackIDs))
        let feedback = ConsumptionFeedback.model(library, now: now), learner = ContextualLearning.model(library, now: now)
        let heardIDs: [String] = library.events.filter { $0.at <= now && now.timeIntervalSince($0.at) < 30 * 86400 }.map(\.trackID)
        let familiarIDs = saved.union(heardIDs)
        var familiar = Set<String>()
        for id in familiarIDs { familiar.formUnion(prepared.artists[id] ?? []) }
        let session = library.events.suffix(24).filter { $0.at <= now && now.timeIntervalSince($0.at) < 5400 && $0.reward != nil }
        var seen = Set<String>(), ranked: [Recommendation] = []
        for track in candidates {
            if Task.isCancelled { return [] }
            guard VideoID.isValid(track.id), seen.insert(track.id).inserted, !exclude.contains(track.id), !library.hiddenIDs.contains(track.id), !PulseDiversity.blocked(track, settings: library.settings), library.settings.includeLibrary || !saved.contains(track.id), allowRecent || !recent.contains(track.id) else { continue }
            if let seed = trackID.flatMap({ library.tracks[$0] }), TrackPulse.sameSong(track, seed) || TrackPulse.fit(track, seed: seed) <= 0.1 { continue }
            let moodFit = context.flatMap { prepared.moods[track.id]?[$0] } ?? 0
            if context != nil, moodFit <= 0 { continue }
            let e = evidence(track, profile: profile, index: prepared, library: source)
            guard e.eligible else { continue }
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
            let snapshot = ContextualLearning.features(taste: e.fit, nearby: e.direct > 0 ? 0.8 : e.sameArtist ? 0.7 : e.genre * 0.3, session: sessionFit, newArtist: newArtist, known: e.known, language: language, context: moodFit, metadata: !genres.isEmpty)
            let consumption = ConsumptionFeedback.predict(track, model: feedback, mood: context)
            let learned = ContextualLearning.predict(learner, features: snapshot)
            let preferred = library.settings.preferredArtists.contains { names.contains(fold($0)) } ? 1.0 : 0
            var score: Double = e.fit * 3 + e.genre * 0.45
            score += Double(min(3, e.direct)) * 0.65
            score += (e.audio ?? 0) * 0.3 + preferred + sessionFit
            score += moodFit * 0.6 + PulseDirections.score(track, settings: library.settings)
            score += GenreClassifier.relation(genres, library.settings.genres.flatMap(GenreClassifier.canonical)) * 0.7
            score += (consumption.mean - 0.5) * 0.6 + learned.correction * 0.45 + language * 0.12
            score -= min(2, artistNegative * 0.16) + min(0.5, genreNegative * 0.035)
            score -= min(3, max(0, -(profile.weights[track.id] ?? 0)) * 0.5)
            if let seed = trackID.flatMap({ library.tracks[$0] }) { score += 3 * TrackPulse.fit(track, seed: seed) }
            let lane = e.known ? "familiar" : e.nearby ? "nearby" : "stretch"
            var reason = e.known ? "Из твоей библиотеки" : e.sameArtist ? "Исполнитель из твоей библиотеки" : e.match.map { "Похоже на «\($0.title)» · \($0.artist)" } ?? (!genres.isEmpty ? "Близкий жанр · \(genres.joined(separator: ", "))" : "Рядом с твоим вкусом")
            if context != nil { reason = "Под настроение · " + reason.lowercased() }
            ranked.append(Recommendation(track: track, score: score, reason: reason, newArtist: newArtist, known: e.known, nearby: e.nearby, languageFit: language, taste: e.fit, exposure: RecommendationContext(features: snapshot, lane: lane), scoredAt: now))
        }
        ranked.sort { $0.score == $1.score ? $0.id < $1.id : $0.score > $1.score }
        var recordings = Set<String>()
        let recentRecordings = Set(recent.compactMap { prepared.recordings[$0] })
        ranked = ranked.filter { (allowRecent || !recentRecordings.contains(prepared.recordings[$0.id] ?? $0.id)) && recordings.insert(prepared.recordings[$0.id] ?? $0.id).inserted }
        return sequence(ranked, library: library, limit: limit, now: now, currentID: currentID, index: prepared)
    }
    private static func recentIDs(_ library: Library, now: Date, exposureOnly: Bool = false) -> Set<String> { Set(library.events.filter { ($0.kind == .play || (!exposureOnly && [.listen, .skip].contains($0.kind))) && $0.at <= now && now.timeIntervalSince($0.at) < library.settings.repeatHours * 3600 }.map(\.trackID)) }
    public static func selectCached(_ cached: [Recommendation], library: Library, exclude: Set<String>, currentID: String? = nil, now: Date = Date(), index: RankingIndex? = nil, mood: String? = nil) -> Recommendation? {
        let prepared = index ?? makeIndex(cached.map(\.track), library: library), profile = TasteProfile(library: library, now: now)
        let recent = recentIDs(library, now: now, exposureOnly: true), recentRecordings = Set(recent.compactMap { prepared.recordings[$0] })
        let saved = Set(library.likedIDs + library.playlists.flatMap(\.trackIDs)), context = mood ?? (library.settings.mood == "any" ? nil : library.settings.mood)
        var live: [Recommendation] = []
        for item in cached {
            let track = library.tracks[item.id] ?? item.track
            guard !exclude.contains(item.id), !recent.contains(item.id), !recentRecordings.contains(prepared.recordings[item.id] ?? item.id), !library.hiddenIDs.contains(item.id), !PulseDiversity.blocked(track, settings: library.settings), library.settings.includeLibrary || !saved.contains(item.id), context.map({ MoodFitness.scores(track)[$0, default: 0] > 0 }) ?? true else { continue }
            // Refresh changed recording metadata, not a stale genre index.
            guard evidence(track, profile: profile, index: prepared, library: library, liveMetadata: true).eligible else { continue }
            var choice = item
            for event in library.events.suffix(12) where event.kind == .skip && event.at > item.scoredAt && event.at <= now && event.reward != nil {
                guard let skipped = library.tracks[event.trackID] else { continue }
                let artist = !(prepared.artists[item.id] ?? []).isDisjoint(with: prepared.artists[skipped.id] ?? [])
                let genre = GenreClassifier.relation(prepared.genres[item.id] ?? [], prepared.genres[skipped.id] ?? [])
                choice.score -= max(artist ? 1 : 0, genre * 0.65) * (library.settings.skipSensitivity == "soft" ? 0.25 : 1) * 0.8
            }
            live.append(choice)
        }
        return sequence(live, library: library, limit: 1, now: now, currentID: currentID, index: prepared).first
    }
    private static func sequence(_ initial: [Recommendation], library: Library, limit: Int, now: Date, currentID: String?, index: RankingIndex) -> [Recommendation] {
        var pool = initial, result: [Recommendation] = []
        let history = DiscoveryPolicy.history(library, now: now), spacing = PulseDiversity.limits(library.settings.artistDiversity)
        var rolling = PulseDiversity.history(library, now: now, currentID: currentID).map { index.artists[$0.id] ?? PulseDiversity.artists($0) }
        var newCount = history.newTracks, languageCount = history.preferredLanguage
        while !pool.isEmpty, result.count < limit {
            if Task.isCancelled { return [] }
            let recentArtists = Set(rolling.suffix(spacing.gap).flatMap { $0 })
            let counts = rolling.reduce(into: [String: Int]()) { counts, names in for name in names { counts[name, default: 0] += 1 } }
            var indices = Array(pool.indices)
            if library.settings.artistDiversity > 0 {
                let spaced = indices.filter { (index.artists[pool[$0].id] ?? []).isDisjoint(with: recentArtists) }
                let capped = spaced.filter { (index.artists[pool[$0].id] ?? []).allSatisfy { (counts[$0] ?? 0) < spacing.count } }
                if !capped.isEmpty { indices = capped } else if !spaced.isEmpty { indices = spaced }
            }
            let languageDeficit = 0.75 * Double(history.exposureCount + result.count + 1) - Double(languageCount)
            if library.settings.languagePreference != "any", languageDeficit >= 0.5 {
                let preferred = indices.filter { pool[$0].languageFit >= 0.6 }; if !preferred.isEmpty { indices = preferred }
            }
            let deficit = library.settings.discovery * Double(history.classifiedCount + result.count + 1) - Double(newCount)
            if library.settings.explorationStyle != "adventurous" {
                let close = indices.filter { !pool[$0].known && pool[$0].taste >= 0.58 }
                if !close.isEmpty, deficit >= 0.5 { indices = close }
            }
            let balanced = indices.filter { pool[$0].known != (deficit >= 0.5) }; if !balanced.isEmpty { indices = balanced }
            if deficit >= 0.5, library.settings.artistDiversity > 0 {
                let fresh = indices.filter { pool[$0].newArtist }; if !fresh.isEmpty { indices = fresh }
            }
            func selectionScore(_ position: Int) -> Double {
                let names = index.artists[pool[position].id] ?? []
                let occurrences: Int = names.map { counts[$0] ?? 0 }.max() ?? 0
                return pool[position].score - Double(occurrences) * library.settings.artistDiversity * 0.75
            }
            var best = indices[0]
            for candidate in indices.dropFirst() {
                let a = selectionScore(best), b = selectionScore(candidate)
                if b > a || (b == a && pool[candidate].id < pool[best].id) { best = candidate }
            }
            let item = pool.remove(at: best); result.append(item)
            if !item.known { newCount += 1 }; if item.languageFit >= 0.6 { languageCount += 1 }
            rolling.append(index.artists[item.id] ?? []); rolling = Array(rolling.suffix(12))
        }
        return result
    }
}
