import Foundation
import FormaCore
import YouTubeKit

/// Uses the vendored MIT YouTubeKit snapshot. All extraction runs on-device.
/// Never opts in to the upstream public remote fallback or stores account cookies.
actor YouTubeStreamResolver: StreamResolving {
    private var cache: [String: ResolvedAudio] = [:]
    func resolve(videoID: String, forceRefresh: Bool = false) async throws -> ResolvedAudio {
        guard VideoID.isValid(videoID) else { throw ResolverError.invalidID }
        if !forceRefresh, let hit = cache[videoID], hit.isFresh() { return hit }
        let video = YouTube(videoID: videoID, useOAuth: false, allowOAuthCache: false, methods: [.local])
        let streams = try await video.streams
        try Task.checkCancellation()
        guard let stream = streams.filterAudioOnly().filter({ $0.isNativelyPlayable && $0.fileExtension == .m4a }).highestAudioBitrateStream() else {
            throw ResolverError.noAudio
        }
        // Stream retrieval is essential; optional artwork/title must not block playback.
        let metadata = try? await video.metadata
        try Task.checkCancellation()
        let result = try ResolvedAudio(url: stream.url, title: metadata?.title, artworkURL: metadata?.thumbnail?.url)
        guard result.isFresh() else { throw ResolverError.expired }
        if cache.count >= 30 { cache.removeAll() }
        cache[videoID] = result
        return result
    }
    func invalidate() { cache.removeAll() }
    enum ResolverError: LocalizedError {
        case invalidID, noAudio, expired
        var errorDescription: String? {
            switch self {
            case .invalidID: return "Нужна ссылка на видео YouTube."
            case .noAudio: return "YouTube не предоставил поддерживаемый аудиопоток. Возможно, получение потоков требует обновления."
            case .expired: return "Адрес потока уже истёк. Повтори воспроизведение."
            }
        }
    }
}
