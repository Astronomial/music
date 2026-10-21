import Foundation
import FormaCore

/// A separate metadata connection; it never queues behind stream extraction.
actor GenreCatalog {
    private let session: URLSession
    private var lastRequest = Date.distantPast
    private var cache: [String: GenreEvidence] = [:]
    private var releaseCache: [String: (Date, [GenreClassifier.Recording])] = [:]
    private var lastReleaseRequest = Date.distantPast
    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 4; config.timeoutIntervalForResource = 5
        config.waitsForConnectivity = false; config.allowsCellularAccess = true
        config.allowsConstrainedNetworkAccess = true; config.allowsExpensiveNetworkAccess = true
        config.httpMaximumConnectionsPerHost = 1
        session = URLSession(configuration: config)
    }
    private struct Response: Decodable { let results: [GenreClassifier.Recording] }
    private struct ArtistResponse: Decodable {
        struct Artist: Decodable { let artistName: String?; let artistId: Int? }
        let results: [Artist]
    }
    func releases(_ artist: String) async -> [GenreClassifier.Recording] {
        guard !artist.isEmpty, artist.count <= 200 else { return [] }
        let key = GenreClassifier.artistIdentity(artist)
        if let hit = releaseCache[key], Date().timeIntervalSince(hit.0) < 3600 { return hit.1 }
        guard Date().timeIntervalSince(lastReleaseRequest) >= 30 else { return [] }; lastReleaseRequest = Date()
        var rows: [GenreClassifier.Recording] = [], received = false
        for country in ["us", "ru"] {
            var components = URLComponents(string: "https://itunes.apple.com/search")!
            components.queryItems = [URLQueryItem(name: "term", value: artist), URLQueryItem(name: "entity", value: "musicArtist"), URLQueryItem(name: "limit", value: "5"), URLQueryItem(name: "country", value: country)]
            do {
                var request = URLRequest(url: components.url!); request.timeoutInterval = 3
                let (data, response) = try await session.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200, data.count < 1_000_000 else { continue }
                let artists = try JSONDecoder().decode(ArtistResponse.self, from: data).results
                guard let id = artists.first(where: { GenreClassifier.artistIdentity($0.artistName ?? "") == key && ($0.artistId ?? 0) > 0 })?.artistId else { continue }
                var lookup = URLComponents(string: "https://itunes.apple.com/lookup")!
                lookup.queryItems = [URLQueryItem(name: "id", value: String(id)), URLQueryItem(name: "entity", value: "song"), URLQueryItem(name: "sort", value: "recent"), URLQueryItem(name: "limit", value: "200"), URLQueryItem(name: "country", value: country)]
                var lookupRequest = URLRequest(url: lookup.url!); lookupRequest.timeoutInterval = 3
                let (songs, status) = try await session.data(for: lookupRequest)
                guard (status as? HTTPURLResponse)?.statusCode == 200, songs.count < 1_000_000 else { continue }
                rows += Array(try JSONDecoder().decode(Response.self, from: songs).results.prefix(201)); received = true
                if !ReleaseDiscovery.recent(rows, artist: artist).isEmpty { break }
            } catch { if Task.isCancelled { return [] } }
        }
        let result = ReleaseDiscovery.recent(rows, artist: artist)
        guard received else { return [] }
        if releaseCache.count >= 100 { releaseCache.removeAll(keepingCapacity: true) }
        releaseCache[key] = (Date(), result); return result
    }
    func lookup(_ track: Track) async -> GenreEvidence? {
        let key = GenreClassifier.artistIdentity(track.artist) + "|" + GenreClassifier.recordingIdentity(track.title) + "|" + String(Int(track.duration))
        if let cached = cache[key], Date().timeIntervalSince1970 * 1000 - cached.checkedAt < 86400000 { return cached }
        guard !GenreClassifier.artistIdentity(track.artist).isEmpty, !GenreClassifier.recordingIdentity(track.title).isEmpty else { return nil }
        var rows: [GenreClassifier.Recording] = [], received = false
        for country in ["us", "ru"] {
            let delay = max(0, 3 - Date().timeIntervalSince(lastRequest))
            do { if delay > 0 { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }; try Task.checkCancellation() } catch { return nil }
            lastRequest = Date()
            var components = URLComponents(string: "https://itunes.apple.com/search")!
            components.queryItems = [URLQueryItem(name: "term", value: track.artist + " " + track.title), URLQueryItem(name: "entity", value: "song"), URLQueryItem(name: "limit", value: "25"), URLQueryItem(name: "country", value: country)]
            do {
                let (data, response) = try await session.data(from: components.url!)
                guard let http = response as? HTTPURLResponse, http.statusCode == 200, data.count < 1_000_000 else { continue }
                rows += Array(try JSONDecoder().decode(Response.self, from: data).results.prefix(25)); received = true
                if !GenreClassifier.match(track, recordings: rows).values.isEmpty { break }
            } catch { if Task.isCancelled { return nil } }
        }
        guard received else { return nil }
        let result = GenreClassifier.match(track, recordings: rows)
        if cache.count >= 1000 { cache.removeAll(keepingCapacity: true) }
        cache[key] = result
        return result
    }
}
