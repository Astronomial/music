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
    public static let all: [MoodMix] = [
        .init(id: "calm", title: "Тише внутри", query: "calm music"),
        .init(id: "bright", title: "Светлая сторона", query: "happy music"),
        .init(id: "melancholic", title: "Чуть ближе к себе", query: "melancholic music"),
        .init(id: "energetic", title: "На полной", query: "energetic music"),
        .init(id: "focus", title: "Без лишних мыслей", query: "instrumental focus music"),
        .init(id: "night", title: "После полуночи", query: "late night music")
    ]
}

/// Hybrid content, seed-neighbour and session signals; diversity penalizes near repeats.
/// Query genre/mood labels are weaker than explicit artist/seed connections.
public enum PulseEngine {
    fileprivate typealias Vector = [String: Double]
    fileprivate typealias OrderedVector = [(String, Double)]
    private static let separators = try! NSRegularExpression(pattern: "[^\\p{L}\\p{N}]+")
    public static func fold(_ text: String) -> String {
        let value = text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX")).replacingOccurrences(of: "ё", with: "е")
        return separators.stringByReplacingMatches(in: value, range: NSRange(value.startIndex..., in: value), withTemplate: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private static func features(_ track: Track) -> Vector {
        var result: Vector = ["seed:\(track.id)": 1.1]
        if !track.artist.isEmpty && track.artist != "Исполнитель не указан" { result["artist:\(fold(track.artist))"] = 1.5 }
        for genre in track.genre.isEmpty ? track.genres : [track.genre] { result["genre:\(fold(genre))"] = track.genre.isEmpty ? 1.8 * 0.35 : 1.8 }
        if !track.mood.isEmpty { result["mood:\(track.mood)"] = 0.9 }
        for tag in track.tags.prefix(12) { result["tag:\(tag.lowercased())"] = 0.55 }
        for id in track.relatedTo { result["seed:\(id)"] = 1.1 }
        return result
    }
    private static func similarity(_ a: OrderedVector, _ b: Vector) -> Double {
        return a.reduce(0) { $0 + $1.1 * (b[$1.0] ?? 0) }
    }
    private static func unit(_ vector: Vector) -> Vector {
        let norm = sqrt(vector.keys.sorted().reduce(0) { $0 + pow(vector[$1] ?? 0, 2) })
        return norm > 0 ? vector.mapValues { $0 / norm } : [:]
    }
    private static func add(_ source: Vector, weight: Double, to target: inout Vector) {
        for (key, value) in source { target[key, default: 0] += value * weight }
    }
    private static func weights(_ library: Library, now: Date) -> [String: Double] {
        var result = Dictionary(library.likedIDs.map { ($0, 5.0) }, uniquingKeysWith: max)
        for playlist in library.playlists where library.settings.playlistSource != "selected" || library.settings.seedPlaylistIDs.contains(playlist.id) { for id in Set(playlist.trackIDs) { result[id] = min(9, (result[id] ?? 0) + 3) } }
        var implicit: [String: Double] = [:]
        for event in library.events {
            guard event.at <= now, event.kind == .listen || event.kind == .skip, let reward = event.reward else { continue }
            let strength = pow(0.5, max(0, now.timeIntervalSince(event.at)) / (30 * 86400)) * (event.kind == .skip && library.settings.skipSensitivity == "soft" ? 0.35 : 1)
            let weight = event.kind == .listen ? (reward == 1 ? 1.5 : 0.5) : reward == 0 ? -2.5 : -0.8
            implicit[event.trackID] = min(4, max(-7, (implicit[event.trackID] ?? 0) + weight * strength))
        }
        for (id, weight) in implicit { result[id, default: 0] += weight }
        return result
    }
    public static func anchors(in library: Library, limit: Int = 6, now: Date = Date()) -> [Track] {
        let positive = weights(library, now: now).filter { $0.value > 0 }.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
        let excluded = Set(library.settings.excludedArtists.map(fold))
        var groups: [String: [Track]] = [:], order: [String] = []
        for (id, _) in positive {
            guard let track = library.tracks[id], !excluded.contains(fold(track.artist)) && !library.hiddenIDs.contains(track.id) && !PulseDiversity.blocked(track, settings: library.settings) else { continue }
            let key = fold(track.artist)
            if groups[key] == nil { groups[key] = []; order.append(key) }
            groups[key]?.append(track)
        }
        var selected: [Track] = []
        for round in 0..<max(0, limit) {
            for key in order {
                if let group = groups[key], group.count > round { selected.append(group[round]) }
                if selected.count == limit { return selected }
            }
        }
        return selected
    }
    public struct RankingIndex: Sendable {
        fileprivate let vectors: [String: Vector]
        fileprivate let orderedVectors: [String: OrderedVector]
        fileprivate let artists: [String: Set<String>]
        fileprivate let artistKeys: [String: String]
        fileprivate let recordings: [String: String]
        fileprivate let semantic: [String: Vector]
    }
    public static func makeIndex(_ candidates: [Track], library: Library) -> RankingIndex {
        let tracks = library.tracks.merging(Dictionary(candidates.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }), uniquingKeysWith: { a, _ in a })
        let vectors = tracks.mapValues { unit(features($0)) }
        let ordered = vectors.mapValues { vector in vector.keys.sorted().map { ($0, vector[$0] ?? 0) } }
        return RankingIndex(vectors: vectors, orderedVectors: ordered, artists: tracks.mapValues(PulseDiversity.artists), artistKeys: tracks.mapValues { fold($0.artist) }, recordings: tracks.mapValues(PulseDiversity.recording), semantic: tracks.mapValues { unit(features($0).filter { !$0.key.hasPrefix("seed:") && !$0.key.hasPrefix("artist:") }) })
    }
    public static func rank(_ candidates: [Track], library: Library, limit: Int = 30,
                            mood: String? = nil, exclude: Set<String> = [], allowRecent: Bool = false,
                            now: Date = Date(), currentID: String? = nil, index: RankingIndex? = nil, playlistID: String? = nil) -> [Recommendation] {
        if let playlistID, !library.playlists.contains(where: { $0.id == playlistID && !$0.trackIDs.isEmpty }) { return [] }
        var profileSource = library
        if let playlistID, let playlist = library.playlists.first(where: { $0.id == playlistID }) {
            let seeds = Set(playlist.trackIDs)
            profileSource.likedIDs = []; profileSource.playlists = [playlist]; profileSource.settings.genres = []; profileSource.settings.playlistSource = "all"
            profileSource.events = library.events.filter { seeds.contains($0.trackID) || !(Set(library.tracks[$0.trackID]?.relatedTo ?? [])).isDisjoint(with: seeds) }
        }
        let prepared = index ?? makeIndex(candidates, library: library)
        let vectors = prepared.vectors, orderedVectors = prepared.orderedVectors, artistNames = prepared.artists
        let familiarIDs = Set(library.likedIDs + library.playlists.flatMap(\.trackIDs) + library.events.filter { [FeedbackKind.play, .listen, .skip].contains($0.kind) && $0.at <= now && now.timeIntervalSince($0.at) < 30 * 86400 }.map(\.trackID))
        let familiarArtists = Set(familiarIDs.flatMap { artistNames[$0] ?? [] })
        let hidden = Set(library.hiddenIDs), saved = Set(library.likedIDs + library.playlists.flatMap(\.trackIDs))
        let trackWeights = weights(profileSource, now: now)
        var positive: Vector = [:], negative: Vector = [:], positiveSession: Vector = [:], negativeSession: Vector = [:]
        var totals: [String: Double] = [:], saveCounts: [String: Int] = [:], positiveCount = 0.0, negativeCount = 0.0, negativeEvidence = 0.0
        for (id, weight) in trackWeights where weight > 0 {
            for artist in artistNames[id] ?? [] { totals[artist, default: 0] += weight; saveCounts[artist, default: 0] += 1 }
        }
        for (id, weight) in trackWeights.sorted(by: { $0.key < $1.key }) {
            guard let track = library.tracks[id] else { continue }
            if weight >= 0 {
                let scale = min(1, (artistNames[id] ?? []).map { (10 + 3 * log1p(Double(saveCounts[$0] ?? 0))) / max(1, totals[$0] ?? 0) }.min() ?? 1)
                add(features(track), weight: weight * scale, to: &positive)
            } else { add(features(track), weight: -weight, to: &negative); negativeEvidence += min(2.5, abs(weight)) }
        }
        for genre in profileSource.settings.genres { positive["genre:\(fold(genre))", default: 0] += 3 }
        for event in library.events.suffix(80) {
            guard event.at <= now, now.timeIntervalSince(event.at) <= 5400, let reward = event.reward, let track = library.tracks[event.trackID] else { continue }
            let strength = pow(0.5, now.timeIntervalSince(event.at) / 1800) * (event.kind == .skip && library.settings.skipSensitivity == "soft" ? 0.5 : 1)
            if reward >= 0.7 { add(features(track), weight: strength, to: &positiveSession); positiveCount += strength }
            else { add(features(track), weight: strength, to: &negativeSession); negativeCount += strength }
        }
        positive = unit(positive); negative = unit(negative); positiveSession = unit(positiveSession); negativeSession = unit(negativeSession)
        let contextual = ContextualLearning.model(library, now: now), feedback = ConsumptionFeedback.model(library, now: now)
        let cooldown = max(0, library.settings.repeatHours) * 3600
        let recent = Set(library.events.filter { ($0.kind == .play || $0.kind == .listen || $0.kind == .skip) && $0.at <= now && now.timeIntervalSince($0.at) < cooldown }.map(\.trackID))
        let excludedArtists = Set(library.settings.excludedArtists.map(fold))
        let context = mood ?? (library.settings.mood == "any" ? nil : library.settings.mood)
        var seen = Set<String>(), ranked: [Recommendation] = []
        let discovery = playlistID == nil ? min(1, max(0, library.settings.discovery)) : 0.75
        let seedTracks = anchors(in: profileSource, limit: 45, now: now)
        for track in candidates {
            if Task.isCancelled { return [] }
            guard VideoID.isValid(track.id), seen.insert(track.id).inserted, !exclude.contains(track.id),
                  !excludedArtists.contains(fold(track.artist)), !hidden.contains(track.id), !PulseDiversity.blocked(track, settings: library.settings), library.settings.includeLibrary || !saved.contains(track.id), allowRecent || !recent.contains(track.id) else { continue }
            if let context, !track.moodHints.contains(context) && track.mood != context { continue }
            let vector = orderedVectors[track.id] ?? []
            let affinity = 0.4 * similarity(vector, positive) + 0.6 * (seedTracks.map { similarity(vector, vectors[$0.id] ?? [:]) * min(1, (trackWeights[$0.id] ?? 0) / 3) }.max() ?? 0)
            let known = (trackWeights[track.id] ?? 0) > 0
            let names = artistNames[track.id] ?? [], newArtist = names.isDisjoint(with: familiarArtists) && !names.contains(where: { $0.hasPrefix("unknown:") })
            var neighbour = 0.0, matched: Track?, supporting = Set<String>(), indirect = false
            let semantic = (prepared.semantic[track.id] ?? [:]).sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
            let reliability = !track.genre.isEmpty || !track.mood.isEmpty || !track.tags.isEmpty ? 1.0 : track.genres.isEmpty ? 0 : 0.35
            for anchor in seedTracks {
                let sourceReliability = !anchor.genre.isEmpty || !anchor.mood.isEmpty || !anchor.tags.isEmpty ? 1.0 : anchor.genres.isEmpty ? 0 : 0.35
                let fit = !(artistNames[anchor.id] ?? []).isDisjoint(with: names) ? 0.7 : similarity(semantic, prepared.semantic[anchor.id] ?? [:]) * 0.65 * min(reliability, sourceReliability)
                if fit > neighbour { neighbour = fit; matched = anchor }
                if track.relatedTo.contains(anchor.id) {
                    if track.directRelatedTo.contains(anchor.id) { supporting.formUnion(artistNames[anchor.id] ?? []) } else { indirect = true }
                    if matched == nil { matched = anchor }
                }
            }
            neighbour = max(neighbour, !supporting.isEmpty ? min(0.9, 0.58 + 0.12 * Double(supporting.count - 1)) : indirect ? 0.34 : 0)
            let preferred = library.settings.preferredArtists.contains { !fold($0).isEmpty && fold(track.artist).contains(fold($0)) } ? 1.3 : 0
            let genres = track.genre.isEmpty ? track.genres : [track.genre]
            let genrePreference = !Set(genres.map(fold)).isDisjoint(with: Set(library.settings.genres.map(fold))) ? (track.genre.isEmpty ? 0.65 * 0.35 : 0.65) : 0
            let contextScore = context == nil ? 0.0 : track.mood.isEmpty ? 0.25 : 0.65
            let nearby = known || neighbour >= 0.24 || preferred + genrePreference >= 0.6 || (seedTracks.isEmpty && genrePreference + preferred > 0)
            let language = DiscoveryPolicy.languageFit(track, preference: library.settings.languagePreference)
            let session = (similarity(vector, positiveSession) * min(1, positiveCount / 2) * 1.05 - similarity(vector, negativeSession) * min(0.6, negativeCount / 4)) * min(1, max(0, library.settings.sessionInfluence)) / 0.65
            let snapshot = ContextualLearning.features(taste: affinity, nearby: neighbour, session: session, newArtist: newArtist, known: known, language: language, context: contextScore, metadata: !track.genre.isEmpty || !track.mood.isEmpty || !track.tags.isEmpty)
            let learned = ContextualLearning.predict(contextual, features: snapshot), consumption = ConsumptionFeedback.predict(track, model: feedback, mood: context)
            let exploration = discovery * (consumption.uncertainty + learned.uncertainty) / 2 * (0.08 + neighbour * 0.35)
            var score = preferred + genrePreference + PulseDirections.score(track, settings: library.settings) + affinity * 2.2 - similarity(vector, negative) * 1.65 * min(1, negativeEvidence / 8) + session
            score += known ? (1 - discovery) * 0.12 : discovery * (0.2 + affinity * 0.45)
            score += (consumption.mean - 0.5) * 1.6 + learned.correction * 1.4 + exploration + neighbour * 0.65 + language * 0.15 + contextScore
            score -= min(1.8, max(0, -(trackWeights[track.id] ?? 0)) * 0.3)
            if !nearby && !seedTracks.isEmpty { score -= library.settings.explorationStyle == "nearby" ? 0.35 : library.settings.explorationStyle == "balanced" ? 0.15 : 0 }
            let lane = known ? "familiar" : nearby ? "nearby" : "stretch"
            var reason = known ? "Из твоей библиотеки" : newArtist && neighbour >= 0.24 ? "Новый исполнитель · рядом с \(matched?.artist ?? "твоим вкусом")" : lane == "stretch" && !seedTracks.isEmpty ? "Небольшой шаг в новое направление" : affinity > 0.1 ? "В твоём вкусе" : "Новое из YouTube"
            if context != nil { reason = "Под настроение · " + reason.lowercased() }
            ranked.append(Recommendation(track: track, score: score, reason: reason, newArtist: newArtist, known: known, nearby: nearby, languageFit: language, taste: max(affinity, neighbour * 0.65), exposure: RecommendationContext(features: snapshot, lane: lane), scoredAt: now))
        }
        ranked.sort { $0.score == $1.score ? $0.id < $1.id : $0.score > $1.score }
        var recordings = Set<String>()
        let recentlyHeard = Set(library.events.filter {  $0.at <= now && now.timeIntervalSince($0.at) < cooldown && $0.kind == .play }.compactMap { library.tracks[$0.trackID] }.compactMap { prepared.recordings[$0.id] })
        ranked = ranked.filter { (allowRecent || !recentlyHeard.contains(prepared.recordings[$0.id] ?? $0.id)) && recordings.insert(prepared.recordings[$0.id] ?? $0.id).inserted }
        let artistTotal = Set(ranked.flatMap { (artistNames[$0.id] ?? []) }).count
        let cap = max(4, Int(ceil(Double(limit) / Double(max(1, artistTotal)))) * 2)
        var counts: [String: Int] = [:]
        let pool = ranked.filter { item in
            let names = artistNames[item.id] ?? []
            guard names.allSatisfy({ (counts[$0] ?? 0) < cap }) else { return false }
            for name in names { counts[name, default: 0] += 1 }; return true
        }
        if library.settings.artistDiversity > 0, pool.count >= min(limit, ranked.count) { ranked = pool }
        var selectionLibrary = library; selectionLibrary.settings.discovery = discovery
        return select(ranked, library: selectionLibrary, limit: limit, now: now, currentID: currentID, index: prepared)
    }
    /// Bounded live selection over cached scores, used while AVQueuePlayer preloads audio.
    /// Models/full-catalogue ranking run in AppModel's detached task, never in this callback.
    public static func selectCached(_ cached: [Recommendation], library: Library, exclude: Set<String>, currentID: String? = nil, now: Date = Date(), index: RankingIndex? = nil, mood: String? = nil) -> Recommendation? {
        let cooldown = max(0, library.settings.repeatHours) * 3600
        let recent = Set(library.events.filter { $0.kind == .play && $0.at <= now && now.timeIntervalSince($0.at) < cooldown }.map(\.trackID))
        let saved = Set(library.likedIDs + library.playlists.flatMap(\.trackIDs))
        let heardRecordings = Set(recent.compactMap { id in index?.recordings[id] ?? library.tracks[id].map(PulseDiversity.recording) })
        let context = mood ?? (library.settings.mood == "any" ? nil : library.settings.mood)
        let pool = cached.filter { !exclude.contains($0.id) && !recent.contains($0.id) && !heardRecordings.contains(index?.recordings[$0.id] ?? PulseDiversity.recording($0.track)) && !library.hiddenIDs.contains($0.id) && !PulseDiversity.blocked($0.track, settings: library.settings) && (library.settings.includeLibrary || !saved.contains($0.id)) && (context.map { mood in $0.track.mood == mood || $0.track.moodHints.contains(mood) } ?? true) }
        let prepared = index ?? makeIndex(pool.map(\.track), library: Library())
        // A just-recorded skip must affect the immediate button press, before the
        // detached full-catalogue learner finishes. Only apply events newer than
        // this cached score; later full rankings already contain their influence.
        let feedback = library.events.suffix(8).filter { $0.kind == .skip && $0.reward != nil && $0.at <= now }
        let live = pool.map { item -> Recommendation in
            var choice = item
            for event in feedback where event.at > item.scoredAt {
                guard let skipped = library.tracks[event.trackID] else { continue }
                let sameArtist = !(prepared.artists[item.id] ?? []).isDisjoint(with: prepared.artists[skipped.id] ?? PulseDiversity.artists(skipped))
                let semantic = (prepared.semantic[item.id] ?? [:]).sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
                let content = similarity(semantic, prepared.semantic[skipped.id] ?? [:])
                let reliability = !item.track.genre.isEmpty && !skipped.genre.isEmpty ? 1.0 : 0.35
                let linked = !(Set(item.track.relatedTo)).isDisjoint(with: Set(skipped.relatedTo)) || item.track.relatedTo.contains(skipped.id)
                let match = max(sameArtist ? 1 : 0, max(content * reliability * 0.65, linked ? 0.45 : 0))
                choice.score -= match * (library.settings.skipSensitivity == "soft" ? 0.35 : 1) * (event.reward == 0 ? 0.8 : 0.25)
            }
            return choice
        }
        return select(live, library: library, limit: 1, now: now, currentID: currentID, index: prepared).first
    }
    private static func select(_ initial: [Recommendation], library: Library, limit: Int, now: Date, currentID: String?, index: RankingIndex) -> [Recommendation] {
        var ranked = initial, result: [Recommendation] = [], artistCounts: [String: Int] = [:]
        var rolling = PulseDiversity.history(library, now: now, currentID: currentID).map { index.artists[$0.id] ?? PulseDiversity.artists($0) }
        let spacing = PulseDiversity.limits(library.settings.artistDiversity), history = DiscoveryPolicy.history(library, now: now)
        let discovery = min(1, max(0, library.settings.discovery))
        var newTracks = history.newTracks, surprises = history.surprises, languageCount = history.preferredLanguage
        while !ranked.isEmpty, result.count < limit {
            if Task.isCancelled { return [] }
            let lastArtists = Set(rolling.suffix(spacing.gap).flatMap { $0 })
            let counts = rolling.reduce(into: [String: Int]()) { counts, artists in for artist in artists { counts[artist, default: 0] += 1 } }
            let floor = min(0.12, (ranked.map(\.taste).max() ?? 0) * 0.45)
            let relevant: (Recommendation) -> Bool = { $0.taste >= floor }
            var pool = Array(ranked.indices)
            let stretchBudget = history.surpriseRate * Double(history.exposureCount + result.count + 1) - Double(surprises)
            if stretchBudget < 1 {
                let close = pool.filter { ranked[$0].nearby }
                let spacedClose = close.filter { relevant(ranked[$0]) && (index.artists[ranked[$0].id] ?? []).isDisjoint(with: lastArtists) && (index.artists[ranked[$0].id] ?? []).allSatisfy { (counts[$0] ?? 0) < spacing.count } }
                // Sparse YouTube metadata must not turn familiarity into permission
                // to repeat one artist. Relax confidence only for supported, relevant
                // neighbours when the strong neighbourhood has no diverse alternative.
                let supported = pool.filter { relevant(ranked[$0]) && (ranked[$0].exposure?.features[2] ?? 0) >= 0.15 }
                if !close.isEmpty { pool = library.settings.artistDiversity > 0 && spacedClose.isEmpty && !supported.isEmpty ? supported : close }
            }
            if library.settings.artistDiversity > 0 {
                let spaced = pool.filter { relevant(ranked[$0]) && (index.artists[ranked[$0].id] ?? []).isDisjoint(with: lastArtists) }
                let diverse = spaced.filter { (index.artists[ranked[$0].id] ?? []).allSatisfy { (counts[$0] ?? 0) < spacing.count } }
                let capped = pool.filter { relevant(ranked[$0]) && (index.artists[ranked[$0].id] ?? []).allSatisfy { (counts[$0] ?? 0) < spacing.count } }
                pool = !diverse.isEmpty ? diverse : !spaced.isEmpty ? spaced : !capped.isEmpty ? capped : pool
            }
            let deficit = discovery * Double(history.classifiedCount + result.count + 1) - Double(newTracks)
            if deficit >= 0.5 && library.settings.artistDiversity > 0 {
                let fresh = pool.filter { ranked[$0].newArtist && relevant(ranked[$0]) }; if !fresh.isEmpty { pool = fresh }
            }
            let languageDeficit = 0.75 * Double(history.exposureCount + result.count + 1) - Double(languageCount)
            if library.settings.languagePreference != "any", languageDeficit >= 0.5 {
                let preferred = pool.filter { ranked[$0].languageFit >= 0.6 && ranked[$0].nearby && relevant(ranked[$0]) }; if !preferred.isEmpty { pool = preferred }
            }
            let novelty = pool.filter { ranked[$0].known != (deficit >= 0.5) && ranked[$0].nearby && relevant(ranked[$0]) }
            if !novelty.isEmpty { pool = novelty }
            func score(_ i: Int) -> Double {
                let item = ranked[i], names = index.artists[item.id] ?? []
                let balance = (item.known ? -1.0 : 1) * min(1, max(-1, deficit)) * 0.16
                return adjusted(item, result: result, counts: artistCounts, vectors: index.vectors, orderedVectors: index.orderedVectors, artistKeys: index.artistKeys) + balance + item.languageFit * min(1, max(-1, languageDeficit)) * 0.2 - Double(names.map { counts[$0] ?? 0 }.max() ?? 0) * library.settings.artistDiversity * 0.5
            }
            let best = pool.reduce(pool[0]) { best, i in score(i) > score(best) ? i : best }
            let item = ranked.remove(at: best); result.append(item)
            if !item.known { newTracks += 1 }; if item.exposure?.lane == "stretch" { surprises += 1 }; if item.languageFit >= 0.6 { languageCount += 1 }
            artistCounts[index.artistKeys[item.id] ?? "", default: 0] += 1
            rolling.append(index.artists[item.id] ?? []); rolling = Array(rolling.suffix(12))
        }
        return result
    }
    private static func adjusted(_ item: Recommendation, result: [Recommendation], counts: [String: Int], vectors: [String: Vector], orderedVectors: [String: OrderedVector], artistKeys: [String: String]) -> Double {
        let near = result.suffix(4).map { similarity(orderedVectors[item.id] ?? [], vectors[$0.id] ?? [:]) }.max() ?? 0
        return item.score - Double(counts[artistKeys[item.id] ?? ""] ?? 0) * 0.7 - near * 0.25
    }
}
