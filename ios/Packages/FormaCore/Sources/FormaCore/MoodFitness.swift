import Foundation

/// Recording evidence; retrieval labels and favourite status cannot admit a
/// track to a mood. The same rule resource is shipped by the desktop client.
public enum MoodFitness {
    public struct Rule: Decodable, Sendable {
        public let id: String
        public let title: String
        public let label: String
        public let headline: String
        public let subtitle: String
        public let query: String
        public let genres: [String]
        public var positive: [String]
        public var titleSignals: [String]
        public let conflicts: [String]
        public let maxEnergy: Double?
        public let minEnergy: Double?
    }
    public static let rules: [Rule] = {
        let url = Bundle.module.url(forResource: "mood-rules", withExtension: "json")!
        return try! JSONDecoder().decode([Rule].self, from: Data(contentsOf: url)).map { source in
            var rule = source; rule.positive = source.positive.map(PulseEngine.fold)
            rule.titleSignals = source.titleSignals.map(PulseEngine.fold); return rule
        }
    }()
    private struct Recording: Decodable, Sendable { let artist: String; let title: String; let moods: [String]; let instrumental: Bool; let genres: [String]? }
    private static let recordings: [Recording] = {
        let url = Bundle.module.url(forResource: "mood-recordings", withExtension: "json")!
        return try! JSONDecoder().decode([Recording].self, from: Data(contentsOf: url))
    }()
    private static func canonical(_ text: String) -> String {
        PulseEngine.fold(text).replacingOccurrences(of: "(?: official (?:music )?(?:video|audio)| lyrics| lyric video| topic| audio| video)$", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }
    private static let recordingIndex = Dictionary(uniqueKeysWithValues: recordings.map { (canonical($0.artist) + "|" + canonical($0.title), $0) })
    public static func recordingGenres(_ track: Track) -> [String] { recordingIndex[canonical(track.artist) + "|" + canonical(track.title)]?.genres ?? [] }
    public static func seedQueries(_ mood: String, artists: Set<String>, genres: [String], offset: Int, limit: Int = 3) -> [String] {
        let pool = recordings.filter { $0.moods.contains(mood) }.sorted {
            let a = artists.contains(PulseEngine.fold($0.artist)), b = artists.contains(PulseEngine.fold($1.artist))
            if a != b { return a }
            let x = GenreClassifier.relation($0.genres ?? [], genres), y = GenreClassifier.relation($1.genres ?? [], genres)
            return x == y ? $0.artist + $0.title < $1.artist + $1.title : x > y
        }
        let group = pool
        guard !group.isEmpty else { return [] }
        return (0..<min(limit, group.count)).map { let r = group[(max(0, offset) + $0) % group.count]; return r.artist + " " + r.title }
    }
    public static func seedQuery(_ mood: String, offset: Int = Int(Date().timeIntervalSince1970 / 86400)) -> String? {
        let pool = recordings.filter { $0.moods.contains(mood) }
        guard !pool.isEmpty else { return nil }
        let r = pool[((offset % pool.count) + pool.count) % pool.count]; return r.artist + " " + r.title
    }
    private static let instrumental = ["instrumental", "instrumentals", "без вокала", "без слов", "no vocals", "without vocals", "karaoke", "инструментальная", "инструментальный", "инструментал"]
    private static let vocals = ["vocals", "vocal", "singing", "with vocals", "с вокалом", "вокальная", "вокальный", "lyrics", "с текстом"]
    private static let intense = ["energetic", "aggressive", "hardstyle", "hardcore", "screamo", "workout", "агрессивная", "энергичная"]
    private static let gentle = (rules.first { $0.id == "calm" }?.positive ?? []) + ["lo fi", "soft", "focus", "focused", "study", "концентрация"]
    private static func contains(_ text: String, _ word: String) -> Bool { text.contains(" " + word + " ") }
    private static func has(_ text: String, _ words: [String]) -> Bool {
        words.contains { word in contains(text, word) && !["не", "not", "no", "without", "без"].contains { contains(text, $0 + " " + word) } }
    }
    public static func scores(_ track: Track) -> [String: Double] {
        let mood = " " + PulseEngine.fold(track.mood) + " ", tags = " " + PulseEngine.fold(track.tags.joined(separator: " ")) + " ", title = " " + PulseEngine.fold(track.title) + " "
        let sound = track.soundProfile.flatMap { $0.isValid ? $0 : nil }
        let tempo = sound.flatMap { $0.tempoConfidence >= 0.35 && $0.tempo > 0 ? min(1, max(0, ($0.tempo - 65) / 105)) : nil }
        let energy = sound.map { p in tempo.map { p.onsetRate * 0.6 + p.brightness * 0.2 + $0 * 0.2 } ?? (p.onsetRate * 0.6 + p.brightness * 0.4) }
        let reference = recordingIndex[Self.canonical(track.artist) + "|" + Self.canonical(track.title)]
        let inst = (reference?.instrumental ?? false) || has(tags, instrumental) || has(title, instrumental), voice = has(tags, vocals) || has(title, vocals)
        let calm = has(mood + tags, gentle) || has(title, ["relaxing piano", "спокойная музыка", "тихое фортепиано"]) || ["ambient", "lo fi"].contains(PulseEngine.fold(track.genre)) || (energy.map { $0 <= 0.35 } ?? false)
        var result: [String: Double] = [:]
        for rule in rules {
            var score = has(mood, [rule.id] + rule.positive) ? 0.95 : has(tags, rule.positive) ? 0.8 : has(title, rule.titleSignals) ? 0.65 : (reference?.moods.contains(rule.id) ?? false) ? 0.82 : 0
            let conflict = rule.conflicts.contains { id in
                guard let other = rules.first(where: { $0.id == id }) else { return false }
                return has(mood, [id] + other.positive) || has(tags, other.positive) || (score < 0.8 && has(title, other.titleSignals))
            }
            if conflict || (["calm", "focus", "night"].contains(rule.id) && (has(tags, intense) || has(title, ["hardstyle remix", "hardcore remix", "screamo cover", "aggressive remix", "энергичный ремикс"]))) || (rule.id == "bright" && has(tags, ["aggressive", "angry", "злая", "агрессивная"])) { result[rule.id] = 0; continue }
            if let energy, (rule.maxEnergy.map { energy > $0 } ?? false) || (rule.minEnergy.map { energy < $0 } ?? false) { result[rule.id] = 0; continue }
            if rule.id == "calm", let energy, energy <= 0.3 { score = max(score, 0.7) }
            if rule.id == "energetic", let energy, energy >= 0.64 { score = max(score, 0.7) }
            if rule.id == "night", let energy, energy <= 0.48, (sound?.brightness ?? 1) <= 0.4 { score = max(score, 0.66) }
            if rule.id == "focus" {
                guard inst, !voice, calm || (reference?.moods.contains("focus") ?? false) else { result[rule.id] = 0; continue }
                score = max(score, 0.75)
            }
            result[rule.id] = score >= 0.6 ? min(1, score + (track.moodHints.contains(rule.id) ? 0.03 : 0)) : 0
        }
        return result
    }
}
