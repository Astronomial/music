import Foundation

public struct GenreEvidence: Codable, Sendable, Hashable {
    public var version = 1
    public var source = "itunes"
    public var values: [String]
    public var confidence: Double
    /// Unix milliseconds, shared with the PC library format.
    public var checkedAt: Double
    public var recordingId: String
    public var releasedAt: Double? = nil
    public init(values: [String], confidence: Double, checkedAt: Double, recordingId: String, releasedAt: Double? = nil) {
        self.values = values; self.confidence = confidence; self.checkedAt = checkedAt; self.recordingId = recordingId; self.releasedAt = releasedAt
    }
    public var isValid: Bool { version == 1 && source == "itunes" && values.count <= 4 && confidence.isFinite && (0...0.95).contains(confidence) && checkedAt.isFinite && checkedAt >= 0 && recordingId.count <= 60 && (values.isEmpty ? confidence == 0 : Set(values).isSubset(of: Set(GenreClassifier.aliases.keys))) }
}

/// Recording metadata is evidence. Search directions never become genre labels.
public enum GenreClassifier {
    public static let hardExcluded: Set<String> = ["Chanson", "Blatnaya", "Caucasian Estrada", "Children's Music"]
    static let aliases: [String: [String]] = {
        guard let url = Bundle.module.url(forResource: "genre-aliases", withExtension: "json"), let data = try? Data(contentsOf: url), let rules = try? JSONDecoder().decode([String: [String]].self, from: data) else { return [:] }
        return rules
    }()
    private static let reverse = Dictionary(aliases.flatMap { key, values in ([key] + values).map { (PulseEngine.fold($0), key) } }, uniquingKeysWith: { a, _ in a })
    public static func canonical(_ value: String) -> [String] {
        let text = PulseEngine.fold(value)
        if let exact = reverse[text] { return [exact] }
        let parts = value.components(separatedBy: CharacterSet(charactersIn: ",;|/"))
        return parts.count > 1 ? Array(Set(parts.flatMap(canonical))).sorted() : []
    }
    /// Hard rules survive conflicting positive metadata and library membership.
    /// Search directions, artist names and geographical identity are not labels.
    public static func hardVeto(_ track: Track) -> Bool {
        if !hardExcluded.isDisjoint(with: canonical(track.genre)) { return true }
        if let evidence = track.genreEvidence, evidence.isValid, !hardExcluded.isDisjoint(with: evidence.values) { return true }
        return track.tags.contains { !hardExcluded.isDisjoint(with: canonical($0)) }
    }
    public static func genres(_ track: Track) -> [String] {
        if let evidence = track.genreEvidence, evidence.isValid, evidence.confidence >= 0.8, !evidence.values.isEmpty { return evidence.values }
        let metadata = canonical(track.genre)
        return metadata.isEmpty ? MoodFitness.recordingGenres(track) : metadata
    }
    public static func confidence(_ track: Track) -> Double {
        if let evidence = track.genreEvidence, evidence.isValid, evidence.confidence >= 0.8, !evidence.values.isEmpty { return evidence.confidence }
        return canonical(track.genre).isEmpty ? (MoodFitness.recordingGenres(track).isEmpty ? 0 : 0.85) : 1
    }
    private static let neighbours = [["Electronic", "House", "Techno", "Drum & Bass"], ["Ambient", "Lo-Fi"], ["Pop", "R&B/Soul"], ["Rock", "Alternative", "Metal"], ["Hip-Hop/Rap", "R&B/Soul"], ["Jazz", "Lo-Fi"]]
    public static func relation(_ a: Track, _ b: Track) -> Double {
        relation(genres(a), genres(b))
    }
    public static func relation(_ a: [String], _ b: [String]) -> Double {
        let x = Set(a), y = Set(b)
        if !x.isDisjoint(with: y) { return 1 }
        return neighbours.contains { !x.isDisjoint(with: $0) && !y.isDisjoint(with: $0) } ? 0.5 : 0
    }
    public static func recordingIdentity(_ title: String) -> String {
        PulseEngine.fold(title.replacingOccurrences(of: #"\s*[\[(](?:official\s*)?(?:music\s*)?(?:audio|video|lyrics?|visualizer|hd|hq)[\])]"#, with: "", options: [.regularExpression, .caseInsensitive]).replacingOccurrences(of: #"\s*[-–—|]\s*(?:official\s*)?(?:music\s*)?(?:audio|video|lyrics?|visualizer|hd|hq)\s*$"#, with: "", options: [.regularExpression, .caseInsensitive]))
    }
    public static func artistIdentity(_ artist: String) -> String { PulseEngine.fold(artist.replacingOccurrences(of: #"\s*-?\s*Topic\s*$|VEVO\s*$"#, with: "", options: [.regularExpression, .caseInsensitive])) }
    public struct Recording: Decodable, Sendable {
        public let kind: String?
        public let trackName: String?
        public let artistName: String?
        public let primaryGenreName: String?
        public let trackTimeMillis: Double?
        public let trackId: Int?
        public let releaseDate: String?
    }
    public static func match(_ track: Track, recordings: [Recording], now: Date = Date()) -> GenreEvidence {
        let matches = recordings.filter { row in
            row.kind == "song" && recordingIdentity(row.trackName ?? "") == recordingIdentity(track.title) && artistIdentity(row.artistName ?? "") == artistIdentity(track.artist) && (track.duration <= 0 || row.trackTimeMillis == nil || abs(track.duration - (row.trackTimeMillis ?? 0) / 1000) <= max(6, track.duration * 0.04))
        }
        let labels = Set(matches.flatMap { canonical($0.primaryGenreName ?? "") })
        let values = labels.count == 1 ? Array(labels).sorted() : []
        let dates = matches.compactMap { ReleaseDiscovery.timestamp($0.releaseDate) }.filter { $0 <= (now.timeIntervalSince1970 + 86400) * 1000 }
        return GenreEvidence(values: values, confidence: values.isEmpty ? 0 : 0.95, checkedAt: now.timeIntervalSince1970 * 1000, recordingId: values.isEmpty ? "" : matches.first?.trackId.map(String.init) ?? "", releasedAt: dates.min())
    }
}
