import Foundation
import FormaCore
import YouTubeKit

/// Uses the vendored MIT YouTubeKit snapshot. All extraction runs on-device.
/// Never opts in to the upstream public remote fallback or stores account cookies.
actor YouTubeStreamResolver: StreamResolving {
    private var inflight: [String: (id: UUID, task: Task<ResolvedAudio, Error>)] = [:]
    private var warming: Task<Void, Never>?
    private var warmingIDs: [String] = []
    private var warmingGeneration = UUID()
    private var cache: [String: ResolvedAudio] = [:]
    func resolve(videoID: String, forceRefresh: Bool = false) async throws -> ResolvedAudio {
        guard VideoID.isValid(videoID) else { throw ResolverError.invalidID }
        if !forceRefresh, let hit = cache[videoID], hit.isFresh() { return hit }
        if !forceRefresh, let pending = inflight[videoID] { return try await pending.task.value }
        if forceRefresh { inflight[videoID]?.task.cancel() }
        let requestID = UUID()
        let job = Task<ResolvedAudio, Error> {
            let video = YouTube(videoID: videoID, useOAuth: false, allowOAuthCache: false, methods: [.local])
            let streams: [YouTubeKit.Stream]
            do { streams = try await video.audioStreams }
            catch let extraction as AudioStreamExtractionError { throw ResolverError.extraction(extraction.attempts.joined(separator: "; ")) }
            catch let error as YouTubeKitError { throw ResolverError.extraction(error.rawValue) }
            try Task.checkCancellation()
            guard let stream = streams.filterAudioOnly().filter({ $0.isNativelyPlayable && $0.fileExtension == .m4a }).highestAudioBitrateStream() else { throw ResolverError.noAudio }
            let result = try ResolvedAudio(url: stream.url)
            guard result.isFresh() else { throw ResolverError.expired }
            return result
        }
        inflight[videoID] = (requestID, job)
        defer { if inflight[videoID]?.id == requestID { inflight[videoID] = nil } }
        let result = try await job.value
        guard inflight[videoID]?.id == requestID else { throw CancellationError() }
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
    func prewarm(videoIDs: [String]) {
        let ids = Array(videoIDs.filter { VideoID.isValid($0) && cache[$0]?.isFresh() != true }.prefix(3))
        guard ids != warmingIDs else { return }
        warming?.cancel(); warmingIDs = ids
        let token = UUID(); warmingGeneration = token
        warming = Task(priority: .utility) { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            for id in ids {
                guard !Task.isCancelled, let self else { return }
                _ = try? await self.resolve(videoID: id, forceRefresh: false)
            }
            if let self, self.warmingGeneration == token { self.warmingIDs = [] }
        }
    }
    func cancel(videoID: String) {
        inflight[videoID]?.task.cancel(); inflight[videoID] = nil; cache[videoID] = nil
    }
    func invalidate() { warming?.cancel(); warmingIDs = []; cache.removeAll(); inflight.values.forEach { $0.task.cancel() }; inflight.removeAll() }
    enum ResolverError: LocalizedError {
        case invalidID, noAudio, expired
        case extraction(String)
        var errorDescription: String? {
            switch self {
            case .invalidID: return "Нужна ссылка на видео YouTube."
            case .noAudio: return "YouTube не предоставил поддерживаемый аудиопоток. Возможно, получение потоков требует обновления."
            case .extraction(let diagnostic): return "Не удалось получить аудио от YouTube. Нажми «Повторить». Если ошибка сохраняется, передай этот код: \(diagnostic)"
            case .expired: return "Адрес потока уже истёк. Повтори воспроизведение."
            }
        }
    }
}
