import AVFoundation
import Foundation

/// Preroll decodes and buffers the start without starting an audible player.
/// A single completion owns its timeout/cancellation, so an abandoned item cannot
/// populate the warm queue or keep its continuation alive indefinitely.
@MainActor
final class AudioPreroll {
    private let player: AVPlayer
    private var continuation: CheckedContinuation<Bool, Never>?
    private var observation: NSKeyValueObservation?
    private var deadline: Task<Void, Never>?
    private var began = false
    init(_ player: AVPlayer) { self.player = player }
    func wait(seconds: Double) async -> Bool {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(returning: false); return }
                self.continuation = continuation
                observation = player.observe(\.status, options: [.initial, .new]) { [weak self] _, _ in
                    Task { @MainActor in self?.statusChanged() }
                }
                deadline = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) } catch { return }
                    self?.complete(false)
                }
            }
        } onCancel: { Task { @MainActor in self.complete(false) } }
    }
    private func statusChanged() {
        guard continuation != nil else { return }
        if player.status == .failed { complete(false); return }
        guard player.status == .readyToPlay, !began else { return }
        began = true
        player.preroll(atRate: 1) { [weak self] ready in Task { @MainActor in self?.complete(ready) } }
    }
    private func complete(_ ready: Bool) {
        guard let continuation else { return }; self.continuation = nil
        observation = nil; deadline?.cancel(); deadline = nil
        if !ready { player.cancelPendingPrerolls() }
        continuation.resume(returning: ready)
    }
}
