import Foundation

/// Three-way merge preserves edits made while a request was in flight.
public enum LibrarySync {
    private static func equal<T: Encodable>(_ a: T, _ b: T) -> Bool {
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        return (try? encoder.encode(a)) == (try? encoder.encode(b))
    }
    public static func mergeIDs(current: [String], base: [String], incoming: [String]) -> [String] {
        let old = Set(base), next = Set(incoming)
        var seen = Set<String>()
        return (current.filter { !old.contains($0) || next.contains($0) } + incoming).filter { seen.insert($0).inserted }
    }
    public static func merge(current: Library, base: Library, incoming: Library) -> Library {
        var result = current
        for (id, track) in incoming.tracks where !equal(base.tracks[id], track) { result.merge([track]) }
        result.hiddenIDs = mergeIDs(current: current.hiddenIDs, base: base.hiddenIDs, incoming: incoming.hiddenIDs)
        result.likedIDs = mergeIDs(current: current.likedIDs, base: base.likedIDs, incoming: incoming.likedIDs)
        var playlists = Dictionary(current.playlists.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        let before = Dictionary(base.playlists.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        let after = Dictionary(incoming.playlists.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        for id in Set(before.keys).union(after.keys) {
            guard !equal(before[id], after[id]) else { continue }
            guard let next = after[id] else { playlists.removeValue(forKey: id); continue }
            if let old = before[id], var actual = playlists[id] {
                if old.name != next.name { actual.name = next.name }
                actual.trackIDs = mergeIDs(current: actual.trackIDs, base: old.trackIDs, incoming: next.trackIDs)
                playlists[id] = actual
            } else { playlists[id] = next }
        }
        result.playlists = playlists.values.sorted { $0.id < $1.id }
        func key(_ e: ListeningEvent) -> String { "\(e.trackID)|\(e.kind.rawValue)|\(e.at.timeIntervalSince1970)|\(e.seconds)|\(e.ratio)|\(e.mood ?? "")" }
        var history = Dictionary(current.events.map { (key($0), $0) }, uniquingKeysWith: { a, _ in a })
        let oldEvents = Dictionary(base.events.map { (key($0), $0) }, uniquingKeysWith: { a, _ in a })
        let newEvents = Dictionary(incoming.events.map { (key($0), $0) }, uniquingKeysWith: { a, _ in a })
        for id in Set(oldEvents.keys).union(newEvents.keys) where !equal(oldEvents[id], newEvents[id]) { history[id] = newEvents[id] }
        result.events = Array(history.values.sorted { $0.at < $1.at }.suffix(3000))
        if base.settings.genres != incoming.settings.genres { result.settings.genres = mergeIDs(current: current.settings.genres, base: base.settings.genres, incoming: incoming.settings.genres) }
        if base.settings.excludedArtists != incoming.settings.excludedArtists { result.settings.excludedArtists = mergeIDs(current: current.settings.excludedArtists, base: base.settings.excludedArtists, incoming: incoming.settings.excludedArtists) }
        if base.settings.discovery != incoming.settings.discovery { result.settings.discovery = incoming.settings.discovery }
        if base.settings.repeatHours != incoming.settings.repeatHours { result.settings.repeatHours = incoming.settings.repeatHours }
        if base.settings.mood != incoming.settings.mood { result.settings.mood = incoming.settings.mood }
        if base.settings.excludedGenres != incoming.settings.excludedGenres { result.settings.excludedGenres = mergeIDs(current: current.settings.excludedGenres, base: base.settings.excludedGenres, incoming: incoming.settings.excludedGenres) }
        if base.settings.preferredArtists != incoming.settings.preferredArtists { result.settings.preferredArtists = mergeIDs(current: current.settings.preferredArtists, base: base.settings.preferredArtists, incoming: incoming.settings.preferredArtists) }
        if base.settings.seedPlaylistIDs != incoming.settings.seedPlaylistIDs { result.settings.seedPlaylistIDs = mergeIDs(current: current.settings.seedPlaylistIDs, base: base.settings.seedPlaylistIDs, incoming: incoming.settings.seedPlaylistIDs) }
        if base.settings.artistDiversity != incoming.settings.artistDiversity { result.settings.artistDiversity = incoming.settings.artistDiversity }
        if base.settings.genreMode != incoming.settings.genreMode { result.settings.genreMode = incoming.settings.genreMode }
        if base.settings.energy != incoming.settings.energy { result.settings.energy = incoming.settings.energy }
        if base.settings.vocals != incoming.settings.vocals { result.settings.vocals = incoming.settings.vocals }
        if base.settings.playlistSource != incoming.settings.playlistSource { result.settings.playlistSource = incoming.settings.playlistSource }
        if base.settings.includeLibrary != incoming.settings.includeLibrary { result.settings.includeLibrary = incoming.settings.includeLibrary }
        return result
    }
}
