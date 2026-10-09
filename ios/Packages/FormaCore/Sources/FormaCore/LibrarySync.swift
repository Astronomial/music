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
        return (current.filter { !old.contains($0) || next.contains($0) } + incoming.filter { !old.contains($0) }).filter { seen.insert($0).inserted }
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
            // A concurrent local deletion wins over an incoming rename/addition.
            if before[id] != nil, playlists[id] == nil { continue }
            if let old = before[id], var actual = playlists[id] {
                if old.name != next.name { actual.name = next.name }
                actual.trackIDs = mergeIDs(current: actual.trackIDs, base: old.trackIDs, incoming: next.trackIDs)
                playlists[id] = actual
            } else { playlists[id] = next }
        }
        result.playlists = playlists.values.sorted { $0.id < $1.id }
        func key(_ e: ListeningEvent) -> String { "\(e.trackID)|\(e.kind.rawValue)|\((e.at.timeIntervalSince1970 * 1000).rounded())|\(e.seconds)|\(e.ratio)|\(e.mood ?? "")" }
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
        if incoming.settings.recommendationVersion >= 2 {
            if base.settings.explorationStyle != incoming.settings.explorationStyle { result.settings.explorationStyle = incoming.settings.explorationStyle }
            if base.settings.languagePreference != incoming.settings.languagePreference { result.settings.languagePreference = incoming.settings.languagePreference }
            if base.settings.skipSensitivity != incoming.settings.skipSensitivity { result.settings.skipSensitivity = incoming.settings.skipSensitivity }
            if base.settings.sessionInfluence != incoming.settings.sessionInfluence { result.settings.sessionInfluence = incoming.settings.sessionInfluence }
            result.settings.recommendationVersion = max(result.settings.recommendationVersion, incoming.settings.recommendationVersion)
        }
        return result
    }
    /// PC 1.7's wire format omits this optional local context. Restore it before
    /// merging a round trip, while respecting explicit shared-history deletion.
    public static func preservingLearning(in remote: Library, from local: Library) -> Library {
        var result = remote
        if remote.settings.recommendationVersion < 2 {
            result.settings.explorationStyle = local.settings.explorationStyle
            result.settings.languagePreference = local.settings.languagePreference
            result.settings.skipSensitivity = local.settings.skipSensitivity
            result.settings.sessionInfluence = local.settings.sessionInfluence
            result.settings.recommendationVersion = local.settings.recommendationVersion
        }
        for (id, old) in local.tracks where result.tracks[id] != nil {
            if result.tracks[id]?.directRelatedTo.isEmpty == true { result.tracks[id]?.directRelatedTo = old.directRelatedTo }
            if result.tracks[id]?.discoveryLanguages.isEmpty == true { result.tracks[id]?.discoveryLanguages = old.discoveryLanguages }
            if result.tracks[id]?.genre.isEmpty == true { result.tracks[id]?.genre = old.genre }
            if result.tracks[id]?.mood.isEmpty == true { result.tracks[id]?.mood = old.mood }
            if result.tracks[id]?.tags.isEmpty == true { result.tracks[id]?.tags = old.tags }
            if result.tracks[id]?.language.isEmpty == true { result.tracks[id]?.language = old.language }
        }
        func key(_ e: ListeningEvent) -> String { "\(e.trackID)|\(e.kind.rawValue)|\((e.at.timeIntervalSince1970 * 1000).rounded())|\(e.seconds)|\(e.ratio)|\(e.mood ?? "")" }
        let metadata = Dictionary(local.events.map { (key($0), $0) }, uniquingKeysWith: { a, _ in a })
        result.events = remote.events.map { event in
            let old = metadata[key(event)]
            return ListeningEvent(trackID: event.trackID, kind: event.kind, at: event.at, seconds: event.seconds, ratio: event.ratio, mood: event.mood, newArtist: event.newArtist ?? old?.newArtist, recommendation: event.recommendation ?? old?.recommendation, surface: event.surface ?? old?.surface)
        }
        let shared = local.events.filter { [.play, .listen, .skip, .error].contains($0.kind) }
        if !remote.events.isEmpty || shared.isEmpty {
            let ids = Set(result.events.map(key))
            result.events += local.events.filter { [.like, .playlistAdd].contains($0.kind) && !ids.contains(key($0)) }
            result.events = Array(result.events.sorted { $0.at < $1.at }.suffix(3000))
        }
        return result
    }
}
