import Foundation

/// Normalize disk/PC metadata before it reaches SwiftUI controls or the learner.
/// Limits match the portable PC protocol; local learning fields remain intact.
public enum LibraryValidation {
    public static func normalized(_ source: Library) -> Library {
        var result = source
        func strings(_ values: [String], limit: Int = 40) -> [String] {
            var seen = Set<String>()
            return Array(values.map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200)) }
                .filter { !$0.isEmpty && seen.insert($0).inserted }.prefix(limit))
        }
        func ids(_ values: [String]) -> [String] { strings(values, limit: 3000).filter(VideoID.isValid) }
        result.tracks = source.tracks.filter { VideoID.isValid($0.key) && $0.key == $0.value.id }.mapValues { old in
            var track = old
            track.title = String(old.title.prefix(200)); track.artist = String(old.artist.prefix(200))
            track.duration = old.duration.isFinite ? min(86400, max(0, old.duration)) : 0
            track.genres = strings(old.genres); track.moodHints = strings(old.moodHints, limit: 40)
            track.relatedTo = Array(ids(old.relatedTo).prefix(100)); track.directRelatedTo = Array(ids(old.directRelatedTo).prefix(100))
            track.discoveryLanguages = strings(old.discoveryLanguages, limit: 10); track.tags = strings(old.tags)
            if let url = old.artworkURL, url.scheme != "https" || url.absoluteString.count > 2000 { track.artworkURL = nil }
            return track
        }
        result.likedIDs = ids(source.likedIDs); result.hiddenIDs = ids(source.hiddenIDs)
        var playlists: [Playlist] = [], positions: [String: Int] = [:]
        for playlist in source.playlists.prefix(300) where !playlist.id.isEmpty {
            if let index = positions[playlist.id] { playlists[index].trackIDs = ids(playlists[index].trackIDs + playlist.trackIDs) }
            else {
                positions[playlist.id] = playlists.count
                playlists.append(Playlist(id: playlist.id, name: String(playlist.name.prefix(100)), trackIDs: ids(playlist.trackIDs)))
            }
        }
        result.playlists = playlists
        result.events = source.events.suffix(3000).filter {
            VideoID.isValid($0.trackID) && $0.at.timeIntervalSince1970.isFinite && (-62135596800...253402300799).contains($0.at.timeIntervalSince1970)
        }.map { event in
            ListeningEvent(trackID: event.trackID, kind: event.kind, at: event.at, seconds: event.seconds, ratio: event.ratio, mood: event.mood,
                newArtist: event.newArtist, recommendation: event.recommendation?.isValid == true ? event.recommendation : nil, surface: event.surface)
        }.sorted { $0.at < $1.at }
        var settings = source.settings
        func bounded(_ value: Double, maximum: Double = 1, fallback: Double) -> Double { value.isFinite ? min(maximum, max(0, value)) : fallback }
        settings.discovery = bounded(settings.discovery, fallback: 0.7); settings.artistDiversity = bounded(settings.artistDiversity, fallback: 0.6)
        settings.sessionInfluence = bounded(settings.sessionInfluence, fallback: 0.65); settings.repeatHours = bounded(settings.repeatHours, maximum: 24, fallback: 2)
        settings.genres = strings(settings.genres); settings.excludedGenres = strings(settings.excludedGenres)
        settings.preferredArtists = strings(settings.preferredArtists); settings.excludedArtists = strings(settings.excludedArtists)
        settings.seedPlaylistIDs = strings(settings.seedPlaylistIDs, limit: 300)
        if !(["any"] + MoodMix.all.map(\.id)).contains(settings.mood) { settings.mood = "any" }
        if !["any", "low", "medium", "high"].contains(settings.energy) { settings.energy = "any" }
        if !["any", "vocal", "instrumental"].contains(settings.vocals) { settings.vocals = "any" }
        if !["ru", "en", "any"].contains(settings.languagePreference) { settings.languagePreference = "ru" }
        if !["nearby", "balanced", "adventurous"].contains(settings.explorationStyle) { settings.explorationStyle = "nearby" }
        if !["strict", "soft"].contains(settings.skipSensitivity) { settings.skipSensitivity = "strict" }
        if !["strict", "prefer"].contains(settings.genreMode) { settings.genreMode = "prefer" }
        if !["selected", "all"].contains(settings.playlistSource) { settings.playlistSource = "all" }
        result.settings = settings
        return result
    }
}
