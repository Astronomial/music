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
    private static let foldedArtists: NSCache<NSString, NSString> = {
        let cache = NSCache<NSString, NSString>(); cache.countLimit = 8192
        return cache
    }()
    public static func veto(_ track: Track) -> Bool {
        if GenreClassifier.hardVeto(track) { return true }
        if !GenreClassifier.hardExcluded.isDisjoint(with: track.soundProfile?.semantic?.inferredGenres ?? []) { return true }
        let key = track.artist as NSString
        let folded: String
        if let cached = foldedArtists.object(forKey: key) { folded = cached as String }
        else { folded = PulseEngine.fold(track.artist); foldedArtists.setObject(folded as NSString, forKey: key) }
        let name = " " + folded + " "
        return excluded.contains { name.contains(" " + $0 + " ") }
    }
}
