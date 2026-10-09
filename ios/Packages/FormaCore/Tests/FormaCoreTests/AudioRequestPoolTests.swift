import Foundation
import XCTest
@testable import FormaCore

private actor ExtractionProbe {
    private(set) var calls = 0
    private(set) var cancellations = 0
    private var waiting: [Int: CheckedContinuation<ResolvedAudio, Error>] = [:]
    let cooperative: Bool
    init(cooperative: Bool = true) { self.cooperative = cooperative }
    func load(_ id: String) async throws -> ResolvedAudio {
        calls += 1; let index = calls
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { waiting[index] = $0 }
        } onCancel: { Task { await self.cancel(index) } }
    }
    private func cancel(_ index: Int) {
        cancellations += 1
        if cooperative { waiting.removeValue(forKey: index)?.resume(throwing: CancellationError()) }
    }
    func finish(_ index: Int) throws {
        let audio = try ResolvedAudio(url: URL(string: "https://r1.googlevideo.com/audio?fixture=\(index)")!)
        waiting.removeValue(forKey: index)?.resume(returning: audio)
    }
}

final class AudioRequestPoolTests: XCTestCase {
    private let id = "abcdefghijk"
    private func wait(_ condition: () async -> Bool) async throws {
        for _ in 0..<500 {
            if await condition() { return }
            try await Task.sleep(nanoseconds: 2_000_000)
        }
        XCTFail("Controlled extraction did not reach expected state")
    }
    func testSharedExtractionSurvivesOneConsumerCancellationAndCachesSuccess() async throws {
        let probe = ExtractionProbe(), pool = AudioRequestPool(timeout: 2) { try await probe.load($0) }
        let first = Task { try await pool.resolve(videoID: id) }
        try await wait { await pool.activeConsumerCount == 1 }
        let second = Task { try await pool.resolve(videoID: id) }
        try await wait { await pool.activeConsumerCount == 2 }
        first.cancel()
        do { _ = try await first.value; XCTFail("Cancelled consumer returned audio") } catch { XCTAssertTrue(error is CancellationError) }
        let cancellations = await probe.cancellations; XCTAssertEqual(cancellations, 0)
        try await probe.finish(1)
        let selected = try await second.value, cached = try await pool.resolve(videoID: id)
        XCTAssertEqual(selected.url, cached.url)
        let calls = await probe.calls; XCTAssertEqual(calls, 1)
    }
    func testLastConsumerCancellationCancelsUnderlyingExtractionAndAllowsRetry() async throws {
        let probe = ExtractionProbe(), pool = AudioRequestPool(timeout: 2) { try await probe.load($0) }
        let first = Task { try await pool.resolve(videoID: id) }
        try await wait { await probe.calls == 1 }; first.cancel()
        do { _ = try await first.value; XCTFail("Cancelled extraction returned audio") } catch { XCTAssertTrue(error is CancellationError) }
        try await wait { await probe.cancellations == 1 }
        let retry = Task { try await pool.resolve(videoID: id) }
        try await wait { await probe.calls == 2 }; try await probe.finish(2)
        let result = try await retry.value; XCTAssertTrue(result.isFresh())
    }
    func testDeadlineReleasesWaiterEvenWhenLoaderIgnoresCancellation() async throws {
        let probe = ExtractionProbe(cooperative: false), pool = AudioRequestPool(timeout: 0.05) { try await probe.load($0) }
        let first = Task { try await pool.resolve(videoID: id) }
        try await wait { await probe.calls == 1 }
        do { _ = try await first.value; XCTFail("Hung extraction returned audio") } catch { XCTAssertTrue(error is AudioRequestPool.LoadError) }
        let consumers = await pool.activeConsumerCount; XCTAssertEqual(consumers, 0)
        try await probe.finish(1)
        let retry = Task { try await pool.resolve(videoID: id) }
        try await wait { await probe.calls == 2 }; try await probe.finish(2)
        let result = try await retry.value
        XCTAssertEqual(URLComponents(url: result.url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "2")
    }
    func testInvalidationRejectsOldConsumersAndCannotCacheLateOldNetworkResult() async throws {
        let probe = ExtractionProbe(cooperative: false), pool = AudioRequestPool(timeout: 2) { try await probe.load($0) }
        let old = Task { try await pool.resolve(videoID: id) }
        try await wait { await probe.calls == 1 }; await pool.invalidate()
        do { _ = try await old.value; XCTFail("Old-network consumer survived invalidation") } catch { XCTAssertTrue(error is CancellationError) }
        let fresh = Task { try await pool.resolve(videoID: id) }
        try await wait { await probe.calls == 2 }; try await probe.finish(1); try await probe.finish(2)
        let result = try await fresh.value, cached = try await pool.resolve(videoID: id)
        XCTAssertEqual(result.url, cached.url); XCTAssertTrue(cached.url.absoluteString.contains("fixture=2"))
    }
    func testForceRefreshCancelsOldFlightAndReturnsFreshAudio() async throws {
        let probe = ExtractionProbe(), pool = AudioRequestPool(timeout: 2) { try await probe.load($0) }
        let old = Task { try await pool.resolve(videoID: id) }
        try await wait { await probe.calls == 1 }
        let fresh = Task { try await pool.resolve(videoID: id, forceRefresh: true) }
        do { _ = try await old.value; XCTFail("Force refresh left old extraction alive") } catch { XCTAssertTrue(error is CancellationError) }
        try await wait { await probe.calls == 2 }; try await probe.finish(2)
        let result = try await fresh.value; XCTAssertTrue(result.url.absoluteString.contains("fixture=2"))
    }
    func testCancellingOneVideoDoesNotCancelAnotherPreparedVideo() async throws {
        let probe = ExtractionProbe(), pool = AudioRequestPool(timeout: 2) { try await probe.load($0) }
        let first = Task { try await pool.resolve(videoID: id) }
        try await wait { await probe.calls == 1 }
        let second = Task { try await pool.resolve(videoID: "12345678901") }
        try await wait { await probe.calls == 2 }; await pool.cancel(videoID: id)
        do { _ = try await first.value; XCTFail("Explicit cancellation failed") } catch { XCTAssertTrue(error is CancellationError) }
        try await probe.finish(2)
        let result = try await second.value; XCTAssertTrue(result.isFresh())
    }
}
