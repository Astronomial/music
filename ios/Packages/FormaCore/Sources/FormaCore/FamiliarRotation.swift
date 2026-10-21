import Foundation

/// Playback rotation is deliberately independent of model strength and cache
/// cutoffs. Persisted timestamps outlive the bounded listening-event log.
public enum FamiliarRotation {
    public static func ids(_ library: Library) -> Set<String> {
        Set(library.likedIDs + library.playlists.flatMap(\.trackIDs))
    }
    public static func times(_ library: Library, now: Date) -> [String: Double] {
        let cutoff = now.timeIntervalSince1970 * 1000
        var result = library.familiarPlays.filter { $0.value.isFinite && $0.value > 0 && $0.value <= cutoff }
        for event in library.events where event.kind == .play && event.at <= now {
            result[event.trackID] = max(result[event.trackID] ?? 0, event.at.timeIntervalSince1970 * 1000)
        }
        return result
    }
    public static func precedes(_ a: String, _ b: String, times: [String: Double], seed: Int) -> Bool {
        let x = times[a] ?? 0, y = times[b] ?? 0
        if x != y { return x < y }
        func noise(_ id: String) -> UInt32 {
            id.utf16.reduce(UInt32(truncatingIfNeeded: seed)) { ($0 ^ UInt32($1)) &* 16777619 }
        }
        let p = noise(a), q = noise(b)
        return p == q ? a < b : p < q
    }
}
