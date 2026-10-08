import Foundation

public struct Track: Codable, Hashable, Identifiable, Sendable {
    public var id: String { videoID }
    public let videoID: String
    public var title: String
    public var artist: String
    public var duration: Double
    public var artworkURL: URL?
    public var genres: [String]
    public var moodHints: [String]
    public var relatedTo: [String]

    public init(videoID: String, title: String, artist: String, duration: Double = 0,
                artworkURL: URL? = nil, genres: [String] = [], moodHints: [String] = [], relatedTo: [String] = []) {
        self.videoID = videoID; self.title = title; self.artist = artist
        self.duration = duration; self.artworkURL = artworkURL
        self.genres = genres; self.moodHints = moodHints; self.relatedTo = relatedTo
    }
}

public enum FeedbackKind: String, Codable, Sendable { case play, listen, skip, error }
public struct ListeningEvent: Codable, Sendable {
    public let trackID: String
    public let kind: FeedbackKind
    public let at: Date
    public let seconds: Double
    public let ratio: Double
    public let mood: String?
    public let newArtist: Bool?
    public init(trackID: String, kind: FeedbackKind, at: Date = Date(), seconds: Double, ratio: Double, mood: String? = nil, newArtist: Bool? = nil) {
        self.newArtist = newArtist
        self.trackID = trackID; self.kind = kind; self.at = at
        self.seconds = seconds; self.ratio = min(1, max(0, ratio)); self.mood = mood
    }
    public var reward: Double? {
        guard seconds >= 3 else { return nil }
        if kind == .listen { return ratio >= 0.8 ? 1 : ratio >= 0.5 ? 0.7 : nil }
        if kind == .skip { return seconds < 30 && ratio < 0.25 ? 0 : ratio < 0.65 ? 0.25 : nil }
        return nil
    }
}

public struct Playlist: Codable, Identifiable, Sendable {
    public let id: String
    public var name: String
    public var trackIDs: [String]
    public init(id: String = UUID().uuidString, name: String, trackIDs: [String]) {
        self.id = id; self.name = name; self.trackIDs = trackIDs
    }
}
public struct PulseSettings: Codable, Sendable {
    public var genres: [String] = ["Electronic", "Rock", "Hip-Hop/Rap"]
    public var excludedArtists: [String] = []
    public var excludedGenres: [String] = []
    public var preferredArtists: [String] = []
    public var seedPlaylistIDs: [String] = []
    public var discovery: Double = 0.35
    public var repeatHours: Double = 2
    public var artistDiversity: Double = 0.6
    public var mood: String = "any"
    public var genreMode: String = "prefer"
    public var energy: String = "any"
    public var vocals: String = "any"
    public var playlistSource: String = "all"
    public var includeLibrary: Bool = true
    public init() {}
    private enum CodingKeys: String, CodingKey { case genres, excludedArtists, excludedGenres, preferredArtists, seedPlaylistIDs, discovery, repeatHours, artistDiversity, mood, genreMode, energy, vocals, playlistSource, includeLibrary }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        genres = try c.decodeIfPresent([String].self, forKey: .genres) ?? ["Electronic", "Rock", "Hip-Hop/Rap"]
        excludedArtists = try c.decodeIfPresent([String].self, forKey: .excludedArtists) ?? []
        excludedGenres = try c.decodeIfPresent([String].self, forKey: .excludedGenres) ?? []
        preferredArtists = try c.decodeIfPresent([String].self, forKey: .preferredArtists) ?? []
        seedPlaylistIDs = try c.decodeIfPresent([String].self, forKey: .seedPlaylistIDs) ?? []
        discovery = try c.decodeIfPresent(Double.self, forKey: .discovery) ?? 0.35
        repeatHours = try c.decodeIfPresent(Double.self, forKey: .repeatHours) ?? 2
        artistDiversity = try c.decodeIfPresent(Double.self, forKey: .artistDiversity) ?? 0.6
        mood = try c.decodeIfPresent(String.self, forKey: .mood) ?? "any"
        genreMode = try c.decodeIfPresent(String.self, forKey: .genreMode) ?? "prefer"
        energy = try c.decodeIfPresent(String.self, forKey: .energy) ?? "any"
        vocals = try c.decodeIfPresent(String.self, forKey: .vocals) ?? "any"
        playlistSource = try c.decodeIfPresent(String.self, forKey: .playlistSource) ?? "all"
        includeLibrary = try c.decodeIfPresent(Bool.self, forKey: .includeLibrary) ?? true
    }
}
public struct Library: Codable, Sendable {
    public var version = 1
    public var tracks: [String: Track] = [:]
    public var likedIDs: [String] = []
    public var hiddenIDs: [String] = []
    public var playlists: [Playlist] = []
    public var events: [ListeningEvent] = []
    public var settings = PulseSettings()
    public init() {}
    private enum CodingKeys: String, CodingKey { case version, tracks, likedIDs, hiddenIDs, playlists, events, settings }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version)
        tracks = try c.decode([String: Track].self, forKey: .tracks)
        likedIDs = try c.decode([String].self, forKey: .likedIDs)
        hiddenIDs = try c.decodeIfPresent([String].self, forKey: .hiddenIDs) ?? []
        playlists = try c.decode([Playlist].self, forKey: .playlists)
        events = try c.decode([ListeningEvent].self, forKey: .events)
        settings = try c.decode(PulseSettings.self, forKey: .settings)
    }
    public mutating func merge(_ incoming: [Track]) {
        for var track in incoming {
            if let old = tracks[track.id] {
                track.genres = Array(Set(old.genres + track.genres)).sorted()
                track.moodHints = Array(Set(old.moodHints + track.moodHints)).sorted()
                track.relatedTo = Array(Set(old.relatedTo + track.relatedTo)).sorted()
            }
            tracks[track.id] = track
        }
    }
    public mutating func record(_ event: ListeningEvent) {
        events.append(event)
        events = Array(events.suffix(3000))
    }
}

public enum VideoID {
    public static func isValid(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil
    }
    public static func parse(_ input: String) -> String? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if isValid(text) { return text }
        guard let url = URLComponents(string: text), url.scheme == "https", url.user == nil,
              url.password == nil, url.port == nil, let host = url.host?.lowercased() else { return nil }
        let parts = url.path.split(separator: "/").map(String.init)
        let candidate: String?
        if host == "youtu.be", parts.count == 1 { candidate = parts[0] }
        else if ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].contains(host) {
            if url.path == "/watch" { candidate = url.queryItems?.first(where: { $0.name == "v" })?.value }
            else if parts.count == 2, ["shorts", "live", "embed"].contains(parts[0]) { candidate = parts[1] }
            else { candidate = nil }
        } else { candidate = nil }
        return candidate.flatMap { isValid($0) ? $0 : nil }
    }
}

/// Only active playback time trains taste. Seek position is deliberately absent.
public struct ConsumptionClock {
    public private(set) var seconds: Double = 0
    private var previous: TimeInterval?
    public init() {}
    public mutating func tick(at monotonicTime: TimeInterval, playing: Bool, seeking: Bool = false) {
        defer { previous = monotonicTime }
        guard let old = previous, playing, !seeking else { return }
        seconds += min(2, max(0, monotonicTime - old))
    }
    public mutating func reset() { seconds = 0; previous = nil }
}
