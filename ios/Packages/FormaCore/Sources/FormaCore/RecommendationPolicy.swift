import Foundation

public enum RecommendationPolicy {
    private struct Rules: Decodable { let version: Int; let preferredArtists: [String]; let excludedArtists: [String] }
    private static let rules: Rules = {
        let url = Bundle.module.url(forResource: "taste-policy", withExtension: "json")!
        return try! JSONDecoder().decode(Rules.self, from: Data(contentsOf: url))
    }()
    public static var version: Int { rules.version }
    public static var preferredArtists: [String] { rules.preferredArtists }
    private static let excluded = rules.excludedArtists.map(PulseEngine.fold)
    public static func veto(_ track: Track) -> Bool {
        if GenreClassifier.hardVeto(track) { return true }
        let name = " " + PulseEngine.fold(track.artist) + " "
        return excluded.contains { name.contains(" " + $0 + " ") }
    }
}
