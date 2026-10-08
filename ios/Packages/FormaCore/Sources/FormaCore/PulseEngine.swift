import Foundation

public struct Recommendation: Identifiable, Sendable {
    public var id: String { track.id }
    public let track: Track
    public let score: Double
    public let reason: String
    public var newArtist = false
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
    private typealias Vector = [String: Double]
    public static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX")).replacingOccurrences(of: "ё", with: "е").replacingOccurrences(of: "[^\\p{L}\\p{N}]+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private static func features(_ track: Track) -> Vector {
        var result: Vector = ["seed:\(track.id)": 1.1]
        if !track.artist.isEmpty && track.artist != "Исполнитель не указан" { result["artist:\(fold(track.artist))"] = 1.5 }
        for genre in track.genres { result["genre:\(fold(genre))"] = 0.55 }
        for mood in track.moodHints { result["mood:\(mood)"] = 0.3 }
        for id in track.relatedTo { result["seed:\(id)"] = 1.1 }
        return result
    }
    private static func similarity(_ a: Vector, _ b: Vector) -> Double {
        return a.reduce(0) { $0 + $1.value * (b[$1.key] ?? 0) }
    }
    private static func unit(_ vector: Vector) -> Vector {
        let norm = sqrt(vector.values.reduce(0) { $0 + $1 * $1 })
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
            guard let reward = event.reward else { continue }
            let strength = pow(0.5, max(0, now.timeIntervalSince(event.at)) / (30 * 86400))
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
    public static func rank(_ candidates: [Track], library: Library, limit: Int = 30,
                            mood: String? = nil, exclude: Set<String> = [], allowRecent: Bool = false,
                            now: Date = Date(), currentID: String? = nil) -> [Recommendation] {
        let vectors = Dictionary((Array(library.tracks.values) + candidates).map { ($0.id, unit(features($0))) }, uniquingKeysWith: { a, _ in a })
        let allTracks = Array(library.tracks.values) + candidates
        let names = Dictionary(allTracks.map { ($0.id, PulseDiversity.artists($0)) }, uniquingKeysWith: { a, _ in a })
        let familiarIDs = Set(library.likedIDs + library.playlists.flatMap(\.trackIDs) + library.events.filter { $0.kind != .error && now.timeIntervalSince($0.at) < 30 * 86400 }.map(\.trackID))
        let familiarArtists = Set(familiarIDs.flatMap { names[$0] ?? [] })
        let hidden = Set(library.hiddenIDs), saved = Set(library.likedIDs + library.playlists.flatMap(\.trackIDs))
        let trackWeights = weights(library, now: now)
        var positive: Vector = [:], negative: Vector = [:], session: Vector = [:]
        for (id, weight) in trackWeights {
            guard let track = library.tracks[id] else { continue }
            if weight >= 0 { add(features(track), weight: weight, to: &positive) }
            else { add(features(track), weight: -weight, to: &negative) }
        }
        for genre in library.settings.genres { positive["genre:\(fold(genre))", default: 0] += 1 }
        for event in library.events.suffix(80) {
            guard now.timeIntervalSince(event.at) <= 5400, let reward = event.reward, let track = library.tracks[event.trackID] else { continue }
            add(features(track), weight: (reward >= 0.7 ? 1 : -0.5) * pow(0.5, max(0, now.timeIntervalSince(event.at)) / 1800), to: &session)
        }
        positive = unit(positive); negative = unit(negative); session = unit(session)
        let cooldown = max(0, library.settings.repeatHours) * 3600
        let recent = Set(library.events.filter { ($0.kind == .play || $0.kind == .listen || $0.kind == .skip) && now.timeIntervalSince($0.at) < cooldown }.map(\.trackID))
        let excludedArtists = Set(library.settings.excludedArtists.map(fold))
        let context = mood ?? (library.settings.mood == "any" ? nil : library.settings.mood)
        var seen = Set<String>(), ranked: [Recommendation] = []
        let discovery = min(1, max(0, library.settings.discovery))
        let seedTracks = anchors(in: library, limit: 12, now: now)
        for track in candidates {
            if Task.isCancelled { return [] }
            guard VideoID.isValid(track.id), seen.insert(track.id).inserted, !exclude.contains(track.id),
                  !excludedArtists.contains(fold(track.artist)), !hidden.contains(track.id), !PulseDiversity.blocked(track, settings: library.settings), library.settings.includeLibrary || !saved.contains(track.id), allowRecent || !recent.contains(track.id) else { continue }
            if let context, !track.moodHints.contains(context) { continue }
            let vector = vectors[track.id] ?? [:]
            let affinity = 0.65 * similarity(vector, positive) + 0.35 * (seedTracks.map { similarity(vector, vectors[$0.id] ?? [:]) }.max() ?? 0)
            let known = (trackWeights[track.id] ?? 0) > 0
            let preferred = library.settings.preferredArtists.contains { fold(track.artist).contains(fold($0)) } ? 1.3 : 0
            let score = preferred + affinity * 2.2 - similarity(vector, negative) * 0.8 + similarity(vector, session) * 0.7
                + (known ? (1 - discovery) * 0.12 : discovery * (0.2 + affinity * 0.4))
                - max(0, -(trackWeights[track.id] ?? 0)) * 0.15
            let reason = known ? "Из твоей библиотеки" : track.relatedTo.contains(where: { (trackWeights[$0] ?? 0) > 0 }) ? "Рядом с твоими любимыми" : affinity > 0.1 ? "В твоём вкусе" : "Новое из YouTube"
            ranked.append(Recommendation(track: track, score: score, reason: context == nil ? reason : "Под настроение · \(reason.lowercased())", newArtist: (names[track.id] ?? []).isDisjoint(with: familiarArtists) && !(names[track.id] ?? []).contains(where: { $0.hasPrefix("unknown:") })))
        }
        ranked.sort { $0.score == $1.score ? $0.id < $1.id : $0.score > $1.score }
        var recordings = Set<String>()
        let recentlyHeard = Set(library.events.filter { now.timeIntervalSince($0.at) < cooldown && $0.kind == .play }.compactMap { library.tracks[$0.trackID] }.map(PulseDiversity.recording))
        ranked = ranked.filter { (allowRecent || !recentlyHeard.contains(PulseDiversity.recording($0.track))) && recordings.insert(PulseDiversity.recording($0.track)).inserted }
        let artistTotal = Set(ranked.flatMap { PulseDiversity.artists($0.track) }).count
        let cap = max(4, Int(ceil(Double(limit) / Double(max(1, artistTotal)))) * 2)
        var counts: [String: Int] = [:]
        let pool = ranked.filter { item in
            let names = PulseDiversity.artists(item.track)
            guard names.allSatisfy({ (counts[$0] ?? 0) < cap }) else { return false }
            for name in names { counts[name, default: 0] += 1 }; return true
        }
        if library.settings.artistDiversity > 0, pool.count >= min(limit, ranked.count) { ranked = pool }
        var result: [Recommendation] = [], artistCounts: [String: Int] = [:]
        var rolling = PulseDiversity.history(library, now: now, currentID: currentID).map(PulseDiversity.artists)
        let policy = PulseDiversity.limits(library.settings.artistDiversity)
        let freshTarget = 0.25 + library.settings.discovery * 0.5 + library.settings.artistDiversity * 0.25
        var discoveries = 0
        while !ranked.isEmpty, result.count < limit {
            if Task.isCancelled { return [] }
            let recentNames = Set(rolling.suffix(policy.gap).flatMap { $0 })
            let count = rolling.reduce(into: [String: Int]()) { result, names in for name in names { result[name, default: 0] += 1 } }
            let floor = min(0.12, (ranked.map(\.score).max() ?? 0) * 0.04)
            var indices = Array(ranked.indices)
            if library.settings.artistDiversity > 0 {
                let spaced = indices.filter { ranked[$0].score >= floor && PulseDiversity.artists(ranked[$0].track).isDisjoint(with: recentNames) }
                let diverse = spaced.filter { PulseDiversity.artists(ranked[$0].track).allSatisfy { (count[$0] ?? 0) < policy.count } }
                if !diverse.isEmpty { indices = diverse } else if !spaced.isEmpty { indices = spaced }
                if !result.isEmpty, freshTarget * Double(result.count + 1) - Double(discoveries) >= 0.5 {
                    let fresh = indices.filter { ranked[$0].newArtist && ranked[$0].score >= floor }; if !fresh.isEmpty { indices = fresh }
                }
            }
            let best = indices.max { a, b in adjusted(ranked[a], result: result, counts: artistCounts, vectors: vectors) < adjusted(ranked[b], result: result, counts: artistCounts, vectors: vectors) }!
            let item = ranked.remove(at: best); result.append(item)
            if item.newArtist { discoveries += 1 }
            artistCounts[fold(item.track.artist), default: 0] += 1
            rolling.append(PulseDiversity.artists(item.track)); rolling = Array(rolling.suffix(12))
        }
        return result
    }
    private static func adjusted(_ item: Recommendation, result: [Recommendation], counts: [String: Int], vectors: [String: Vector]) -> Double {
        let near = result.suffix(4).map { similarity(vectors[item.id] ?? [:], vectors[$0.id] ?? [:]) }.max() ?? 0
        return item.score - Double(counts[fold(item.track.artist)] ?? 0) * 0.7 - near * 0.25
    }
}
