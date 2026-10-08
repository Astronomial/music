import Foundation

public struct Recommendation: Identifiable, Sendable {
    public var id: String { track.id }
    public let track: Track
    public let score: Double
    public let reason: String
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

/// A small portable starting point, not the full desktop engine or a Spotify model.
/// Query genre/mood labels are weaker than explicit artist/seed connections.
public enum PulseEngine {
    private typealias Vector = [String: Double]
    public static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX")).replacingOccurrences(of: "ё", with: "е").trimmingCharacters(in: .whitespacesAndNewlines)
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
        let aa = a.values.reduce(0) { $0 + $1 * $1 }, bb = b.values.reduce(0) { $0 + $1 * $1 }
        guard aa > 0, bb > 0 else { return 0 }
        return a.reduce(0) { $0 + $1.value * (b[$1.key] ?? 0) } / sqrt(aa * bb)
    }
    private static func add(_ source: Vector, weight: Double, to target: inout Vector) {
        for (key, value) in source { target[key, default: 0] += value * weight }
    }
    private static func weights(_ library: Library, now: Date) -> [String: Double] {
        var result = Dictionary(library.likedIDs.map { ($0, 5.0) }, uniquingKeysWith: max)
        for playlist in library.playlists { for id in Set(playlist.trackIDs) { result[id] = min(9, (result[id] ?? 0) + 3) } }
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
            guard let track = library.tracks[id], !excluded.contains(fold(track.artist)) else { continue }
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
                            now: Date = Date()) -> [Recommendation] {
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
        let cooldown = max(0, library.settings.repeatHours) * 3600
        let recent = Set(library.events.filter { $0.kind != .error && now.timeIntervalSince($0.at) < cooldown }.map(\.trackID))
        let excludedArtists = Set(library.settings.excludedArtists.map(fold))
        let context = mood ?? (library.settings.mood == "any" ? nil : library.settings.mood)
        var seen = Set<String>(), ranked: [Recommendation] = []
        let discovery = min(1, max(0, library.settings.discovery))
        let seedTracks = anchors(in: library, limit: 12, now: now)
        for track in candidates {
            guard VideoID.isValid(track.id), seen.insert(track.id).inserted, !exclude.contains(track.id),
                  !excludedArtists.contains(fold(track.artist)), allowRecent || !recent.contains(track.id) else { continue }
            if let context, !track.moodHints.contains(context) { continue }
            let vector = features(track)
            let affinity = 0.65 * similarity(vector, positive) + 0.35 * (seedTracks.map { similarity(vector, features($0)) }.max() ?? 0)
            let known = (trackWeights[track.id] ?? 0) > 0
            let score = affinity * 2.2 - similarity(vector, negative) * 0.8 + similarity(vector, session) * 0.7
                + (known ? (1 - discovery) * 0.12 : discovery * (0.2 + affinity * 0.4))
                - max(0, -(trackWeights[track.id] ?? 0)) * 0.15
            let reason = known ? "Из твоей библиотеки" : track.relatedTo.contains(where: { (trackWeights[$0] ?? 0) > 0 }) ? "Рядом с твоими любимыми" : affinity > 0.1 ? "В твоём вкусе" : "Новое из YouTube"
            ranked.append(Recommendation(track: track, score: score, reason: context == nil ? reason : "Под настроение · \(reason.lowercased())"))
        }
        ranked.sort { $0.score == $1.score ? $0.id < $1.id : $0.score > $1.score }
        var result: [Recommendation] = [], artistCounts: [String: Int] = [:]
        while !ranked.isEmpty, result.count < limit {
            let best = ranked.indices.max { a, b in
                adjusted(ranked[a], result: result, counts: artistCounts) < adjusted(ranked[b], result: result, counts: artistCounts)
            }!
            let item = ranked.remove(at: best); result.append(item)
            artistCounts[fold(item.track.artist), default: 0] += 1
        }
        return result
    }
    private static func adjusted(_ item: Recommendation, result: [Recommendation], counts: [String: Int]) -> Double {
        let near = result.suffix(4).map { similarity(features(item.track), features($0.track)) }.max() ?? 0
        return item.score - Double(counts[fold(item.track.artist)] ?? 0) * 0.7 - near * 0.25
    }
}
