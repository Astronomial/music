import Foundation

public enum TrackPulse {
    public static func family(_ track: Track) -> String {
        var title = PulseEngine.fold(track.title.replacingOccurrences(of: #"\([^)]*\)|\[[^\]]*\]"#, with: " ", options: .regularExpression))
        let artist = PulseEngine.fold(track.artist).replacingOccurrences(of: #" topic$"#, with: "", options: .regularExpression)
        if !artist.isEmpty, title.hasPrefix(artist + " ") { title = String(title.dropFirst(artist.count + 1)) }
        return title.replacingOccurrences(of: #"(?:^| )(?:remix|ремикс|cover|кавер|sped|slowed|nightcore|acoustic|акустика|live|official|lyrics|audio|video|visualizer)(?: |$).*$"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }
    public static func sameSong(_ a: Track, _ b: Track) -> Bool { a.id == b.id || (!family(a).isEmpty && family(a) == family(b)) }
    public static func fit(_ track: Track, seed: Track) -> Double {
        guard !sameSong(track, seed) else { return 0 }
        let direct = track.directRelatedTo.contains(seed.id) ? 0.9 : track.relatedTo.contains(seed.id) ? 0.48 : 0
        let sound = SoundProfile.similarity(track.soundProfile, seed.soundProfile).map { max(0, ($0 - 0.55) / 0.45) } ?? 0
        let genres = Set((track.genres + [track.genre]).filter { !$0.isEmpty }.map(PulseEngine.fold))
        let seedGenres = Set((seed.genres + [seed.genre]).filter { !$0.isEmpty }.map(PulseEngine.fold))
        let genre = genres.isDisjoint(with: seedGenres) ? 0.0 : 0.3
        let mood = !track.mood.isEmpty && track.mood == seed.mood ? 0.15 : 0
        let tags = Set(track.tags).isDisjoint(with: Set(seed.tags)) ? 0.0 : 0.12
        return max(direct, max(sound, genre + mood + tags))
    }
    public static func profile(_ library: Library, seed: Track) -> Library {
        var result = library
        result.likedIDs = [seed.id]; result.playlists = []; result.settings.genres = []; result.settings.playlistSource = "all"
        result.events = library.events.filter { $0.trackID == seed.id || library.tracks[$0.trackID]?.relatedTo.contains(seed.id) == true }
        return result
    }
}
