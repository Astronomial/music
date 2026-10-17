import Foundation

/// Regional searches expand the candidate pool; text/script is only weak language evidence.
public enum BilingualDiscovery {
    public struct Search: Sendable {
        public let query: String
        public let genre: String?
        public let mood: String?
        public let hints: [String]
    }
    public static func tasteGenres(anchors: [Track], settings: PulseSettings) -> [String] {
        let learned = anchors.filter { !PulseDiversity.blocked($0, settings: settings) }.flatMap { GenreClassifier.genres($0) }
        var seen = Set<String>()
        let values = settings.genreMode == "strict" ? settings.genres : learned + (anchors.isEmpty ? settings.genres : [])
        let defaults = values.isEmpty ? (anchors.isEmpty ? ["Pop", "Alternative", "Electronic"] : []) : values
        return Array(defaults.filter { !settings.excludedGenres.contains($0) && seen.insert($0).inserted }.prefix(12))
    }
    public static func searches(genres: [String], suffix: String, hints: [String], language: String = "ru", artists: [String] = []) -> [Search] {
        let ruGenres = ["Pop": "поп", "Rock": "рок", "Hip-Hop": "хип-хоп", "Hip-Hop/Rap": "рэп хип-хоп", "Electronic": "электронная", "Indie": "инди", "Alternative": "альтернатива", "Jazz": "джаз", "Classical": "классическая", "House": "хаус", "Techno": "техно", "Ambient": "эмбиент", "R&B/Soul": "соул ритм-н-блюз", "Lo-Fi": "лоу-фай", "Drum & Bass": "драм-н-бейс"]
        let ruMoods = ["calm": "спокойная", "bright": "радостная", "melancholic": "грустная", "energetic": "энергичная", "focus": "для концентрации", "night": "ночная"]
        func regionalSuffix(_ hints: [String]) -> String { hints.compactMap { hint in
            ["energy:low": "медленная", "energy:medium": "средний темп", "energy:high": "быстрая", "vocals:instrumental": "без вокала", "vocals:vocal": "с вокалом"][hint]
        }.joined(separator: " ") }
        let ruSuffix = regionalSuffix(hints)
        func query(_ words: [String]) -> String { words.filter { !$0.isEmpty }.joined(separator: " ") }
        var result: [Search] = []
        for (index, mix) in MoodMix.all.enumerated() {
            let genre = genres.isEmpty ? nil : genres[index % genres.count]
            let artist = artists.isEmpty ? "" : artists[index % artists.count]
            // A shelf's character takes precedence over global energy/vocal search filters.
            var moodHints = hints
            if ["calm", "focus", "night", "energetic"].contains(mix.id) {
                moodHints.removeAll { $0.hasPrefix("energy:") }; moodHints.append("energy:" + (mix.id == "energetic" ? "high" : "low"))
            }
            if mix.id == "focus" { moodHints.removeAll { $0.hasPrefix("vocals:") }; moodHints.append("vocals:instrumental") }
            let moodSuffix = moodHints.compactMap { ["energy:low": "slow", "energy:medium": "medium tempo", "energy:high": "upbeat", "vocals:instrumental": "instrumental", "vocals:vocal": "vocal"][$0] }.joined(separator: " ")
            if language != "en", let seed = MoodFitness.seedQuery(mix.id) {
                result.append(Search(query: seed, genre: nil, mood: mix.id, hints: ["mood:reference"]))
            }
            if language != "en" {
                let words = [genre.map { ruGenres[$0] ?? $0 } ?? "", ruMoods[mix.id] ?? "", "русская музыка", regionalSuffix(moodHints)]
                result.append(Search(query: query([artist] + words), genre: genre, mood: mix.id, hints: moodHints + ["discovery:ru"]))
                if language == "ru", !artist.isEmpty { result.append(Search(query: query(words), genre: genre, mood: mix.id, hints: moodHints + ["discovery:ru"])) }
            }
            if language != "ru" {
                result.append(Search(query: query([artist, genre ?? "", mix.query, moodSuffix, language == "en" ? "english songs" : ""]), genre: genre, mood: mix.id, hints: moodHints + (language == "en" ? ["discovery:en"] : [])))
            }
        }
        for (index, genre) in genres.prefix(12).enumerated() {
            if language != "en" { result.append(Search(query: query([ruGenres[genre] ?? genre, "русская музыка", ruSuffix]), genre: genre, mood: nil, hints: hints + ["discovery:ru"])) }
            if language != "ru" || index < 2 { result.append(Search(query: query([genre, "music", suffix, language == "en" ? "english songs" : ""]), genre: genre, mood: nil, hints: hints + (language == "en" ? ["discovery:en"] : []))) }
        }
        return result
    }
    public static func rankHome(_ candidates: [Track], library: Library, limit: Int, mood: String? = nil, allowRecent: Bool = false, index: PulseEngine.RankingIndex? = nil) -> [Recommendation] {
        // One shared sequence policy; a separate language reorder would undo its balance.
        PulseEngine.rank(candidates, library: library, limit: limit, mood: mood, allowRecent: allowRecent, index: index)
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
