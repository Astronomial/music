import Foundation

/// Independent public API adapter. Co-listening is one candidate source, not
/// proof of genre, mood, user preference or a direct recording-to-recording edge.
public enum CollaborativeDiscovery {
    public struct Artist: Sendable, Equatable { public let mbid: String; public let name: String }
    private struct Search: Decodable {
        struct Entry: Decodable {
            struct Alias: Decodable { let name: String }
            let id: String; let name: String; let aliases: [Alias]?
        }
        let artists: [Entry]
    }
    private struct Row: Decodable {
        let recording_mbid: String; let similar_artist_mbid: String; let similar_artist_name: String; let total_listen_count: Double
    }
    private static func valid(_ id: String) -> Bool { id.range(of: #"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$"#, options: .regularExpression) != nil }
    public static func artistID(_ data: Data, name: String) throws -> String? {
        let entries = try JSONDecoder().decode(Search.self, from: data).artists
        guard entries.allSatisfy({ valid($0.id) }) else { throw Failure.invalidResponse }
        let key = GenreClassifier.artistIdentity(name)
        let matches = Set(entries.filter { ([ $0.name ] + ($0.aliases ?? []).map(\.name)).contains { GenreClassifier.artistIdentity($0) == key } }.map { $0.id.lowercased() })
        return matches.count == 1 ? matches.first : nil
    }
    public static func artists(_ data: Data, excluding seed: String) throws -> [Artist] {
        let pool = try JSONDecoder().decode([String: [Row]].self, from: data)
        var result: [Artist] = [], seen = Set<String>()
        // Deterministic ordering must not turn listen counts into relevance scores.
        for id in pool.keys.sorted() {
            guard valid(id), let rows = pool[id], rows.allSatisfy({ valid($0.recording_mbid) && $0.similar_artist_mbid.lowercased() == id.lowercased() && $0.total_listen_count.isFinite && $0.total_listen_count >= 0 }) else { throw Failure.invalidResponse }
            guard id.lowercased() != seed.lowercased(), let first = rows.first else { continue }
            let name = first.similar_artist_name.trimmingCharacters(in: .whitespacesAndNewlines), key = GenreClassifier.artistIdentity(name)
            guard !key.isEmpty, name.count <= 160, rows.allSatisfy({ GenreClassifier.artistIdentity($0.similar_artist_name) == key }), seen.insert(key).inserted else { continue }
            result.append(Artist(mbid: id.lowercased(), name: name))
        }
        return Array(result.prefix(8))
    }
    public static func matches(_ track: Track, seed: Track) -> Bool {
        let audio = SemanticAudioProfile.similarity(track.soundProfile?.semantic, seed.soundProfile?.semantic)
        if let audio, audio < 0.65 { return false }
        if !GenreClassifier.genres(track).isEmpty, !GenreClassifier.genres(seed).isEmpty { return GenreClassifier.relation(track, seed) > 0 }
        return (audio ?? 0) >= 0.85
    }
    public enum Failure: Error { case invalidResponse }
}

/// A cold read starts optional work and returns immediately. A separate actor
/// and network session keep catalogue enrichment out of the playback path.
public actor SimilarArtistStore {
    public typealias Fetch = @Sendable (URL) async throws -> Data
    private let fetch: Fetch
    private let clock: @Sendable () -> Date
    private var cache: [String: (Date, [CollaborativeDiscovery.Artist])] = [:]
    private var tasks: [String: Task<[CollaborativeDiscovery.Artist], Never>] = [:]
    private var lastProbe = Date.distantPast
    public init(fetch: @escaping Fetch, clock: @escaping @Sendable () -> Date = { Date() }) { self.fetch = fetch; self.clock = clock }
    public func cached(_ name: String) -> [CollaborativeDiscovery.Artist] {
        guard !name.isEmpty, name.count <= 160 else { return [] }
        let key = GenreClassifier.artistIdentity(name)
        if let hit = cache[key], hit.0 > clock() { return hit.1 }
        Task { await self.prefetch(name) }; return []
    }
    public func prefetch(_ name: String) async -> [CollaborativeDiscovery.Artist] {
        let key = GenreClassifier.artistIdentity(name)
        guard !key.isEmpty, name.count <= 160 else { return [] }
        if let hit = cache[key], hit.0 > clock() { return hit.1 }
        if let work = tasks[key] { return await work.value }
        guard tasks.isEmpty, clock().timeIntervalSince(lastProbe) >= 30 else { return [] }
        lastProbe = clock()
        let work = Task { await self.load(name) }; tasks[key] = work
        let names = await work.value; tasks[key] = nil; return names
    }
    private func load(_ name: String) async -> [CollaborativeDiscovery.Artist] {
        let key = GenreClassifier.artistIdentity(name)
        var names: [CollaborativeDiscovery.Artist] = [], ttl: TimeInterval = 600
        do {
            var search = URLComponents(string: "https://musicbrainz.org/ws/2/artist/")!
            let literal = name.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
            search.queryItems = [.init(name: "query", value: "artist:\"" + literal + "\""), .init(name: "fmt", value: "json"), .init(name: "limit", value: "100")]
            let data = try await fetch(search.url!)
            guard data.count <= 2 * 1024 * 1024 else { throw CollaborativeDiscovery.Failure.invalidResponse }
            if let id = try CollaborativeDiscovery.artistID(data, name: name) {
                var radio = URLComponents(string: "https://api.listenbrainz.org/1/lb-radio/artist/" + id)!
                radio.queryItems = [.init(name: "mode", value: "easy"), .init(name: "max_similar_artists", value: "8"), .init(name: "max_recordings_per_artist", value: "5"), .init(name: "pop_begin", value: "0"), .init(name: "pop_end", value: "100")]
                let rows = try await fetch(radio.url!)
                guard rows.count <= 2 * 1024 * 1024 else { throw CollaborativeDiscovery.Failure.invalidResponse }
                names = try CollaborativeDiscovery.artists(rows, excluding: id).filter { GenreClassifier.artistIdentity($0.name) != key }
                ttl = names.isEmpty ? 86400 : 7 * 86400
            } else { ttl = 86400 }
        } catch { /* Failure is optional and cannot reject playback. Retry later. */ }
        if cache.count >= 64 { cache = cache.filter { $0.value.0 > clock() }; if cache.count >= 64, let first = cache.keys.sorted().first { cache[first] = nil } }
        cache[key] = (clock().addingTimeInterval(ttl), names); return names
    }
}
