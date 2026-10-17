import Foundation
import FormaCore

/// A separate metadata connection; it never queues behind stream extraction.
actor GenreCatalog {
    private let session: URLSession
    private var lastRequest = Date.distantPast
    private var cache: [String: GenreEvidence] = [:]
    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 4; config.timeoutIntervalForResource = 5
        config.waitsForConnectivity = false; config.allowsCellularAccess = true
        config.allowsConstrainedNetworkAccess = true; config.allowsExpensiveNetworkAccess = true
        config.httpMaximumConnectionsPerHost = 1
        session = URLSession(configuration: config)
    }
    private struct Response: Decodable { let results: [GenreClassifier.Recording] }
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
