import Foundation

/// One extraction per video, with independent cancellation for each consumer.
/// Abandoned/expired work cannot populate the cache or keep a prepared queue stuck.
public actor AudioRequestPool {
    public typealias Loader = @Sendable (String) async throws -> ResolvedAudio
    private struct Flight {
        let token: UUID
        let task: Task<Void, Never>
        let deadline: Task<Void, Never>
        var waiters: [UUID: CheckedContinuation<ResolvedAudio, Error>]
    }
    private let loader: Loader
    private let timeout: TimeInterval
    private var flights: [String: Flight] = [:]
    private var cache: [String: ResolvedAudio] = [:]
    var activeConsumerCount: Int { flights.values.reduce(0) { $0 + $1.waiters.count } }
    public init(timeout: TimeInterval = 30, loader: @escaping Loader) {
        self.timeout = timeout.isFinite ? min(120, max(0.01, timeout)) : 30
        self.loader = loader
    }
    public func resolve(videoID: String, forceRefresh: Bool = false) async throws -> ResolvedAudio {
        try Task.checkCancellation()
        if forceRefresh { cancel(videoID: videoID) }
        if let hit = cache[videoID], hit.isFresh() { return hit }
        let waiter = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(throwing: CancellationError()); return }
                if flights[videoID] != nil {
                    flights[videoID]?.waiters[waiter] = continuation
                    return
                }
                let token = UUID(), loader = self.loader
                let task = Task { [weak self] in
                    do {
                        let audio = try await loader(videoID)
                        try Task.checkCancellation()
                        await self?.complete(videoID, token: token, result: .success(audio))
                    } catch { await self?.complete(videoID, token: token, result: .failure(error)) }
                }
                let seconds = timeout
                let deadline = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) } catch { return }
                    await self?.complete(videoID, token: token, result: .failure(LoadError.timedOut))
                }
                flights[videoID] = Flight(token: token, task: task, deadline: deadline, waiters: [waiter: continuation])
            }
        } onCancel: { Task { await self.cancelWaiter(waiter, videoID: videoID) } }
    }
    private func cancelWaiter(_ waiter: UUID, videoID: String) {
        guard let continuation = flights[videoID]?.waiters.removeValue(forKey: waiter) else { return }
        continuation.resume(throwing: CancellationError())
        if flights[videoID]?.waiters.isEmpty == true { cancel(videoID: videoID) }
    }
    private func complete(_ videoID: String, token: UUID, result: Result<ResolvedAudio, Error>) {
        guard let flight = flights[videoID], flight.token == token else { return }
        flights[videoID] = nil; flight.deadline.cancel(); flight.task.cancel()
        if case .success(let audio) = result, audio.isFresh() {
            cache = cache.filter { $0.value.isFresh() }
            if cache.count >= 30, let first = cache.keys.sorted().first { cache[first] = nil }
            cache[videoID] = audio
        }
        for continuation in flight.waiters.values { continuation.resume(with: result) }
    }
    public func cancel(videoID: String) {
        cache[videoID] = nil
        guard let flight = flights.removeValue(forKey: videoID) else { return }
        flight.task.cancel(); flight.deadline.cancel()
        for continuation in flight.waiters.values { continuation.resume(throwing: CancellationError()) }
    }
    public func invalidate() {
        for id in Array(flights.keys) { cancel(videoID: id) }
        cache.removeAll()
    }
    deinit {
        for flight in flights.values {
            flight.task.cancel(); flight.deadline.cancel()
            for continuation in flight.waiters.values { continuation.resume(throwing: CancellationError()) }
        }
    }
    public enum LoadError: LocalizedError {
        case timedOut
        public var errorDescription: String? { "YouTube слишком долго готовит поток. Попробуй повторить воспроизведение." }
    }
}
