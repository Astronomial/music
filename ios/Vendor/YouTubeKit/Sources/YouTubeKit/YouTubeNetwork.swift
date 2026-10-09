import Foundation

/// Forma's bounded, cookie-free transport; separate from artwork/catalog traffic.
public enum YouTubeNetwork {
    public static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 12
        configuration.timeoutIntervalForResource = 20
        configuration.httpCookieStorage = nil
        configuration.httpMaximumConnectionsPerHost = 4
        return URLSession(configuration: configuration)
    }()
}

actor PlayerScriptCache {
    private var cached: (URL, String)?
    private var generation = UUID()
    func script(at url: URL, session: URLSession) async throws -> String {
        if let cached, cached.0 == url { return cached.1 }
        let token = generation
        // Stay in the caller's task: cancelling a losing client also cancels its HTTP request.
        let (data, response) = try await session.data(from: url)
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
              data.count < 8 * 1024 * 1024, let script = String(data: data, encoding: .utf8), !script.isEmpty else { throw YouTubeKitError.extractError }
        guard generation == token else { throw CancellationError() }
        cached = (url, script)
        return script
    }
    func invalidate() {
        cached = nil; generation = UUID()
    }
}

/// Anonymous visitor/player context is reusable across public videos on the same session.
/// Never cache a video's availability, streaming data, account cookies or authorization.
actor AudioContextCache {
    struct Entry {
        let session: URLSession
        let configuration: Extraction.YtCfg
        let playerURL: URL?
        let expiresAt: Date
    }
    private var entries: [ObjectIdentifier: Entry] = [:]
    func cached(session: URLSession) -> Entry? {
        guard let entry = entries[ObjectIdentifier(session)], entry.expiresAt > Date() else { return nil }
        return entry
    }
    func store(configuration: Extraction.YtCfg, playerURL: URL?, session: URLSession) {
        entries = entries.filter { $0.value.expiresAt > Date() }
        if entries.count >= 8 { entries.removeAll() }
        entries[ObjectIdentifier(session)] = Entry(session: session, configuration: configuration, playerURL: playerURL, expiresAt: Date().addingTimeInterval(1200))
    }
    func invalidate(session: URLSession) { entries[ObjectIdentifier(session)] = nil }
}
