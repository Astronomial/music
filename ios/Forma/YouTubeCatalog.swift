import Foundation
import FormaCore
import YouTubeKit

protocol MusicCatalogProviding: Sendable {
    func discoveryPage(_ request: DiscoveryRequest) async throws -> DiscoveryPage
    func search(_ query: String, genre: String?, mood: String?, hints: [String]) async throws -> [Track]
    func orderedSearch(_ query: String, recent: Bool) async throws -> [Track]
    func artistTracks(_ track: Track) async throws -> [Track]
    func related(to track: Track) async throws -> [Track]
    func neighbours(to track: Track) async throws -> [Track]
    func describe(videoID: String) async -> Track?
}
extension MusicCatalogProviding {
    func neighbours(to track: Track) async throws -> [Track] { [] }
    func discoveryPage(_ request: DiscoveryRequest) async throws -> DiscoveryPage {
        switch request.kind {
        case .related: return DiscoveryPage(tracks: try await related(to: request.seed))
        case .artist: return DiscoveryPage(tracks: try await artistTracks(request.seed))
        case .search: return DiscoveryPage(tracks: try await search(request.query))
        case .releases: return DiscoveryPage(tracks: try await orderedSearch(request.seed.artist, recent: true))
        }
    }
    func orderedSearch(_ query: String, recent: Bool) async throws -> [Track] { try await search(query) }
    func artistTracks(_ track: Track) async throws -> [Track] { try await search(track.artist) }
    func search(_ query: String) async throws -> [Track] { try await search(query, genre: nil, mood: nil, hints: []) }
    func search(_ query: String, hints: [String]) async throws -> [Track] { try await search(query, genre: nil, mood: nil, hints: hints) }
}

/// Anonymous public YouTube Music metadata. No official API key/subscription.
/// Unofficial renderer formats can change; the parser is isolated in FormaCore.
actor YouTubeCatalog: MusicCatalogProviding {
    private let releaseCatalog = GenreCatalog()
    private let neighbourCatalog = SimilarArtistStore { url in
        var request = URLRequest(url: url); request.timeoutInterval = 15
        request.setValue("Forma/1.20 (https://github.com/Astronomial/music)", forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await BoundedHTTPData(limit: 2 * 1024 * 1024).load(request)
    }
    private let session: URLSession
    private var versions: [Bool: (String, Date)] = [:]
    private var versionTasks: [Bool: Task<String, Error>] = [:]
    private var cache: [String: (Date, [Track])] = [:]
    private var neighbourOffsets: [String: Int] = [:]
    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 12
        configuration.timeoutIntervalForResource = 20
        configuration.httpMaximumConnectionsPerHost = 3
        configuration.httpCookieStorage = nil
        configuration.allowsCellularAccess = true; configuration.allowsExpensiveNetworkAccess = true; configuration.allowsConstrainedNetworkAccess = true
        session = URLSession(configuration: configuration)
    }
    func search(_ query: String, genre: String? = nil, mood: String? = nil, hints: [String] = []) async throws -> [Track] {
        let query = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        guard !query.isEmpty else { return [] }
        let key = "\(query)|\(genre ?? "")|\(mood ?? "")|\(hints.joined(separator: ","))"
        if let hit = cache[key], Date().timeIntervalSince(hit.0) < 300 { return hit.1 }
        let data = try await request("search", body: ["query": query, "params": "EgWKAQIIAQ%3D%3D"])
        var tracks = try await Task.detached(priority: .userInitiated) { try CatalogParser.tracks(from: data) }.value
        for index in tracks.indices {
            // Search context is weak evidence, not an analysed genre or emotion.
            tracks[index].genres = genre.map { [$0] } ?? []
            tracks[index].moodHints = (mood.map { [$0] } ?? []) + hints
            tracks[index].discoveryLanguages = hints.contains("discovery:ru") ? ["ru"] : hints.contains("discovery:en") ? ["en"] : []
        }
        if cache.count >= 40 { cache.removeAll() }
        cache[key] = (Date(), tracks)
        return tracks
    }
    func orderedSearch(_ query: String, recent: Bool) async throws -> [Track] {
        let query = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        guard !query.isEmpty else { return [] }
        let key = "ordered:\(recent):\(query)"
        if let hit = cache[key], Date().timeIntervalSince(hit.0) < 300 { return hit.1 }
        let data = try await request("search", body: ["query": query, "params": recent ? "EgQIBBAB" : "CAMSAhAB"], web: true)
        let tracks = try await Task.detached(priority: .userInitiated) { try CatalogParser.tracks(from: data, recentFirst: recent) }.value
        if cache.count >= 40 { cache.removeAll() }; cache[key] = (Date(), tracks)
        return tracks
    }
    func artistTracks(_ track: Track) async throws -> [Track] {
        if let id = track.artistID, id.hasPrefix("UC"), id.count <= 82,
           let data = try? await request("browse", body: ["browseId": id]) {
            let tracks = try CatalogParser.tracks(from: data)
            if !tracks.isEmpty { return tracks }
        }
        return try await orderedSearch(track.artist, recent: false).filter { PulseEngine.fold($0.artist) == PulseEngine.fold(track.artist) || (track.artistID != nil && $0.artistID == track.artistID) }
    }
    func related(to track: Track) async throws -> [Track] {
        guard VideoID.isValid(track.id) else { return [] }
        let data = try await request("next", body: ["videoId": track.id, "playlistId": "RDAMVM\(track.id)", "isAudioOnly": true, "enablePersistentPlaylistPanel": true])
        return try CatalogParser.tracks(from: data).filter { $0.id != track.id }.map { t in
            var related = t; related.relatedTo = [track.id]; related.directRelatedTo = [track.id]; return related
        }
    }
    func neighbours(to seed: Track) async throws -> [Track] {
        // Cold optional lookup only warms a separate actor cache. No metadata
        // server is awaited by playback, ordinary discovery or manual search.
        let names = await neighbourCatalog.cached(seed.artist)
        let key = GenreClassifier.artistIdentity(seed.artist)
        let window = CollaborativeDiscovery.window(names, offset: neighbourOffsets[key, default: 0])
        if !names.isEmpty {
            if neighbourOffsets.count >= 64 { neighbourOffsets.removeAll(keepingCapacity: true) }
            neighbourOffsets[key] = (neighbourOffsets[key, default: 0] + window.count) % names.count
        }
        var result: [Track] = [], seen = Set<String>()
        for artist in window {
            try Task.checkCancellation()
            guard let tracks = try? await search(artist.name) else { continue }
            for var track in tracks.filter({ GenreClassifier.artistIdentity($0.artist) == GenreClassifier.artistIdentity(artist.name) }).prefix(12) where seen.insert(track.id).inserted {
                track.relatedTo = Array(Set(track.relatedTo + [seed.id]))
                track.retrievalSources = Array(Set(track.retrievalSources + ["listenbrainz-neighbour"]))
                result.append(track)
            }
        }
        return result
    }
    func discoveryPage(_ intent: DiscoveryRequest) async throws -> DiscoveryPage {
        if intent.kind == .releases {
            let rows = await releaseCatalog.releases(intent.seed.artist)
            let tracks = await withTaskGroup(of: [Track].self) { group in
                for row in rows.prefix(2) {
                    guard let artist = row.artistName, let title = row.trackName else { continue }
                    group.addTask {
                        guard let results = try? await self.search(artist + " " + title) else { return [] }
                        for var track in results {
                            let evidence = GenreClassifier.match(track, recordings: rows)
                            if evidence.releasedAt != nil, !evidence.recordingId.isEmpty { track.genreEvidence = evidence; track.retrievalSources = intent.roots.contains(intent.seed.id) ? ["release-catalog"] : ["release-catalog", "artist-neighbour"]; track.relatedTo = intent.roots; return [track] }
                        }
                        return []
                    }
                }
                var result: [Track] = []; for await batch in group { result += batch }; return result
            }
            if !tracks.isEmpty { return DiscoveryPage(tracks: tracks) }
            let fallback = try await orderedSearch(intent.seed.artist, recent: true)
            return DiscoveryPage(tracks: fallback.filter { ReleaseDiscovery.songPublication($0, artist: intent.seed.artist) }.map { var track = $0; track.retrievalSources = ["recent-upload"]; return track })
        }
        var body: [String: Any] = [:]
        let route: String
        let web: Bool
        if let cursor = intent.continuation {
            guard !cursor.isEmpty, cursor.count <= 20000 else { throw CatalogError.configuration }
            route = intent.kind == .related ? "next" : "search"; web = intent.kind == .artist
            body["continuation"] = cursor
        } else {
            switch intent.kind {
            case .related:
                route = "next"; web = false
                body = ["videoId": intent.seed.id, "playlistId": "RDAMVM\(intent.seed.id)", "isAudioOnly": true, "enablePersistentPlaylistPanel": true]
            case .artist:
                route = "search"; web = true
                body = ["query": intent.seed.artist, "params": "CAMSAhAB"]
            case .search:
                route = "search"; web = false
                body = ["query": String(intent.query.prefix(200)), "params": "EgWKAQIIAQ%3D%3D"]
            case .releases: throw CatalogError.configuration
            }
        }
        let data = try await request(route, body: body, web: web)
        let page = try await Task.detached(priority: .utility) { DiscoveryPage(tracks: try CatalogParser.tracks(from: data), continuation: try CatalogContinuation.token(from: data)) }.value
        return DiscoveryPage(tracks: page.tracks.filter { $0.id != intent.seed.id }.map { old in
            var track = old
            if intent.kind == .related { track.relatedTo = Array(Set(track.relatedTo + intent.roots + [intent.seed.id])); track.directRelatedTo = Array(Set(track.directRelatedTo + [intent.seed.id])) }
            track.retrievalSources = intent.kind == .related ? ["related"] : intent.mood != nil && intent.roots.isEmpty ? ["mood-reference"] : ["artist"]
            return track
        }, continuation: page.continuation)
    }
    nonisolated func describe(videoID: String) async -> Track? {
        guard VideoID.isValid(videoID), !Task.isCancelled else { return nil }
        let video = YouTube(videoID: videoID, useOAuth: false, allowOAuthCache: false, methods: [.local])
        guard let metadata = try? await video.metadata, !metadata.title.isEmpty, !Task.isCancelled else { return nil }
        return Track(videoID: videoID, title: metadata.title, artist: "Исполнитель не указан", artworkURL: metadata.thumbnail?.url)
    }
    private func clientVersion(web: Bool = false) async throws -> String {
        if let cached = versions[web], Date().timeIntervalSince(cached.1) < 1800 { return cached.0 }
        if let task = versionTasks[web] { return try await task.value }
        let task = Task { try await self.loadVersion(web: web) }; versionTasks[web] = task
        defer { versionTasks[web] = nil }
        let value = try await task.value; versions[web] = (value, Date()); return value
    }
    private func loadVersion(web: Bool) async throws -> String {
        let data = try await get(URL(string: web ? "https://www.youtube.com/" : "https://music.youtube.com/")!)
        let html = String(decoding: data, as: UTF8.self)
        let regex = try NSRegularExpression(pattern: #""INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)""#)
        guard let match = regex.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)), let range = Range(match.range(at: 1), in: html) else { throw CatalogError.configuration }
        return String(html[range])
    }
    private func request(_ route: String, body: [String: Any], web: Bool = false) async throws -> Data {
        let origin = web ? "https://www.youtube.com" : "https://music.youtube.com"
        var payload = body
        payload["context"] = ["client": ["clientName": web ? "WEB" : "WEB_REMIX", "clientVersion": try await clientVersion(web: web), "hl": "ru", "gl": "RU"]]
        var request = URLRequest(url: URL(string: "\(origin)/youtubei/v1/\(route)?prettyPrint=false")!)
        request.httpMethod = "POST"; request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        return try await fetch(request)
    }
    private func get(_ url: URL) async throws -> Data { try await fetch(URLRequest(url: url)) }
    private func fetch(_ original: URLRequest) async throws -> Data {
        var request = original
        request.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw CatalogError.unavailable }
        guard data.count <= 8 * 1024 * 1024 else { throw CatalogError.tooLarge }
        return data
    }
    enum CatalogError: LocalizedError {
        case configuration, unavailable, tooLarge
        var errorDescription: String? {
            switch self {
            case .configuration: return "YouTube изменил ответ каталога или запросил проверку. Можно попробовать прямую ссылку на трек."
            case .unavailable: return "YouTube не ответил. Проверь подключение и доступность сервиса."
            case .tooLarge: return "Сервис вернул слишком большой ответ."
            }
        }
    }
}
