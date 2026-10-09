#if DEBUG && targetEnvironment(simulator)
import AVFoundation
import Foundation
import UIKit
import FormaCore

private actor FixtureResolver: StreamResolving {
    let url: URL
    private(set) var calls: [String: Int] = [:]
    init(url: URL) { self.url = url }
    func resolve(videoID: String, forceRefresh: Bool) async throws -> ResolvedAudio {
        calls[videoID, default: 0] += 1
        print("Native fixture resolve: \(videoID), attempt \(calls[videoID]!), refresh \(forceRefresh)")
        try await Task.sleep(nanoseconds: 500_000_000)
        // Real tracks have distinct URLs. Sharing one file URL across queue items can
        // make AVFoundation coalesce and cancel an unrelated asset's load during a skip.
        let trackURL = url.deletingLastPathComponent().appendingPathComponent("fixture-\(videoID).wav")
        if !FileManager.default.fileExists(atPath: trackURL.path) { try FileManager.default.copyItem(at: url, to: trackURL) }
        return ResolvedAudio(debugFixture: trackURL)
    }
    func invalidate() async {}
}
private actor RecoveringFixtureResolver: StreamResolving {
    let audio: ResolvedAudio
    var calls = 0
    private(set) var cancellations = 0
    init(audio: ResolvedAudio) { self.audio = audio }
    func resolve(videoID: String, forceRefresh: Bool) async throws -> ResolvedAudio {
        calls += 1
        if calls == 1 { try await Task.sleep(nanoseconds: 5_000_000_000) }
        guard forceRefresh else { throw SyncError.rejected("Retry did not request a fresh stream") }
        return audio
    }
    func cancel(videoID: String) async { cancellations += 1 }
    func invalidate() async {}
}
private actor HandoffFixtureResolver: StreamResolving {
    let audio: ResolvedAudio
    private(set) var calls = 0
    private(set) var cancelled = 0
    private(set) var freshRequests = 0
    init(audio: ResolvedAudio) { self.audio = audio }
    func resolve(videoID: String, forceRefresh: Bool) async throws -> ResolvedAudio {
        calls += 1; if forceRefresh { freshRequests += 1 }
        if calls == 1 {
            do { try await Task.sleep(nanoseconds: 5_000_000_000) }
            catch { cancelled += 1; throw error }
        }
        return audio
    }
    func invalidate() async {}
}
@MainActor
enum NativeSmoke {
    private static var started = false
    static var miniFrame: CGRect = .zero
    private static var fixtureResolver: FixtureResolver!
    static func makeModel() -> AppModel {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let url = dir.appendingPathComponent("fixture.wav")
        let format = AVAudioFormat(standardFormatWithSampleRate: 22050, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 110250)!
        buffer.frameLength = buffer.frameCapacity
        for i in 0..<Int(buffer.frameLength) { buffer.floatChannelData![0][i] = sin(Float(i) * 440 * 2 * .pi / 22050) * 0.02 }
        do { let file = try AVAudioFile(forWriting: url, settings: format.settings); try file.write(from: buffer) } catch { fatalError("Cannot write native audio fixture") }
        fixtureResolver = FixtureResolver(url: url)
        return AppModel(playbackResolver: fixtureResolver)
    }
    static func startOnce(model: AppModel) { guard !started else { return }; started = true; Task { await run(model: model) } }
    static func run(model: AppModel) async {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let report = dir.appendingPathComponent("smoke-result.json")
        func write(_ value: [String: Any]) { if let bytes = try? JSONSerialization.data(withJSONObject: value, options: .prettyPrinted) { try? bytes.write(to: report, options: .atomic) } }
        write(["status": "running", "stage": "pairing"])
        var stage = "pairing"
        do {
            let args = ProcessInfo.processInfo.arguments
            guard let index = args.firstIndex(of: "--forma-pair-code"), args.count > index + 1 else { throw SyncError.invalidCode }
            let sync = SyncClient()
            var invalid = URLComponents(string: args[index + 1])!
            invalid.queryItems = invalid.queryItems?.map { $0.name == "pin" ? URLQueryItem(name: "pin", value: String(repeating: "0", count: 64)) : $0 }
            var rejectedWrongPin = false
            do { try await sync.pair(invalid.string!) } catch { rejectedWrongPin = true }
            guard rejectedWrongPin else { throw SyncError.rejected("Wrong certificate pin was accepted") }
            try await sync.pair(args[index + 1])
            stage = "first-sync"
            var library = try await sync.synchronize(library: Library(), base: nil)
            guard library.tracks.count >= 4, library.likedIDs.count == 1 else { throw SyncError.rejected("Initial PC library failed") }
            let base = library
            stage = "second-sync"
            library.likedIDs = []; library.playlists.append(Playlist(id: "phone-playlist", name: "На iPhone", trackIDs: Array(library.tracks.keys.sorted().prefix(2))))
            library.settings.artistDiversity = 1
            let merged = try await sync.synchronize(library: library, base: base)
            guard merged.likedIDs.isEmpty, merged.playlists.contains(where: { $0.id == "phone-playlist" }), merged.settings.artistDiversity == 1 else { throw SyncError.rejected("Bidirectional PC sync failed") }
            stage = "native-playback"
            let tracks = merged.tracks.values.sorted { $0.id < $1.id }.map { track -> Track in var next = track; next.duration = 5; return next }
            let recoveryAudio = try await fixtureResolver.resolve(videoID: tracks[0].id, forceRefresh: false)
            let recoveryResolver = RecoveringFixtureResolver(audio: recoveryAudio)
            let recoveryPlayer = PlaybackController(resolver: recoveryResolver, extractionTimeout: 0.1, bufferTimeout: 4)
            recoveryPlayer.play(tracks[0], list: [tracks[0]])
            for _ in 0..<100 {
                if recoveryPlayer.error != nil { break }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            guard recoveryPlayer.error != nil, !recoveryPlayer.isLoading else { throw SyncError.rejected("Unresponsive extraction never timed out") }
            let cancellations = await recoveryResolver.cancellations
            guard cancellations > 0 else { throw SyncError.rejected("Timed-out stream request was not cancelled") }
            recoveryPlayer.resume()
            for _ in 0..<80 {
                if recoveryPlayer.isPlaying { break }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            guard recoveryPlayer.isPlaying else { throw SyncError.rejected("Retry failed to recover after timeout") }
            recoveryPlayer.pause()
            let handoffResolver = HandoffFixtureResolver(audio: recoveryAudio)
            let handoffPlayer = PlaybackController(resolver: handoffResolver)
            for _ in 0..<100 {
                if handoffPlayer.networkPolicy.known { break }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            var handoffStarts = 0, handoffFeedback = 0
            handoffPlayer.onStarted = { _ in handoffStarts += 1 }
            handoffPlayer.onFeedback = { _ in handoffFeedback += 1 }
            handoffPlayer.play(tracks[0], list: [tracks[0]])
            for _ in 0..<100 {
                if await handoffResolver.calls > 0 { break }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            handoffPlayer.debugNetworkChanged(NetworkPolicy(reachable: true, cellular: true, expensive: true), signature: "cellular-vpn")
            for _ in 0..<100 {
                if handoffPlayer.isPlaying { break }
                try await Task.sleep(nanoseconds: 30_000_000)
            }
            let cancelledRequests = await handoffResolver.cancelled, freshRequests = await handoffResolver.freshRequests
            guard handoffPlayer.isPlaying, handoffPlayer.error == nil, cancelledRequests == 1,
                  freshRequests == 1, handoffStarts == 1, handoffFeedback == 0 else { throw SyncError.rejected("Network handoff did not restart unfinished audio cleanly") }
            handoffPlayer.pause()
            handoffPlayer.debugNetworkChanged(NetworkPolicy(reachable: false), signature: "vpn-reconnecting")
            handoffPlayer.debugNetworkChanged(NetworkPolicy(reachable: true, cellular: true, expensive: true), signature: "vpn-restored")
            try await Task.sleep(nanoseconds: 500_000_000)
            guard !handoffPlayer.isPlaying else { throw SyncError.rejected("Network recovery overrode a manual pause") }
            let player = model.player
            model.toggleLike(tracks[0])
            guard model.isLiked(tracks[0]) else { throw SyncError.rejected("Mini-player favourite state failed") }
            // Wait for the real AppModel ranking, then verify selection and explicit
            // feedback carry its feature snapshot through native playback callbacks.
            for _ in 0..<100 {
                if model.recommendations.contains(where: { $0.id == tracks[0].id }) { break }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            guard model.recommendations.contains(where: { $0.id == tracks[0].id && $0.exposure?.isValid == true }) else { throw SyncError.rejected("AppModel did not prepare a learning snapshot") }
            player.play(tracks[0], list: tracks)
            // Current extraction takes 500ms. Wait for the second track's real AVPlayerItem.
            for _ in 0..<100 {
                if player.debugPreparedTrackID == tracks[1].id { break }
                try await Task.sleep(nanoseconds: 30_000_000)
            }
            guard player.debugPreparedTrackID == tracks[1].id else { throw SyncError.rejected("Next track was not prepared immediately") }
            guard let cold = player.measurements.first, cold.totalMilliseconds < 2500 else { throw SyncError.rejected("Controlled cold playback exceeded 2.5 seconds") }
            let coldStartMilliseconds = cold.totalMilliseconds
            guard let exposure = model.library.events.last(where: { $0.trackID == tracks[0].id && $0.kind == .play }),
                  exposure.recommendation?.isValid == true, exposure.surface == "manual" else { throw SyncError.rejected("Native start lost its recommendation context") }
            model.toggleLike(tracks[0]); model.toggleLike(tracks[0])
            model.createPlaylist("Learning fixture")
            guard let learningPlaylist = model.library.playlists.last else { throw SyncError.rejected("Learning playlist missing") }
            model.add(tracks[0], to: learningPlaylist.id)
            let explicit = model.library.events.filter { $0.trackID == tracks[0].id && ($0.kind == .like || $0.kind == .playlistAdd) && $0.recommendation == exposure.recommendation }
            guard explicit.count == 2, explicit.allSatisfy({ $0.reward == 1 }) else { throw SyncError.rejected("Like and playlist feedback lost the selected learning snapshot") }
            let callsBefore = await fixtureResolver.calls[tracks[1].id]
            let switchedAt = ProcessInfo.processInfo.systemUptime
            player.play(tracks[1], list: tracks)
            let switchDelay = ProcessInfo.processInfo.systemUptime - switchedAt
            guard player.current?.id == tracks[1].id, switchDelay < 0.2 else { throw SyncError.rejected("Manual next-track reuse failed") }
            try await Task.sleep(nanoseconds: 100_000_000)
            guard let warmed = player.measurements.last, warmed.source == "prepared", warmed.totalMilliseconds < 250 else { throw SyncError.rejected("Prepared playback did not reach playing within 250ms") }
            let preparedPlayingMilliseconds = warmed.totalMilliseconds
            let callsAfter = await fixtureResolver.calls[tracks[1].id]
            guard callsAfter == callsBefore else { throw SyncError.rejected("Prepared track was extracted twice: \(callsBefore ?? 0) -> \(callsAfter ?? 0); \(player.error ?? "no error"), playing \(player.isPlaying)") }
            // Rebuild the queued asset on a new network even if its URL has not
            // expired; continuing buffered current audio must remain uninterrupted.
            for _ in 0..<100 {
                if player.debugPreparedTrackID == tracks[2].id { break }
                try await Task.sleep(nanoseconds: 30_000_000)
            }
            guard player.debugPreparedTrackID == tracks[2].id else { throw SyncError.rejected("Handoff fixture never prepared the old-network item") }
            let preparedCallsBefore = await fixtureResolver.calls[tracks[2].id] ?? 0
            player.debugNetworkChanged(NetworkPolicy(reachable: true, cellular: true, expensive: true), signature: "prepared-cellular-vpn")
            guard player.debugPreparedTrackID == nil else { throw SyncError.rejected("Prepared old-network URL survived handoff") }
            for _ in 0..<100 {
                if player.debugPreparedTrackID == tracks[2].id { break }
                try await Task.sleep(nanoseconds: 30_000_000)
            }
            let preparedCallsAfter = await fixtureResolver.calls[tracks[2].id] ?? 0
            guard player.isPlaying, player.debugPreparedTrackID == tracks[2].id, preparedCallsAfter > preparedCallsBefore else { throw SyncError.rejected("Next audio was not prepared on the new network") }
            try await Task.sleep(nanoseconds: 200_000_000)
            func tabBar(in view: UIView) -> UITabBar? {
                if let bar = view as? UITabBar { return bar }
                return view.subviews.lazy.compactMap { tabBar(in: $0) }.first
            }
            let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
            guard let bar = windows.lazy.compactMap({ tabBar(in: $0) }).first,
                  miniFrame.height > 40 else { throw SyncError.rejected("Mini-player or tab bar was not visible") }
            let barFrame = bar.convert(bar.bounds, to: nil)
            guard miniFrame.maxY <= barFrame.minY + 1 else { throw SyncError.rejected("Mini-player covers navigation: \(miniFrame), tab bar \(barFrame)") }
            write(["status": "running", "stage": "layout-verified", "miniPlayerBottom": miniFrame.maxY, "tabBarTop": barFrame.minY])
            // Simulator screenshots can take longer than our short audio fixtures.
            // Explicitly coordinate the move to Safari before measuring background transitions.
            var transitionTask = UIApplication.shared.beginBackgroundTask(withName: "Forma smoke transition")
            defer { if transitionTask != .invalid { UIApplication.shared.endBackgroundTask(transitionTask) } }
            write(["status": "running", "stage": "awaiting-background"])
            for _ in 0..<240 {
                if UIApplication.shared.applicationState == .background { break }
                try await Task.sleep(nanoseconds: 500_000_000)
            }
            guard UIApplication.shared.applicationState == .background else { throw SyncError.rejected("Simulator did not move app to background") }
            var starts: [String] = [], feedback: [ListeningEvent] = []
            player.onStarted = { starts.append($0.id); write(["status": "running", "stage": "playing", "nativeStarts": starts.count]) }; player.onFeedback = { feedback.append($0) }
            player.pulseNext = { exclude, _ in tracks.first { !exclude.contains($0.id) } }
            player.startPulse(tracks[0])
            for _ in 0..<100 {
                if player.isPlaying { break }
                try await Task.sleep(nanoseconds: 30_000_000)
            }
            guard player.isPlaying else { throw SyncError.rejected("Native background audio did not start") }
            // Only AVAudioSession keeps the app playing during the measured transitions.
            UIApplication.shared.endBackgroundTask(transitionTask); transitionTask = .invalid
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
            write(["status": "passed", "nativeStarts": starts.count, "automaticTransitions": feedback.count, "background": background, "pinnedTLS": true, "wrongPinRejected": rejectedWrongPin, "bidirectionalSync": true, "pauseResume": true, "miniPlayerAboveTabs": true, "miniPlayerBottom": miniFrame.maxY, "tabBarTop": barFrame.minY, "preparedManualSwitchMilliseconds": switchDelay * 1000, "preparedStreamReused": true, "controlledColdStartMilliseconds": coldStartMilliseconds, "preparedPlayingMilliseconds": preparedPlayingMilliseconds, "startupTimeoutRecovered": true, "recommendationSnapshotCaptured": true, "explicitLearningFeedbackCaptured": true, "networkHandoffRecovered": true, "oldNetworkPreparedItemDiscarded": true, "networkRecoveryRespectsPause": true])
            player.pause()
        } catch { let failure = error as NSError; write(["status": "failed", "stage": stage, "error": error.localizedDescription, "domain": failure.domain, "code": failure.code, "taskCancelled": Task.isCancelled]) }
    }
}
#endif
