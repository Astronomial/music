import Foundation

public struct ResolvedAudio: Sendable {
    public let url: URL
    public let expiresAt: Date
    public let resolvedAt: Date
    public let title: String?
    public let artworkURL: URL?
    public init(url: URL, resolvedAt: Date = Date(), title: String? = nil, artworkURL: URL? = nil) throws {
        guard url.scheme == "https", url.user == nil, url.password == nil, url.port == nil,
              let host = url.host?.lowercased(), host == "googlevideo.com" || host.hasSuffix(".googlevideo.com") else {
            throw StreamError.invalidHost
        }
        self.url = url; self.resolvedAt = resolvedAt; self.title = title; self.artworkURL = artworkURL
        let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "expire" })?.value
        // Short cache even when YouTube gives a long-lived URL; IP/network may change.
        let upstream = raw.flatMap(Double.init).map(Date.init(timeIntervalSince1970:)) ?? resolvedAt.addingTimeInterval(300)
        expiresAt = min(upstream, resolvedAt.addingTimeInterval(300))
    }
    public func isFresh(at now: Date = Date()) -> Bool { expiresAt.timeIntervalSince(now) > 60 }
    public enum StreamError: Error { case invalidHost }
}
public protocol StreamResolving: Sendable {
    func resolve(videoID: String, forceRefresh: Bool) async throws -> ResolvedAudio
    func invalidate() async
}
