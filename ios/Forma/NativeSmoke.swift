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
private actor PrerollFixtureResolver: StreamResolving {
    let urls: [String: URL]
    private(set) var calls: [String: Int] = [:]
    init(urls: [String: URL]) { self.urls = urls }
    func resolve(videoID: String, forceRefresh: Bool) async throws -> ResolvedAudio {
        calls[videoID, default: 0] += 1
        try await Task.sleep(nanoseconds: 250_000_000)
        guard let url = urls[videoID] else { throw SyncError.rejected("Missing preroll fixture") }
        return ResolvedAudio(debugFixture: url)
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
private struct ConstantFixtureResolver: StreamResolving {
    let audio: ResolvedAudio
    func resolve(videoID: String, forceRefresh: Bool) async throws -> ResolvedAudio { audio }
    func invalidate() async {}
}
private actor FixtureCatalog: MusicCatalogProviding {
    let tracks = (0..<4).map { Track(videoID: String(format: "%011d", $0), title: "Проверка \($0)", artist: "Artist \($0)", duration: 5, genres: ["House"], genre: "House") }
    private var pagedDiscovery = false
    private var pageNumber = 0
    func usePages(_ enabled: Bool) { pagedDiscovery = enabled }
    func discoveryPage(_ request: DiscoveryRequest) async throws -> DiscoveryPage {
        guard pagedDiscovery else { return .init(tracks: try await related(to: request.seed)) }
        try await Task.sleep(nanoseconds: 50_000_000)
        pageNumber += 1
        let start = pageNumber * 20
        let songs = (start..<(start + 20)).map { i -> Track in
            var track = Track(videoID: String(format: "p%010d", i), title: "Открытие \(i)", artist: "Артист открытия \(i)", duration: 5, genre: "House")
            track.relatedTo = [request.seed.id]; track.directRelatedTo = [request.seed.id]; return track
        }
        return .init(tracks: songs, continuation: "native-page-\(pageNumber)")
    }
    private(set) var slowSearchStarted = false
    private(set) var uncancellableSearchStarted = false
    private(set) var descriptionStarted = false
    func search(_ query: String, genre: String?, mood: String?, hints: [String]) async throws -> [Track] {
        if query == "slow" { slowSearchStarted = true; try await Task.sleep(nanoseconds: 300_000_000); return [tracks[0]] }
        if query == "cancel" { uncancellableSearchStarted = true; try? await Task.sleep(nanoseconds: 300_000_000); return [tracks[0]] }
        if query == "fast" { return [tracks[1]] }
        return tracks.map { old in var track = old; track.moodHints = mood.map { [$0] } ?? []; return track }
    }
    func related(to track: Track) async throws -> [Track] {
        tracks.filter { $0.id != track.id }.map { old in var item = old; item.relatedTo = [track.id]; item.directRelatedTo = [track.id]; return item }
    }
    func describe(videoID: String) async -> Track? {
        descriptionStarted = true
        do { try await Task.sleep(nanoseconds: 500_000_000) } catch { return nil }
        return Track(videoID: videoID, title: "Delayed metadata", artist: "Fixture")
    }
}
private final class TransientKeychainProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return calls }
    func read() -> SyncClient.ConnectionRead {
        lock.lock(); defer { lock.unlock() }; calls += 1
        if calls == 1 { return .init(connection: nil, retry: true) }
        return .init(connection: PCConnection(host: "10.0.0.2", port: 30377, pin: String(repeating: "0", count: 64), token: "fixture-token"), retry: false)
    }
}
@MainActor
enum NativeSmoke {
    private static var startupStages = Set<String>()
    static func noteStartup(_ stage: String) {
        guard ProcessInfo.processInfo.arguments.contains("--forma-smoke"), startupStages.insert(stage).inserted else { return }
        print("Forma startup: \(stage)")
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let file = directory.appendingPathComponent("native-startup.txt")
        let previous = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
        try? (previous + stage + "\n").write(to: file, atomically: true, encoding: .utf8)
    }
    private static var started = false
    static var miniFrame: CGRect = .zero
    private static var fixtureResolver: FixtureResolver!
    private static var fixtureCatalog: FixtureCatalog!
    static func makeModel() -> AppModel {
        noteStartup("fixture-model-begin")
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let url = dir.appendingPathComponent("fixture.wav")
        let format = AVAudioFormat(standardFormatWithSampleRate: 22050, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 110250)!
        buffer.frameLength = buffer.frameCapacity
        for i in 0..<Int(buffer.frameLength) { buffer.floatChannelData![0][i] = sin(Float(i) * 440 * 2 * .pi / 22050) * 0.02 }
        do { let file = try AVAudioFile(forWriting: url, settings: format.settings); try file.write(from: buffer) } catch { fatalError("Cannot write native audio fixture") }
        fixtureResolver = FixtureResolver(url: url)
        fixtureCatalog = FixtureCatalog()
        let model = AppModel(playbackResolver: fixtureResolver, catalog: fixtureCatalog)
        noteStartup("fixture-model-created"); return model
    }
    static func startOnce(model: AppModel) { noteStartup("root-appeared"); guard !started else { return }; started = true; Task { await run(model: model) } }
    static func run(model: AppModel) async {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let report = dir.appendingPathComponent("smoke-result.json")
        func write(_ value: [String: Any]) { if let bytes = try? JSONSerialization.data(withJSONObject: value, options: .prettyPrinted) { try? bytes.write(to: report, options: .atomic) } }
        write(["status": "running", "stage": "pairing"])
        var stage = "pairing"
        func advanceStage(_ name: String) { stage = name; write(["status": "running", "stage": name]) }
        do {
            let analysisURL = dir.appendingPathComponent("analysis-fixture.wav")
            let format = AVAudioFormat(standardFormatWithSampleRate: 22050, channels: 1)!
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 22050 * 12)!
            buffer.frameLength = buffer.frameCapacity
            for i in 0..<Int(buffer.frameLength) { let time = Double(i) / 22050; buffer.floatChannelData![0][i] = Float(sin(2 * Double.pi * 220 * time) * 0.3 * (0.1 + exp(-time.truncatingRemainder(dividingBy: 0.5) * 15))) }
            do { let file = try AVAudioFile(forWriting: analysisURL, settings: format.settings); try file.write(from: buffer) }
            guard let profile = try await SoundAnalyzer.decode(analysisURL), profile.isValid, profile.tempoConfidence > 0.3, profile.brightness < 0.1 else { throw SyncError.rejected("Native PCM decoder did not produce valid real-audio features") }
            try? FileManager.default.removeItem(at: analysisURL)
            let args = ProcessInfo.processInfo.arguments
            guard let index = args.firstIndex(of: "--forma-pair-code"), args.count > index + 1 else { throw SyncError.invalidCode }
            let sync = SyncClient()
            var invalid = URLComponents(string: args[index + 1])!
            invalid.queryItems = invalid.queryItems?.map { $0.name == "pin" ? URLQueryItem(name: "pin", value: String(repeating: "0", count: 64)) : $0 }
            var rejectedWrongPin = false
            do { try await sync.pair(invalid.string!) } catch { rejectedWrongPin = true }
            guard rejectedWrongPin else { throw SyncError.rejected("Wrong certificate pin was accepted") }
            try await sync.pair(args[index + 1])
            advanceStage("first-sync")
            guard let connection = await sync.connection else { throw SyncError.rejected("Connection missing") }
            let firstCheckpoint = WiFiCheckpoint(peerID: connection.pin, sent: Library(), base: nil)
            let firstPreview = try await sync.prepare(firstCheckpoint)
            guard firstPreview.status == .pending, firstPreview.library == nil else { throw SyncError.rejected("Draft applied without approval") }
            var library = try firstCheckpoint.mergingApproved(try await sync.approve(firstCheckpoint.id), into: Library())
            try await sync.acknowledge(firstCheckpoint.id)
            guard library.tracks.count >= 4, library.likedIDs.count == 1 else { throw SyncError.rejected("Initial PC library failed") }
            let base = library
            advanceStage("second-sync")
            library.likedIDs = []; library.playlists.append(Playlist(id: "phone-playlist", name: "На iPhone", trackIDs: Array(library.tracks.keys.sorted().prefix(2))))
            library.settings.artistDiversity = 1
            let secondCheckpoint = WiFiCheckpoint(peerID: connection.pin, sent: library, base: base)
            let secondPreview = try await sync.prepare(secondCheckpoint)
            guard secondPreview.status == .pending, secondPreview.summary.toPC.playlistsAdded == 1 else { throw SyncError.rejected("Bidirectional preview failed") }
            let merged = try secondCheckpoint.mergingApproved(try await sync.approve(secondCheckpoint.id), into: library)
            try await sync.acknowledge(secondCheckpoint.id)
            try await sync.acknowledge(secondCheckpoint.id)
            guard merged.likedIDs.isEmpty, merged.playlists.contains(where: { $0.id == "phone-playlist" }), merged.settings.artistDiversity == 1 else { throw SyncError.rejected("Bidirectional PC sync failed") }
            advanceStage("native-playback")
            let tracks = merged.tracks.values.sorted { $0.id < $1.id }.map { track -> Track in var next = track; next.duration = 5; return next }
            let recoveryAudio = try await fixtureResolver.resolve(videoID: tracks[0].id, forceRefresh: false)
            guard let slowIndex = args.firstIndex(of: "--forma-slow-audio"), args.count > slowIndex + 1,
                  let slowURL = URL(string: args[slowIndex + 1]) else { throw SyncError.rejected("Slow audio fixture missing") }
            advanceStage("playback-boundaries")
            let stability = try await checkBoundaries(model: model, tracks: tracks, audio: recoveryAudio, slowURL: slowURL)
            advanceStage("three-track-preroll")
            let preparation = try await checkThreeTrackPreroll(audio: recoveryAudio, slowURL: slowURL)
            advanceStage("native-playback")
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
            let coldSamples = player.measurements.count
            model.play(tracks[0], list: tracks)
            // Current extraction takes 500ms. Wait for the second track's real AVPlayerItem.
            for _ in 0..<100 {
                if player.debugPreparedTrackID == tracks[1].id { break }
                try await Task.sleep(nanoseconds: 30_000_000)
            }
            guard player.debugPreparedTrackID == tracks[1].id else { throw SyncError.rejected("Next track was not prepared immediately") }
            guard let cold = player.measurements.dropFirst(coldSamples).first, cold.totalMilliseconds < 2500 else { throw SyncError.rejected("Controlled cold playback exceeded 2.5 seconds: \(player.debugPlaybackState)") }
            let coldStartMilliseconds = cold.totalMilliseconds
            guard let exposure = model.library.events.last(where: { $0.trackID == tracks[0].id && $0.kind == .play }),
                  exposure.recommendation?.isValid == true, exposure.surface == "manual" else { throw SyncError.rejected("Native start lost its recommendation context") }
            let feedbackStart = model.library.events.count
            model.toggleLike(tracks[0]); model.toggleLike(tracks[0])
            model.createPlaylist("Learning fixture")
            guard let learningPlaylist = model.library.playlists.last else { throw SyncError.rejected("Learning playlist missing") }
            model.add(tracks[0], to: learningPlaylist.id)
            // The preceding stability scenarios intentionally generated playlist
            // feedback too. Check only these two new reactions, and compare every
            // snapshot instead of filtering away an incorrect one.
            let explicit = model.library.events.dropFirst(feedbackStart).filter { $0.trackID == tracks[0].id && ($0.kind == .like || $0.kind == .playlistAdd) }
            guard explicit.count == 2, explicit.allSatisfy({ $0.reward == 1 && $0.recommendation == exposure.recommendation }) else { throw SyncError.rejected("Like/playlist snapshot failed: \(explicit.count) reactions, \(explicit.filter { $0.recommendation == exposure.recommendation }.count) match selection") }
            let callsBefore = await fixtureResolver.calls[tracks[1].id]
            let switchSamples = player.measurements.count
            let switchedAt = ProcessInfo.processInfo.systemUptime
            model.play(tracks[1], list: tracks)
            let switchDelay = ProcessInfo.processInfo.systemUptime - switchedAt
            guard player.current?.id == tracks[1].id, switchDelay < 0.2 else { throw SyncError.rejected("Manual next-track reuse failed") }
            for _ in 0..<25 {
                if player.measurements.count > switchSamples { break }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            guard let warmed = player.measurements.dropFirst(switchSamples).last, ["prepared", "buffered"].contains(warmed.source), warmed.totalMilliseconds < 250 else { throw SyncError.rejected("Prepared playback exceeded 250ms: \(player.debugPlaybackState); sample=\(player.measurements.dropFirst(switchSamples).last?.totalMilliseconds ?? -1)") }
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
            advanceStage("native-design-audit")
            let design = try await NativeDesignAudit.run(model: model)
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
            player.onStarted = { starts.append($0.id); write(["status": "running", "stage": "playing", "realPCMAnalysis": true, "nativeStarts": starts.count]) }; player.onFeedback = { feedback.append($0) }
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
            var final: [String: Any] = ["status": "passed", "realPCMAnalysis": true, "nativeStarts": starts.count, "automaticTransitions": feedback.count, "background": background, "pinnedTLS": true, "wrongPinRejected": rejectedWrongPin, "bidirectionalSync": true, "wifiApprovalRequired": true, "pauseResume": true, "miniPlayerAboveTabs": true, "miniPlayerBottom": miniFrame.maxY, "tabBarTop": barFrame.minY, "preparedManualSwitchMilliseconds": switchDelay * 1000, "preparedStreamReused": true, "controlledColdStartMilliseconds": coldStartMilliseconds, "preparedPlayingMilliseconds": preparedPlayingMilliseconds, "startupTimeoutRecovered": true, "recommendationSnapshotCaptured": true, "explicitLearningFeedbackCaptured": true, "networkHandoffRecovered": true, "oldNetworkPreparedItemDiscarded": true, "networkRecoveryRespectsPause": true]
            final["threeTracksPreparedOnCellular"] = true; final["mutedPrerollReusedWithoutExtraction"] = true; final["bufferedThirdTrackMilliseconds"] = preparation.ready
            final["parallelPreparation"] = true; final["pendingBufferTransferred"] = true
            final["pendingBufferStartMilliseconds"] = preparation.pending; final["threeTrackPreparationMilliseconds"] = preparation.window
            stability.forEach { final[$0.key] = $0.value }; design.forEach { final[$0.key] = $0.value }; write(final)
            player.pause()
        } catch { let failure = error as NSError; write(["status": "failed", "stage": stage, "error": error.localizedDescription, "domain": failure.domain, "code": failure.code, "taskCancelled": Task.isCancelled]) }
    }
    private static func checkThreeTrackPreroll(audio: ResolvedAudio, slowURL: URL) async throws -> (ready: Double, pending: Double, window: Double) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("forma-preroll-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let input = try AVAudioFile(forReading: audio.url)
        let buffer = AVAudioPCMBuffer(pcmFormat: input.processingFormat, frameCapacity: AVAudioFrameCount(input.length))!
        try input.read(into: buffer)
        let longURL = folder.appendingPathComponent("warm0000000.wav")
        do { let output = try AVAudioFile(forWriting: longURL, settings: input.processingFormat.settings); for _ in 0..<8 { try output.write(from: buffer) } }
        let secondURL = folder.appendingPathComponent("warm0000001.wav"); try FileManager.default.copyItem(at: longURL, to: secondURL)
        let tracks = (0..<4).map { Track(videoID: "warm000000\($0)", title: "Preroll \($0)", artist: "Fixture") }
        var urls = [tracks[0].id: longURL, tracks[1].id: secondURL]
        for track in tracks.dropFirst(2) { var components = URLComponents(url: slowURL, resolvingAgainstBaseURL: false)!; components.queryItems = [URLQueryItem(name: "video", value: track.id)]; urls[track.id] = components.url! }
        let resolver = PrerollFixtureResolver(urls: urls), player = PlaybackController(resolver: resolver)
        defer { player.pause() }
        for _ in 0..<100 { if player.networkPolicy.known { break }; try await Task.sleep(nanoseconds: 20_000_000) }
        player.debugNetworkChanged(NetworkPolicy(reachable: true, cellular: true, expensive: true, constrained: true), signature: "preroll-cellular-VPN")
        try await Task.sleep(nanoseconds: 450_000_000)
        player.setPreparationDepth(3); let preparationBegan = ProcessInfo.processInfo.systemUptime
        player.play(tracks[0], list: tracks)
        var parallelObserved = false
        for _ in 0..<1500 {
            if player.debugWarmingTrackIDs.isSuperset(of: Set(tracks.dropFirst(2).map(\.id))) { parallelObserved = true }
            if player.debugPreparedTrackID == tracks[1].id, player.debugBufferedTrackIDs == Set(tracks.dropFirst().map(\.id)) { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let preparationMilliseconds = (ProcessInfo.processInfo.systemUptime - preparationBegan) * 1000
        guard parallelObserved else { throw SyncError.rejected("Slow second/third audio was still prepared serially") }
        guard player.debugPreparedTrackID == tracks[1].id, player.debugBufferedTrackIDs == Set(tracks.dropFirst().map(\.id)), player.debugExtraPlayersMuted else { throw SyncError.rejected("Three-track muted preparation failed: \(player.debugBufferedTrackIDs); \(player.debugPlaybackState)") }
        let before = await resolver.calls[tracks[3].id], sampleCount = player.measurements.count
        player.play(tracks[3], list: tracks)
        for _ in 0..<100 { if player.measurements.count > sampleCount { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        guard let sample = player.measurements.dropFirst(sampleCount).last, sample.source == "buffered", sample.totalMilliseconds < 350, player.isPlaying else { throw SyncError.rejected("Third track buffer was not reused: \(player.measurements.last?.totalMilliseconds ?? -1) ms; \(player.debugPlaybackState)") }
        let after = await resolver.calls[tracks[3].id]; guard before == after else { throw SyncError.rejected("Buffered third track repeated extraction") }
        player.pause(); player.debugNetworkChanged(NetworkPolicy(reachable: true), signature: "preroll-new-wifi")
        guard player.debugBufferedTrackIDs.isEmpty else { throw SyncError.rejected("Old-network preroll cache survived handoff") }
        // Select the third track while its HTTP body is still withheld. The
        // foreground player must retain the partially downloaded asset; a late
        // completion/cancellation of its old warmer must not clear active audio.
        var partialURLs = urls
        for track in tracks.dropFirst(2) {
            var components = URLComponents(url: urls[track.id]!, resolvingAgainstBaseURL: false)!
            components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "phase", value: "transfer")]
            partialURLs[track.id] = components.url!
        }
        let partialResolver = PrerollFixtureResolver(urls: partialURLs), partial = PlaybackController(resolver: partialResolver)
        defer { partial.pause() }
        for _ in 0..<100 { if partial.networkPolicy.known { break }; try await Task.sleep(nanoseconds: 20_000_000) }
        partial.debugNetworkChanged(NetworkPolicy(reachable: true, cellular: true, expensive: true, constrained: true), signature: "partial-cellular-VPN")
        try await Task.sleep(nanoseconds: 450_000_000)
        partial.setPreparationDepth(3); partial.play(tracks[0], list: tracks)
        for _ in 0..<250 {
            if partial.debugWarmingTrackIDs.contains(tracks[3].id) { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        guard let owner = partial.debugWarmingPlayerIdentity(tracks[3].id) else { throw SyncError.rejected("Partial third buffer was not prepared") }
        let partialBefore = await partialResolver.calls[tracks[3].id], partialSamples = partial.measurements.count
        partial.play(tracks[3], list: [tracks[3]])
        for _ in 0..<600 {
            if partial.measurements.count > partialSamples { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let partialAfter = await partialResolver.calls[tracks[3].id]
        guard partial.debugPlayerIdentity == owner, partialBefore == partialAfter,
              partial.isPlaying, let pending = partial.measurements.dropFirst(partialSamples).last,
              pending.source == "buffered" else { throw SyncError.rejected("Partial buffer was discarded or its old warmer interrupted foreground audio: \(partial.debugPlaybackState)") }
        return (sample.totalMilliseconds, pending.totalMilliseconds, preparationMilliseconds)
    }
    private static func checkBoundaries(model: AppModel, tracks: [Track], audio: ResolvedAudio, slowURL: URL) async throws -> [String: Bool] {
        func until(_ label: String, diagnostic: () -> String = { "" }, _ condition: () async -> Bool) async throws {
            for _ in 0..<300 {
                if await condition() { return }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            throw SyncError.rejected("Playback boundary \(label) timed out: \(diagnostic())")
        }
        // Pause an actual AVPlayerItem while its HTTP WAV body is withheld. A new
        // resume must re-arm the buffer deadline, rather than spinning forever.
        let bufferPlayer = PlaybackController(resolver: ConstantFixtureResolver(audio: ResolvedAudio(debugFixture: slowURL)), bufferTimeout: 0.3)
        bufferPlayer.play(tracks[0], list: [tracks[0]])
        try await until("buffer-item-created") { bufferPlayer.debugHasPlayerItem }
        guard bufferPlayer.isLoading, bufferPlayer.error == nil else { throw SyncError.rejected("Controlled slow stream did not enter buffering") }
        bufferPlayer.pause(); try await Task.sleep(nanoseconds: 500_000_000)
        guard bufferPlayer.error == nil, !bufferPlayer.isLoading else { throw SyncError.rejected("Paused startup produced a timeout/spinner") }
        bufferPlayer.resume(); try await until("resume-buffer-deadline", diagnostic: { "loading=\(bufferPlayer.isLoading), playing=\(bufferPlayer.isPlaying), position=\(bufferPlayer.position), item=\(bufferPlayer.debugHasPlayerItem)" }) { bufferPlayer.error != nil }
        guard !bufferPlayer.isLoading else { throw SyncError.rejected("Resume never released the buffering spinner") }
        bufferPlayer.pause()

        let interruptions = HandoffFixtureResolver(audio: audio)
        let interruptedPlayer = PlaybackController(resolver: interruptions, extractionTimeout: 0.1, bufferTimeout: 3)
        var starts = 0, feedback = 0
        interruptedPlayer.onStarted = { _ in starts += 1 }; interruptedPlayer.onFeedback = { _ in feedback += 1 }
        interruptedPlayer.play(tracks[0], list: [tracks[0]])
        try await until("interruption-extraction-started") { await interruptions.calls == 1 }
        interruptedPlayer.debugInterruption(began: true)
        try await Task.sleep(nanoseconds: 400_000_000)
        guard interruptedPlayer.error == nil, !interruptedPlayer.isPlaying else { throw SyncError.rejected("A call caused a false startup failure") }
        interruptedPlayer.debugInterruption(began: false)
        try await until("interruption-or-reset-playing", diagnostic: { interruptedPlayer.error ?? "loading=\(interruptedPlayer.isLoading)" }) { interruptedPlayer.isPlaying }
        interruptedPlayer.pause()
        interruptedPlayer.debugInterruption(began: true); interruptedPlayer.debugInterruption(began: false)
        try await Task.sleep(nanoseconds: 100_000_000)
        guard !interruptedPlayer.isPlaying else { throw SyncError.rejected("Interruption end overrode manual pause") }
        interruptedPlayer.debugMediaServicesReset()
        guard !interruptedPlayer.isPlaying, interruptedPlayer.current?.id == tracks[0].id else { throw SyncError.rejected("Audio reset lost paused selection") }
        interruptedPlayer.resume(); try await until("interruption-or-reset-playing", diagnostic: { interruptedPlayer.error ?? "loading=\(interruptedPlayer.isLoading)" }) { interruptedPlayer.isPlaying }
        guard starts == 1, feedback == 0 else { throw SyncError.rejected("Audio recovery created duplicate taste feedback") }
        interruptedPlayer.debugMediaServicesLost()
        try await Task.sleep(nanoseconds: 400_000_000)
        guard !interruptedPlayer.isPlaying, interruptedPlayer.error == nil else { throw SyncError.rejected("Media services loss produced a false playback failure") }
        interruptedPlayer.debugMediaServicesReset()
        try await until("media-loss-reset-playing") { interruptedPlayer.isPlaying }
        guard starts == 1, feedback == 0 else { throw SyncError.rejected("Media services recovery duplicated history") }
        interruptedPlayer.pause()

        let rapid = HandoffFixtureResolver(audio: audio), rapidPlayer = PlaybackController(resolver: rapid)
        var rapidStarts: [String] = []
        rapidPlayer.onStarted = { rapidStarts.append($0.id) }
        rapidPlayer.play(tracks[0], list: [tracks[0]])
        try await until("rapid-first-started") { await rapid.calls == 1 }
        rapidPlayer.play(tracks[1], list: [tracks[1]])
        try await until("rapid-current-playing", diagnostic: { rapidPlayer.error ?? "loading=\(rapidPlayer.isLoading)" }) { rapidPlayer.isPlaying }
        let cancelled = await rapid.cancelled
        guard rapidPlayer.current?.id == tracks[1].id, rapidStarts == [tracks[1].id], cancelled == 1 else { throw SyncError.rejected("Rapid selection kept old playback alive") }
        rapidPlayer.pause()

        let queuePlayer = PlaybackController(resolver: fixtureResolver)
        queuePlayer.play(tracks[0], list: tracks)
        try await until("queue-race-prepared") { queuePlayer.debugPreparedTrackID == tracks[1].id }
        queuePlayer.debugAdvanceEngine()
        queuePlayer.play(tracks[1], list: [tracks[1], tracks[3]])
        try await until("advanced-queue-updated") { queuePlayer.debugPreparedTrackID == tracks[3].id }
        guard queuePlayer.current?.id == tracks[1].id else { throw SyncError.rejected("Already-advanced queue ignored manual selection") }
        queuePlayer.pause()

        try await until("library-restored") { !model.isRestoringLibrary }
        let slowSearch = Task { await model.search("slow") }
        try await until("slow-search-started") { await fixtureCatalog.slowSearchStarted }
        await model.search("fast"); await slowSearch.value
        guard model.searchResults.map(\.id) == [tracks[1].id], !model.isSearching else { throw SyncError.rejected("Stale search result replaced the latest query") }
        let cancelledSearch = Task { await model.search("cancel") }
        try await until("cancelled-search-started") { await fixtureCatalog.uncancellableSearchStarted }
        cancelledSearch.cancel(); await cancelledSearch.value
        guard !model.isSearching, model.searchResults.map(\.id) == [tracks[1].id] else { throw SyncError.rejected("Cancelled search left a spinner or replaced existing results") }
        guard model.recentSearchResults.map(\.id) == [tracks[1].id], model.popularSearchResults.map(\.id) == [tracks[1].id] else { throw SyncError.rejected("Search columns lost independent results") }
        let artistTracks = try await model.tracksForArtist(tracks[1])
        guard artistTracks.contains(where: { $0.id == tracks[1].id }) else { throw SyncError.rejected("Artist navigation returned no songs") }
        model.startTrackPulse(tracks[1])
        try await until("track-pulse-playing") { model.player.isPlaying && model.player.current?.id == tracks[1].id }
        guard model.pulseTrackID == tracks[1].id, !model.isPersonalPulse else { throw SyncError.rejected("Track Pulse lost its seed") }
        model.play(tracks[3], list: [tracks[3]])
        try await Task.sleep(nanoseconds: 200_000_000)
        guard model.pulseTrackID == nil, model.player.current?.id == tracks[3].id else { throw SyncError.rejected("Delayed track Pulse replaced manual playback") }
        let link = Task { await model.openYouTube("abcdefghijk") }
        try await until("link-description-started") { await fixtureCatalog.descriptionStarted }
        model.play(tracks[3], list: [tracks[3]]); await link.value
        try await until("model-selection-playing", diagnostic: { model.player.error ?? "loading=\(model.player.isLoading)" }) { model.player.isPlaying }
        guard model.player.current?.id == tracks[3].id, model.message == nil else { throw SyncError.rejected("Old link metadata overrode manual selection") }
        model.createPlaylist("Race fixture")
        guard let playlist = model.library.playlists.last else { throw SyncError.rejected("Pulse fixture playlist missing") }
        model.add(tracks[0], to: playlist.id); model.add(tracks[1], to: playlist.id)
        model.startPulse(playlistID: playlist.id); model.play(tracks[2], list: [tracks[2]])
        try await until("model-selection-playing", diagnostic: { model.player.error ?? "loading=\(model.player.isLoading)" }) { model.player.isPlaying }
        try await Task.sleep(nanoseconds: 200_000_000)
        guard model.player.current?.id == tracks[2].id, model.player.selectionSurface == "manual" else { throw SyncError.rejected("Delayed Pulse ranking overrode manual playback") }
        model.player.pause(); model.deletePlaylist(playlist.id)
        // Independent recordings keep this scenario from consuming the cold-start
        // fixture's repeat-cooldown slot used later by the learning assertion.
        let homeProbe = Track(videoID: "homeprobe01", title: "Проверка главной", artist: "Home probe", duration: 5, genres: ["House"], genre: "House")
        let moodProbe = Track(videoID: "moodprobe01", title: "Проверка настроения", artist: "Mood probe", duration: 5, genres: ["House"], genre: "House", mood: "calm")
        model.playRecommendation(homeProbe)
        try await until("home-recommendation-playing") { model.player.isPlaying }
        guard model.player.current?.id == homeProbe.id, model.player.selectionSurface == "pulse", model.player.selectionMood == nil, model.isPersonalPulse else { throw SyncError.rejected("Home recommendation row lost adaptive Pulse context") }
        model.playRecommendation(moodProbe, mood: "calm")
        try await until("mood-recommendation-playing") { model.player.isPlaying }
        guard model.player.current?.id == moodProbe.id, model.player.selectionSurface == "mood", model.player.selectionMood == "calm", !model.isPersonalPulse else { throw SyncError.rejected("Mood recommendation row lost adaptive mood context") }
        model.player.pause()

        let reject = Track(videoID: "rejectone01", title: "Первый трек", artist: "Первый исполнитель", duration: 5)
        let following = Track(videoID: "rejecttwo01", title: "Следующий трек", artist: "Другой исполнитель", duration: 5)
        let other = Track(videoID: "rejectlib01", title: "Трек из библиотеки", artist: "Третий исполнитель", duration: 5)
        model.play(reject, list: [reject, following, other])
        try await until("dislike-fixture-playing") { model.player.isPlaying }
        try await Task.sleep(nanoseconds: 3_100_000_000)
        let eventCount = model.library.events.filter { $0.trackID == reject.id && ($0.kind == .skip || $0.kind == .listen) }.count
        model.toggleDislike(reject)
        try await until("dislike-advances-current-track") { model.player.current?.id == following.id && model.player.isPlaying }
        guard model.isDisliked(reject), model.library.events.filter({ $0.trackID == reject.id && $0.kind == .dislike }).count == 1,
              model.library.events.filter({ $0.trackID == reject.id && ($0.kind == .skip || $0.kind == .listen) }).count == eventCount else {
            throw SyncError.rejected("Dislike did not advance once with exactly one negative signal")
        }
        model.toggleDislike(reject)
        guard !model.isDisliked(reject), model.player.current?.id == following.id else { throw SyncError.rejected("Undo dislike interrupted playback") }
        model.toggleDislike(other)
        guard model.isDisliked(other), model.player.current?.id == following.id else { throw SyncError.rejected("Rating a library track interrupted playback") }
        model.toggleDislike(other); model.player.pause()

        // Exhaust the synchronous radio cache repeatedly. Awaiting retrieval must
        // continue Pulse while preserving pause and subsequent manual selections.
        let radio = PlaybackController(resolver: ConstantFixtureResolver(audio: audio))
        var fetched = 0
        radio.pulseNext = { _, _ in nil }
        radio.pulseRefill = { excluded, _ in
            try? await Task.sleep(nanoseconds: 120_000_000)
            fetched += 1
            let song = Track(videoID: String(format: "r%010d", fetched), title: "Открытие \(fetched)", artist: "Новый \(fetched)", duration: 5)
            return excluded.contains(song.id) ? nil : song
        }
        radio.startPulse(tracks[0])
        try await until("infinite-pulse-start") { radio.isPlaying }
        for round in 1...12 {
            radio.next()
            try await until("infinite-pulse-page-\(round)") { radio.isPlaying && radio.current?.id == String(format: "r%010d", round) }
            guard radio.error == nil, !radio.isWaitingForPulse else { throw SyncError.rejected("Pulse became a finite queue") }
        }
        let readyDuringWait = Track(videoID: "cachewake01", title: "Готовое продолжение", artist: "Новый артист", duration: 5)
        var cacheReady = false
        radio.pulseNext = { excluded, _ in cacheReady && !excluded.contains(readyDuringWait.id) ? readyDuringWait : nil }
        radio.pulseRefill = { _, _ in try? await Task.sleep(nanoseconds: 2_000_000_000); return tracks[1] }
        radio.next(); guard radio.isWaitingForPulse else { throw SyncError.rejected("Pulse did not enter refill state") }
        cacheReady = true; radio.pulseCandidatesChanged()
        try await until("new-cache-wakes-waiting-pulse") { radio.isPlaying && radio.current?.id == readyDuringWait.id }
        radio.pulseNext = { _, _ in nil }
        radio.pulseRefill = { _, _ in
            // Deliberately ignores cancellation to exercise the generation guard.
            try? await Task.sleep(nanoseconds: 500_000_000)
            return tracks[1]
        }
        let beforePause = radio.current?.id
        radio.next(); guard radio.isWaitingForPulse else { throw SyncError.rejected("Empty Pulse did not await a page") }
        radio.pause(); try await Task.sleep(nanoseconds: 600_000_000)
        guard !radio.isPlaying, !radio.isLoading, radio.current?.id == beforePause else { throw SyncError.rejected("Late discovery undid pause") }
        radio.resume()
        try await until("pulse-resume-after-pause") { radio.isPlaying && radio.current?.id == tracks[1].id }
        radio.next(); radio.play(tracks[3], list: [tracks[3]])
        try await until("manual-selection-during-pulse-refill") { radio.isPlaying && radio.current?.id == tracks[3].id }
        try await Task.sleep(nanoseconds: 600_000_000)
        guard radio.current?.id == tracks[3].id, radio.selectionSurface == "manual" else { throw SyncError.rejected("Late discovery replaced manual selection") }
        radio.pause()

        let tasteProbe = Track(videoID: "tasteprobe1", title: "Опора вкуса", artist: "Источник вкуса", duration: 5, genre: "House")
        model.toggleLike(tasteProbe)
        await fixtureCatalog.usePages(true)
        let originalNext = model.player.pulseNext
        model.player.pulseNext = { _, _ in nil }
        model.playRecommendation(tasteProbe)
        try await until("app-model-radio-start") { model.player.isPlaying && model.player.current?.id == tasteProbe.id }
        for round in 0..<4 {
            let previous = model.player.current?.id
            model.player.next()
            try await until("app-model-page-refill-\(round)", diagnostic: { model.player.error ?? model.player.debugPlaybackState }) {
                model.player.isPlaying && model.player.current?.id != previous && model.player.current?.id.hasPrefix("p") == true
            }
        }
        guard model.discoveredPages > 0 else { throw SyncError.rejected("AppModel never fetched discovery pages") }
        model.player.pause(); model.player.pulseNext = originalNext
        await fixtureCatalog.usePages(false)
        model.toggleLike(tasteProbe)

        model.play(following, list: [following])
        try await until("last-queue-track-playing") { model.player.isPlaying }
        model.player.seek(to: 4.6)
        try await until("queue-naturally-ended") { model.player.error != nil && !model.player.isPlaying && !model.player.isLoading }
        model.player.resume()
        try await until("ended-queue-restarts-from-beginning", diagnostic: { model.player.debugPlaybackState }) {
            model.player.isPlaying && model.player.position < 1
        }
        model.player.pause()

        let storageURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("library.json")
        defer { try? FileManager.default.removeItem(at: storageURL.deletingLastPathComponent()) }
        let storage = LibraryStorage(url: storageURL)
        var older = Library(); older.likedIDs = [tracks[0].id]
        var newer = older; newer.likedIDs.append(tracks[1].id)
        try await storage.save(newer, revision: 2); try await storage.save(older, revision: 1)
        let durable = try await storage.load()
        guard durable.library.likedIDs == newer.likedIDs else { throw SyncError.rejected("Old queued save overwrote a newer library") }
        try await storage.saveSyncBase(older, peerID: "peer-A")
        let matching = await storage.syncBase(peerID: "peer-A"), wrong = await storage.syncBase(peerID: "peer-B")
        guard matching?.likedIDs == older.likedIDs, wrong == nil else { throw SyncError.rejected("Sync baseline crossed paired PC identities") }
        try JSONEncoder().encode(older).write(to: storageURL.appendingPathExtension("sync-base"), options: .atomic)
        let legacy = await storage.syncBase(peerID: "peer-A", allowLegacy: true), rePaired = await storage.syncBase(peerID: "peer-B")
        guard legacy?.likedIDs == older.likedIDs, rePaired == nil else { throw SyncError.rejected("Legacy baseline attached to a newly paired PC") }
        let keychain = TransientKeychainProbe(), client = SyncClient(readConnection: { keychain.read() })
        let unavailable = await client.restore(), restored = await client.restore(), cached = await client.restore()
        guard unavailable == nil, restored?.host == "10.0.0.2", cached?.host == restored?.host, keychain.count == 2 else { throw SyncError.rejected("Temporary Keychain failure permanently lost the paired PC") }
        return ["resumeBufferDeadlineRearmed": true, "pausedLoadingNoSpinner": true, "interruptionRecovered": true,
                "interruptionRespectsPause": true, "mediaServicesResetRecovered": true, "mediaServicesLossRecovered": true, "recoveryNoDuplicateFeedback": true,
                "rapidSelectionCancelsOldLoad": true, "staleSearchIgnored": true, "staleLinkIgnored": true, "stalePulseIgnored": true, "homeRowsStartAdaptivePulse": true, "moodRowsKeepAdaptiveContext": true,
                "oldSaveCannotOverwriteNewerLibrary": true, "syncBaselineBoundToPairedPC": true, "legacyBaselineMigratedSafely": true,
                "advancedQueueMatchesNewList": true, "keychainRestoreRetriesTransientFailure": true, "cancelledSearchClearsSpinner": true,
                "dislikeAdvancesWithSingleSignal": true, "undoAndLibraryDislikeKeepPlayback": true, "personalPulseDistinctFromMood": true,
                "endedQueueRestartsFromBeginning": true, "waitingPulseUsesNewCacheImmediately": true, "appModelRetrievalRefillsPlayingPulse": true, "pulseRefillsTwelveRemotePages": true, "pulseRefillRespectsPause": true, "pulseRefillRespectsManualSelection": true]
    }
}
#endif
