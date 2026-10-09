import Foundation

public enum PulseDiversity {
    public static func artists(_ track: Track) -> Set<String> {
        let stripped = track.artist.replacingOccurrences(of: #"\s*-?\s*Topic\s*$|VEVO\s*$"#, with: "", options: [.regularExpression, .caseInsensitive])
        let split = stripped.replacingOccurrences(of: #"\s*,\s*|\s+(?:feat\.?|ft\.?|featuring|with|&|x)\s+"#, with: "|", options: [.regularExpression, .caseInsensitive])
        let names = Set(split.components(separatedBy: "|").map(PulseEngine.fold).filter { !$0.isEmpty && $0 != "неизвестный исполнитель" && $0 != "исполнитель не указан" })
        return names.isEmpty ? ["unknown:\(track.id)"] : names
    }
    public static func recording(_ track: Track) -> String {
        let title = track.title.replacingOccurrences(of: #"\s*[\[(](?:official\s*)?(?:music\s*)?(?:audio|video|lyrics?|visuali[sz]er|hd|hq)[\])]\s*|\s*[-–—|]\s*(?:official\s*)?(?:music\s*)?(?:audio|video|lyrics?|visuali[sz]er|hd|hq)\s*$"#, with: "", options: [.regularExpression, .caseInsensitive])
        return artists(track).sorted().joined(separator: "|") + "::" + PulseEngine.fold(title)
    }
    public static func history(_ library: Library, now: Date = Date(), currentID: String? = nil) -> [Track] {
        var tracks = library.events.filter { $0.kind == .play && now.timeIntervalSince($0.at) >= 0 && now.timeIntervalSince($0.at) <= 5400 }.suffix(12).compactMap { library.tracks[$0.trackID] }
        if let currentID, tracks.last?.id != currentID, let current = library.tracks[currentID] { tracks.append(current) }
        return Array(tracks.suffix(12))
    }
    public static func newArtist(_ track: Track, library: Library, now: Date = Date()) -> Bool {
        let ids = Set(library.likedIDs + library.playlists.flatMap(\.trackIDs) + library.events.filter { [FeedbackKind.play, .listen, .skip].contains($0.kind) && $0.at <= now && now.timeIntervalSince($0.at) < 30 * 86400 }.map(\.trackID))
        let known = Set(ids.compactMap { library.tracks[$0] }.flatMap { artists($0) })
        let names = artists(track)
        return !names.contains(where: { $0.hasPrefix("unknown:") }) && names.isDisjoint(with: known)
    }
    public static func limits(_ value: Double) -> (gap: Int, count: Int) {
        (value <= 0 ? 0 : max(1, Int((1 + min(1, value) * 4).rounded())), value >= 0.85 ? 1 : value >= 0.45 ? 2 : 3)
    }
    /// Recheck cached candidates against live exposure before inserting a prepared item.
    public static func next(_ tracks: [Track], library: Library, exclude: Set<String>, currentID: String? = nil) -> Track? {
        let pool = tracks.filter { !exclude.contains($0.id) && !library.hiddenIDs.contains($0.id) && !blocked($0, settings: library.settings) }
        guard library.settings.artistDiversity > 0 else { return pool.first }
        let history = history(library, currentID: currentID), policy = limits(library.settings.artistDiversity)
        let recent = Set(history.suffix(policy.gap).flatMap { artists($0) })
        let counts = history.reduce(into: [String: Int]()) { result, track in for name in artists(track) { result[name, default: 0] += 1 } }
        let spaced: (Track) -> Bool = { artists($0).isDisjoint(with: recent) }
        let capped: (Track) -> Bool = { artists($0).allSatisfy { (counts[$0] ?? 0) < policy.count } }
        return pool.first { spaced($0) && capped($0) } ?? pool.first(where: spaced) ?? pool.first(where: capped) ?? pool.first
    }
    public static func blocked(_ track: Track, settings: PulseSettings) -> Bool {
        let name = PulseEngine.fold(track.artist)
        if settings.excludedArtists.map(PulseEngine.fold).contains(where: { !$0.isEmpty && name.contains($0) }) { return true }
        if !Set((track.genre.isEmpty ? track.genres : [track.genre]).map(PulseEngine.fold)).isDisjoint(with: Set(settings.excludedGenres.map(PulseEngine.fold))) { return true }
        if settings.genreMode == "strict", !settings.genres.isEmpty, Set((track.genre.isEmpty ? track.genres : [track.genre]).map(PulseEngine.fold)).isDisjoint(with: Set(settings.genres.map(PulseEngine.fold))) { return true }
        return false
    }
}
