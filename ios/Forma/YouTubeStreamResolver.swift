import Foundation
import FormaCore
import YouTubeKit

/// Uses the vendored MIT YouTubeKit snapshot. All extraction runs on-device.
/// Never opts in to the upstream public remote fallback or stores account cookies.
actor YouTubeStreamResolver: StreamResolving {
    private let requests = AudioRequestPool(loader: { try await YouTubeStreamResolver.extract($0) })
    private var warming: Task<Void, Never>?
    private var warmingIDs: [String] = []
    private var warmingGeneration = UUID()
    func resolve(videoID: String, forceRefresh: Bool = false) async throws -> ResolvedAudio {
        guard VideoID.isValid(videoID) else { throw ResolverError.invalidID }
        let optionalIDs = warmingIDs; warmingIDs = []; warmingGeneration = UUID()
        // Preserve a shared extraction for this video; the old warmer stops before
        // its next iteration. Cancelling it before joining would discard useful work.
        if !optionalIDs.contains(videoID) { warming?.cancel() }
        for id in optionalIDs where id != videoID { await requests.cancel(videoID: id) }
        return try await requests.resolve(videoID: videoID, forceRefresh: forceRefresh)
    }
    nonisolated private static func extract(_ videoID: String) async throws -> ResolvedAudio {
        guard VideoID.isValid(videoID) else { throw ResolverError.invalidID }
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
    func describe(videoID: String) async -> Track? {
        let video = YouTube(videoID: videoID, useOAuth: false, allowOAuthCache: false, methods: [.local])
        guard let metadata = try? await video.metadata else { return nil }
        return Track(videoID: videoID, title: metadata.title, artist: "Исполнитель не указан", artworkURL: metadata.thumbnail?.url)
    }
    func prewarm(videoIDs: [String]) async {
        let ids = Array(videoIDs.filter { VideoID.isValid($0) }.prefix(3))
        guard ids != warmingIDs else { return }
        warming?.cancel()
        warmingIDs = ids
        let token = UUID(); warmingGeneration = token
        warming = Task(priority: .utility) { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            for id in ids {
                guard !Task.isCancelled, let self, self.warmingGeneration == token else { return }
                _ = try? await self.requests.resolve(videoID: id)
            }
            await self?.finishWarming(token: token)
        }
    }
    private func finishWarming(token: UUID) {
        if warmingGeneration == token { warmingIDs = [] }
    }
    func cancel(videoID: String) async {
        await requests.cancel(videoID: videoID)
    }
    func invalidate() async {
        warming?.cancel(); warmingIDs = []; warmingGeneration = UUID()
        await requests.invalidate()
        await YouTube.resetAudioContext()
    }
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
