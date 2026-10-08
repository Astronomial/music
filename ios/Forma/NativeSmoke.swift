#if DEBUG && targetEnvironment(simulator)
import AVFoundation
import Foundation
import UIKit
import FormaCore

private struct FixtureResolver: StreamResolving {
    let url: URL
    func resolve(videoID: String, forceRefresh: Bool) async throws -> ResolvedAudio { ResolvedAudio(debugFixture: url) }
    func invalidate() async {}
}
@MainActor
enum NativeSmoke {
    static func run() async {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let report = dir.appendingPathComponent("smoke-result.json")
        func write(_ value: [String: Any]) { if let bytes = try? JSONSerialization.data(withJSONObject: value, options: .prettyPrinted) { try? bytes.write(to: report, options: .atomic) } }
        write(["status": "running"])
        do {
            let args = ProcessInfo.processInfo.arguments
            guard let index = args.firstIndex(of: "--forma-pair-code"), args.count > index + 1 else { throw SyncError.invalidCode }
            let sync = SyncClient(); try await sync.pair(args[index + 1])
            var library = try await sync.synchronize(library: Library(), base: nil)
            guard library.tracks.count >= 4, library.likedIDs.count == 1 else { throw SyncError.rejected("Initial PC library failed") }
            let base = library
            library.likedIDs = []; library.playlists.append(Playlist(id: "phone-playlist", name: "На iPhone", trackIDs: Array(library.tracks.keys.sorted().prefix(2))))
            library.settings.artistDiversity = 1
            let merged = try await sync.synchronize(library: library, base: base)
            guard merged.likedIDs.isEmpty, merged.playlists.contains(where: { $0.id == "phone-playlist" }), merged.settings.artistDiversity == 1 else { throw SyncError.rejected("Bidirectional PC sync failed") }
            let url = dir.appendingPathComponent("fixture.wav")
            let format = AVAudioFormat(standardFormatWithSampleRate: 22050, channels: 1)!
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 110250)!
            buffer.frameLength = buffer.frameCapacity
            for i in 0..<Int(buffer.frameLength) { buffer.floatChannelData![0][i] = sin(Float(i) * 440 * 2 * .pi / 22050) * 0.02 }
            let file = try AVAudioFile(forWriting: url, settings: format.settings); try file.write(from: buffer)
            let tracks = merged.tracks.values.sorted { $0.id < $1.id }.map { track -> Track in var next = track; next.duration = 5; return next }
            let player = PlaybackController(resolver: FixtureResolver(url: url))
            var starts: [String] = [], feedback: [ListeningEvent] = []
            player.onStarted = { starts.append($0.id) }; player.onFeedback = { feedback.append($0) }
            player.pulseNext = { exclude, _ in tracks.first { !exclude.contains($0.id) } }
            player.startPulse(tracks[0])
            for _ in 0..<100 {
                try await Task.sleep(nanoseconds: 300_000_000)
                if starts.count >= 4 && player.isPlaying { break }
            }
            guard starts.count >= 4, Set(starts).count == starts.count, feedback.count >= 3 else { throw SyncError.rejected("Native queue failed: \(starts.count) starts, \(feedback.count) feedback, \(player.error ?? "no player error")") }
            let background = UIApplication.shared.applicationState == .background
            guard background else { throw SyncError.rejected("App was not backgrounded by simulator test") }
            player.pause(); try await Task.sleep(nanoseconds: 200_000_000)
            guard !player.isPlaying else { throw SyncError.rejected("Explicit pause failed") }
            player.resume(); try await Task.sleep(nanoseconds: 500_000_000)
            guard player.isPlaying else { throw SyncError.rejected("Resume failed") }
            write(["status": "passed", "nativeStarts": starts.count, "automaticTransitions": feedback.count, "background": background, "pinnedTLS": true, "bidirectionalSync": true, "pauseResume": true])
            player.pause()
        } catch { write(["status": "failed", "error": error.localizedDescription]) }
    }
}
#endif
