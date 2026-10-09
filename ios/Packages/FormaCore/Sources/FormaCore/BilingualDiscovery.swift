import Foundation

/// Regional searches expand the candidate pool; text/script is only weak language evidence.
public enum BilingualDiscovery {
    public struct Search: Sendable {
        public let query: String
        public let genre: String?
        public let mood: String?
        public let hints: [String]
    }
    public static func searches(genres: [String], suffix: String, hints: [String]) -> [Search] {
        let ruGenres = ["Pop": "поп", "Rock": "рок", "Hip-Hop": "хип-хоп", "Electronic": "электронная", "Indie": "инди", "Jazz": "джаз", "Classical": "классическая"]
        let ruMoods = ["calm": "спокойная", "bright": "радостная", "melancholic": "грустная", "energetic": "энергичная", "focus": "инструментальная для работы", "night": "ночная"]
        var result: [Search] = []
        for (index, mix) in MoodMix.all.enumerated() {
            let genre = genres.isEmpty ? nil : genres[index % genres.count]
            let ru = genre.map { ruGenres[$0] ?? $0 } ?? ""
            result.append(Search(query: "\(ru) \(ruMoods[mix.id] ?? "") русская музыка \(suffix)", genre: genre, mood: mix.id, hints: hints + ["discovery:ru"]))
            result.append(Search(query: "\(genre ?? "") \(mix.query) \(suffix)", genre: genre, mood: mix.id, hints: hints))
        }
        for genre in genres.prefix(12) {
            result.append(Search(query: "\(ruGenres[genre] ?? genre) русская музыка \(suffix)", genre: genre, mood: nil, hints: hints + ["discovery:ru"]))
            result.append(Search(query: "\(genre) music \(suffix)", genre: genre, mood: nil, hints: hints))
        }
        return result
    }
    public static func regional(_ track: Track) -> Bool {
        (track.title + " " + track.artist).unicodeScalars.contains { (0x0400...0x052F).contains(Int($0.value)) }
    }
    /// Reserve soft regional discovery slots without overriding blocked artists or taste scores.
    /// Applied to home/mood lists; Pulse continues learning from the same library and feedback.
    public static func balanced(_ ranked: [Recommendation], artistDiversity: Double = 0.6) -> [Recommendation] {
        guard ranked.contains(where: { regional($0.track) }), ranked.contains(where: { !regional($0.track) }) else { return ranked }
        let regionalIDs = Set(ranked.filter { regional($0.track) }.map(\.id))
        let artists = Dictionary(ranked.map { ($0.id, PulseDiversity.artists($0.track)) }, uniquingKeysWith: { a, _ in a })
        var remaining = ranked, result: [Recommendation] = []
        while !remaining.isEmpty {
            let recent = Set(result.suffix(PulseDiversity.limits(artistDiversity).gap).flatMap { artists[$0.id] ?? [] })
            let spaced = remaining.indices.filter { (artists[remaining[$0].id] ?? []).isDisjoint(with: recent) }
            let pool = spaced.isEmpty ? Array(remaining.indices) : spaced
            let wantRegional = result.count % 3 == 2
            let index = pool.first { regionalIDs.contains(remaining[$0].id) == wantRegional } ?? pool[0]
            result.append(remaining.remove(at: index))
        }
        return result
    }
}
