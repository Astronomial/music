import Foundation

public enum DiscoveryCache {
    /// Evict the least recently fetched unsaved recordings. User collections and
    /// recent feedback survive even if the explicit library exceeds the budget.
    public static func trim(_ library: inout Library, seen: [String: Date], protected: Set<String> = [], limit: Int = 4000) {
        guard library.tracks.count > limit else { return }
        let keep = protected.union(library.likedIDs).union(library.playlists.flatMap(\.trackIDs)).union(library.events.suffix(500).map(\.trackID))
        let removable = library.tracks.keys.filter { !keep.contains($0) }.sorted {
            let a = seen[$0] ?? .distantPast, b = seen[$1] ?? .distantPast
            return a == b ? $0 < $1 : a < b
        }
        for id in removable.prefix(max(0, library.tracks.count - max(0, limit))) { library.tracks.removeValue(forKey: id) }
    }
}
