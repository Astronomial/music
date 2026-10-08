import Foundation
import FormaCore
import YouTubeKit

/// Uses the vendored MIT YouTubeKit snapshot. All extraction runs on-device.
/// Never opts in to the upstream public remote fallback or stores account cookies.
actor YouTubeStreamResolver: StreamResolving {
    private var inflight: [String: Task<ResolvedAudio, Error>] = [:]
    private var cache: [String: ResolvedAudio] = [:]
    func resolve(videoID: String, forceRefresh: Bool = false) async throws -> ResolvedAudio {
        guard VideoID.isValid(videoID) else { throw ResolverError.invalidID }
        if !forceRefresh, let hit = cache[videoID], hit.isFresh() { return hit }
        if !forceRefresh, let pending = inflight[videoID] { return try await pending.value }
        if forceRefresh { inflight[videoID]?.cancel() }
        let job = Task<ResolvedAudio, Error> {
            let video = YouTube(videoID: videoID, useOAuth: false, allowOAuthCache: false, methods: [.local])
            let streams = try await video.streams
            try Task.checkCancellation()
            guard let stream = streams.filterAudioOnly().filter({ $0.isNativelyPlayable && $0.fileExtension == .m4a }).highestAudioBitrateStream() else { throw ResolverError.noAudio }
            let result = try ResolvedAudio(url: stream.url)
            guard result.isFresh() else { throw ResolverError.expired }
            return result
        }
        inflight[videoID] = job
        defer { inflight[videoID] = nil }
        let result = try await job.value
        if cache.count >= 30 { cache = cache.filter { $0.value.isFresh() } }
        if cache.count >= 30 { cache.removeValue(forKey: cache.keys.sorted().first!) }
        cache[videoID] = result
        return result
    }
    func describe(videoID: String) async -> Track? {
        let video = YouTube(videoID: videoID, useOAuth: false, allowOAuthCache: false, methods: [.local])
        guard let metadata = try? await video.metadata else { return nil }
        return Track(videoID: videoID, title: metadata.title, artist: "Исполнитель не указан", artworkURL: metadata.thumbnail?.url)
    }
    func invalidate() { cache.removeAll(); inflight.values.forEach { $0.cancel() }; inflight.removeAll() }
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
