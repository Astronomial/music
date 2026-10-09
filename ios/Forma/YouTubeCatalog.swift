import Foundation
import FormaCore
import YouTubeKit

protocol MusicCatalogProviding: Sendable {
    func search(_ query: String, genre: String?, mood: String?, hints: [String]) async throws -> [Track]
    func related(to track: Track) async throws -> [Track]
    func describe(videoID: String) async -> Track?
}
extension MusicCatalogProviding {
    func search(_ query: String) async throws -> [Track] { try await search(query, genre: nil, mood: nil, hints: []) }
    func search(_ query: String, hints: [String]) async throws -> [Track] { try await search(query, genre: nil, mood: nil, hints: hints) }
}

/// Anonymous public YouTube Music metadata. No official API key/subscription.
/// Unofficial renderer formats can change; the parser is isolated in FormaCore.
actor YouTubeCatalog: MusicCatalogProviding {
    private let session: URLSession
    private var version: (String, Date)?
    private var versionTask: Task<String, Error>?
    private var cache: [String: (Date, [Track])] = [:]
    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 12
        configuration.timeoutIntervalForResource = 20
        configuration.httpMaximumConnectionsPerHost = 3
        configuration.httpCookieStorage = nil
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
    func related(to track: Track) async throws -> [Track] {
        guard VideoID.isValid(track.id) else { return [] }
        let data = try await request("next", body: ["videoId": track.id, "playlistId": "RDAMVM\(track.id)", "isAudioOnly": true, "enablePersistentPlaylistPanel": true])
        return try CatalogParser.tracks(from: data).filter { $0.id != track.id }.map { t in
            var related = t; related.relatedTo = [track.id]; related.directRelatedTo = [track.id]; return related
        }
    }
    nonisolated func describe(videoID: String) async -> Track? {
        guard VideoID.isValid(videoID), !Task.isCancelled else { return nil }
        let video = YouTube(videoID: videoID, useOAuth: false, allowOAuthCache: false, methods: [.local])
        guard let metadata = try? await video.metadata, !metadata.title.isEmpty, !Task.isCancelled else { return nil }
        return Track(videoID: videoID, title: metadata.title, artist: "Исполнитель не указан", artworkURL: metadata.thumbnail?.url)
    }
    private func clientVersion() async throws -> String {
        if let cached = version, Date().timeIntervalSince(cached.1) < 1800 { return cached.0 }
        if let versionTask { return try await versionTask.value }
        let task = Task { try await self.loadVersion() }; versionTask = task
        defer { versionTask = nil }
        let value = try await task.value; version = (value, Date()); return value
    }
    private func loadVersion() async throws -> String {
        let data = try await get(URL(string: "https://music.youtube.com/")!)
        let html = String(decoding: data, as: UTF8.self)
        let regex = try NSRegularExpression(pattern: #""INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)""#)
        guard let match = regex.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)), let range = Range(match.range(at: 1), in: html) else { throw CatalogError.configuration }
        return String(html[range])
    }
    private func request(_ route: String, body: [String: Any]) async throws -> Data {
        var payload = body
        payload["context"] = ["client": ["clientName": "WEB_REMIX", "clientVersion": try await clientVersion(), "hl": "ru", "gl": "RU"]]
        var request = URLRequest(url: URL(string: "https://music.youtube.com/youtubei/v1/\(route)?prettyPrint=false")!)
        request.httpMethod = "POST"; request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("https://music.youtube.com", forHTTPHeaderField: "Origin")
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
