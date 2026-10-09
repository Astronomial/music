import AVFoundation
import Combine
import Foundation
import MediaPlayer
import Network
import UIKit
import FormaCore

@MainActor
final class PlaybackController: ObservableObject {
    @Published private(set) var current: Track?
    @Published private(set) var isPlaying = false
    @Published private(set) var isLoading = false
    @Published private(set) var position: Double = 0
    @Published private(set) var duration: Double = 0
    @Published private(set) var error: String?
    @Published private(set) var measurements: [PlaybackMeasurement] = []
    private var startTiming: (at: TimeInterval, wall: Date, resolved: TimeInterval?, source: String)?
    @Published var volume: Float = 0.7 { didSet { engine.volume = volume } }
    var onStarted: ((Track) -> Void)?
    private var startedID: String?
    private var interrupted = false
    private var preparationToken = UUID()
    private var lastNowPlayingUpdate: TimeInterval = 0
    var onFeedback: ((ListeningEvent) -> Void)?
    var pulseNext: ((Set<String>, String?) -> Track?)?
    private let engine = AVQueuePlayer()
    private let resolver: any StreamResolving
    private let network = NWPathMonitor()
    private var task: Task<Void, Never>?
    private var prefetch: Task<Void, Never>?
    private var prefetchedCurrent: String?
    private var prepared: (track: Track, item: AVPlayerItem, audio: ResolvedAudio)?
    private var currentObservation: NSKeyValueObservation?
    private var preparing = false
    private var failedCandidates: Set<String> = []
    private var periodic: Any?
    private var statusObservation: NSKeyValueObservation?
    private var itemObservation: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?
    private var systemObservers: [NSObjectProtocol] = []
    private var remoteTargets: [(MPRemoteCommand, Any)] = []
    private var generation = UUID()
    private var clock = ConsumptionClock()
    private var queue: [Track] = []
    private var playedInRun: Set<String> = []
    private var pulseMode = false
    private var mood: String?
    private var requestedPlayback = false
    private var seeking = false
    private var retryCount = 0
    private var artwork: MPMediaItemArtwork?
    private var artworkTask: Task<Void, Never>?
    private var networkSignature: String?

    init(resolver: any StreamResolving = YouTubeStreamResolver()) {
        self.resolver = resolver
        engine.volume = volume
        // AAC can start with a small buffer; AVPlayer's conservative wait can take seconds.
        engine.automaticallyWaitsToMinimizeStalling = false
        periodic = engine.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        statusObservation = engine.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in
                guard let self else { return }
                self.adoptPreparedItem()
                self.isPlaying = self.engine.timeControlStatus == .playing
                if self.isPlaying { self.isLoading = false; self.markStarted() }
                self.updateNowPlaying()
            }
        }
        engine.actionAtItemEnd = .advance
        currentObservation = engine.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.adoptPreparedItem() }
        }
        installRemoteCommands()
        installAudioEvents()
        network.pathUpdateHandler = { [weak self] path in
            let signature = "\(path.status)|\(path.usesInterfaceType(.wifi))|\(path.usesInterfaceType(.cellular))|\(path.usesInterfaceType(.wiredEthernet))"
            Task { @MainActor in
                guard let self else { return }
                let previous = self.networkSignature; self.networkSignature = signature
                // Initial monitor delivery must not cancel the first track's extraction.
                if let previous, previous != signature { await self.resolver.invalidate() }
            }
        }
        network.start(queue: DispatchQueue(label: "music.forma.network"))
    }
    deinit {
        task?.cancel(); prefetch?.cancel(); artworkTask?.cancel(); network.cancel()
        if let periodic { engine.removeTimeObserver(periodic) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        for observer in systemObservers { NotificationCenter.default.removeObserver(observer) }
        for (command, target) in remoteTargets { command.removeTarget(target) }
    }
    func play(_ track: Track, list: [Track]? = nil, asPulse: Bool = false, context: String? = nil) {
        // AVQueuePlayer may have advanced before its asynchronous KVO callback arrives.
        let alreadyAdvanced = prepared.map { $0.track.id == track.id && engine.currentItem === $0.item } ?? false
        adoptPreparedItem()
        finish(.skip)
        if let list {
            queue = Array(list.drop { $0.id != track.id }.dropFirst())
            pulseMode = asPulse; mood = context; playedInRun = []
        }
        if alreadyAdvanced { resume(); return }
        if let ready = prepared, ready.track.id == track.id, ready.audio.isFresh(margin: 15), ready.item.status != .failed, engine.items().contains(ready.item) {
            beginTiming(source: "prepared")
            requestedPlayback = true; engine.advanceToNextItem(); adoptPreparedItem()
            if !interrupted { engine.play() }; return
        }
        start(track)
    }
    func startPulse(_ track: Track, mood: String? = nil) {
        play(track, list: [track], asPulse: true, context: mood)
    }
    private func start(_ track: Track, at seconds: Double = 0, refreshing: Bool = false) {
        if !refreshing || startTiming == nil { beginTiming(source: "network") }
        task?.cancel(); prefetch?.cancel(); artworkTask?.cancel()
        prefetchedCurrent = nil; failedCandidates = []
        let token = UUID(); generation = token
        engine.pause(); engine.removeAllItems(); prepared = nil; preparing = false
        current = track; if !refreshing { startedID = nil }; position = seconds; duration = track.duration
        if !refreshing { clock.reset() }; seeking = false; error = nil; isLoading = true; isPlaying = false; requestedPlayback = true
        if !refreshing { retryCount = 0; artwork = nil; loadArtwork(for: track) }
        updateNowPlaying()
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let resolved = try await resolver.resolve(videoID: track.id, forceRefresh: refreshing)
                try Task.checkCancellation()
                guard generation == token else { return }
                if var timing = startTiming {
                    timing.resolved = ProcessInfo.processInfo.systemUptime
                    if resolved.resolvedAt < timing.wall { timing.source = "cached" }
                    startTiming = timing
                }
                let item = AVPlayerItem(url: resolved.url)
                item.preferredForwardBufferDuration = 3
                observe(item, token: token)
                engine.insert(item, after: nil)
                if seconds > 0 { await engine.seek(to: CMTime(seconds: seconds, preferredTimescale: 600)) }
                guard generation == token, !Task.isCancelled else { return }
                if requestedPlayback, !interrupted { try activateAudio(); engine.play() }
                updateNowPlaying()
            } catch is CancellationError { }
            catch {
                guard generation == token, !Task.isCancelled else { return }
                fail(error)
            }
        }
    }
    func toggle() { requestedPlayback ? pause() : resume() }
    func pause() { startTiming = nil; requestedPlayback = false; engine.pause(); isPlaying = false; updateNowPlaying() }
    func resume() {
        guard let current else { return }
        if engine.currentItem == nil || engine.currentItem?.status == .failed { start(current, at: position, refreshing: true); return }
        do { try activateAudio(); requestedPlayback = true; engine.play(); updateNowPlaying() }
        catch { fail(error) }
    }
    func next(ended: Bool = false) {
        finish(ended ? .listen : .skip)
        if let current { playedInRun.insert(current.id) }
        if let ready = prepared, ready.audio.isFresh(margin: 15), ready.item.status != .failed, engine.items().contains(ready.item) {
            beginTiming(source: "prepared")
            requestedPlayback = true; engine.advanceToNextItem(); adoptPreparedItem(); if !interrupted { engine.play() }; return
        }
        let next = candidate()
        if let next { if !pulseMode, queue.first?.id == next.id { queue.removeFirst() }; start(next) }
        else { pause(); error = "Очередь закончилась. Обнови каталог или выбери трек." }
    }
    private func candidate(excluding additional: Set<String> = []) -> Track? {
        let excluded = additional.union(playedInRun).union(failedCandidates).union(current.map { [$0.id] } ?? [])
        return pulseMode ? pulseNext?(excluded, mood) : queue.first(where: { !failedCandidates.contains($0.id) && !additional.contains($0.id) })
    }
    private func adoptPreparedItem() {
        guard let ready = prepared, engine.currentItem === ready.item else { return }
        finish(.listen)
        if let current { playedInRun.insert(current.id) }
        if !pulseMode { queue.removeAll { $0.id == ready.track.id } }
        current = ready.track; startedID = nil; prepared = nil; position = 0; duration = ready.track.duration
        clock.reset(); retryCount = 0; artwork = nil; error = nil; isLoading = false
        generation = UUID(); prefetchedCurrent = nil; failedCandidates = []
        observe(ready.item, token: generation); loadArtwork(for: ready.track)
        isPlaying = engine.timeControlStatus == .playing; if isPlaying { markStarted() }; updateNowPlaying()
        if isPlaying { prepareNext() }
    }
#if DEBUG && targetEnvironment(simulator)
    var debugPreparedTrackID: String? { prepared?.item.status == .readyToPlay ? prepared?.track.id : nil }
#endif
    func previous() { seek(to: 0) }
    func seek(to value: Double) {
        guard engine.currentItem != nil else { return }
        seeking = true
        let seekGeneration = generation
        let target = max(0, min(value, duration > 0 ? duration : value))
        engine.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == seekGeneration else { return }
                self.seeking = false; self.clock.tick(at: ProcessInfo.processInfo.systemUptime, playing: false)
                self.tick()
            }
        }
        position = target
        updateNowPlaying()
    }
    private func beginTiming(source: String) {
        let now = ProcessInfo.processInfo.systemUptime
        startTiming = (now, Date(), source == "prepared" ? now : nil, source)
    }
    var performanceReport: String {
        let header = "Forma · iOS · замер от выбора трека до AVPlayer playing\n"
        return header + measurements.map { "\($0.title) | \($0.source) | всего \(Int($0.totalMilliseconds)) мс | поток \(Int($0.resolutionMilliseconds)) мс | буфер \(Int($0.bufferMilliseconds)) мс" }.joined(separator: "\n")
    }
    private func markStarted() {
        guard let current, startedID != current.id else { return }
        startedID = current.id
        if let timing = startTiming {
            let now = ProcessInfo.processInfo.systemUptime
            let sample = PlaybackMeasurement(title: "\(current.artist) — \(current.title)", source: timing.source,
                totalMilliseconds: (now - timing.at) * 1000,
                resolutionMilliseconds: timing.resolved.map { ($0 - timing.at) * 1000 } ?? 0)
            measurements = Array((measurements + [sample]).suffix(30)); startTiming = nil
        }
        onStarted?(current)
        // Begin next-track extraction as soon as the current track is audible.
        prepareNext()
    }
    private func finish(_ kind: FeedbackKind) {
        guard let current, clock.seconds >= 3 else { clock.reset(); return }
        let ratio = duration > 0 ? min(1, clock.seconds / duration) : 0
        onFeedback?(ListeningEvent(trackID: current.id, kind: kind, seconds: clock.seconds, ratio: ratio, mood: mood))
        clock.reset()
    }
    private func tick() {
        adoptPreparedItem()
        clock.tick(at: ProcessInfo.processInfo.systemUptime, playing: engine.timeControlStatus == .playing, seeking: seeking)
        let time = engine.currentTime().seconds
        if time.isFinite { position = max(0, time) }
        if let total = engine.currentItem?.duration.seconds, total.isFinite, total > 0 { duration = total }
        if let ready = prepared, !ready.audio.isFresh(margin: 45), engine.currentItem !== ready.item {
            engine.remove(ready.item); prepared = nil; prefetchedCurrent = nil
        }
        if isPlaying, prepared == nil, !preparing { prepareNext() }
        if ProcessInfo.processInfo.systemUptime - lastNowPlayingUpdate >= 5 { updateNowPlaying() }
    }
    private func observe(_ item: AVPlayerItem, token: UUID) {
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == token else { return }
                if self.prepared != nil { self.adoptPreparedItem() }
                else { self.next(ended: true) }
            }
        }
        itemObservation = item.observe(\.status, options: [.initial, .new]) { [weak self, weak item] _, _ in
            Task { @MainActor in
                guard let self, let item, self.generation == token, item.status == .failed else { return }
#if DEBUG && targetEnvironment(simulator)
                if ProcessInfo.processInfo.arguments.contains("--forma-smoke") { print("Native item failed for \(self.current?.id ?? "none"): \(item.error?.localizedDescription ?? "unknown")") }
#endif
                if self.retryCount < 1, self.requestedPlayback, let track = self.current {
                    self.retryCount += 1
                    self.start(track, at: self.position, refreshing: true)
                } else { self.fail(item.error ?? PlayerError.unavailable) }
            }
        }
    }
    private func prepareNext() {
        guard !preparing, prepared == nil, let next = candidate(), let active = engine.currentItem else { return }
        preparing = true
        prefetchedCurrent = next.id
        let token = generation, requestToken = UUID(); preparationToken = requestToken
        prefetch = Task { [weak self] in
            guard let self else { return }
            do {
                let audio = try await resolver.resolve(videoID: next.id, forceRefresh: false)
                try Task.checkCancellation()
                guard generation == token, preparationToken == requestToken, engine.currentItem === active else { return }
                let item = AVPlayerItem(url: audio.url); item.preferredForwardBufferDuration = 8
                guard engine.canInsert(item, after: active) else { preparing = false; return }
                prepared = (next, item, audio); engine.insert(item, after: active); preparing = false
                if let later = candidate(excluding: [next.id]) { await resolver.prewarm(videoIDs: [later.id]) }
            } catch {
                guard generation == token, preparationToken == requestToken else { return }
                preparing = false
                prefetchedCurrent = nil
                if !Task.isCancelled { failedCandidates.insert(next.id); if failedCandidates.count < 3 { prepareNext() } }
            }
        }
    }
    func refreshPreparedSelection() {
        adoptPreparedItem()
        guard let next = candidate() else {
            preparationToken = UUID(); prefetch?.cancel(); preparing = false
            if let ready = prepared, engine.currentItem !== ready.item { engine.remove(ready.item); prepared = nil }
            return
        }
        if preparing, prefetchedCurrent == next.id { return }
        if let ready = prepared, engine.currentItem !== ready.item, ready.track.id != next.id {
            engine.remove(ready.item); prepared = nil
        } else if prepared != nil { return }
        preparationToken = UUID(); prefetch?.cancel(); preparing = false
        if isPlaying { prepareNext() }
    }
    private func activateAudio() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
    }
    private func fail(_ failure: Error) {
        startTiming = nil
        engine.pause(); isPlaying = false; isLoading = false; requestedPlayback = false
        clock.reset() // An unavailable stream is not a negative taste signal.
        error = failure.localizedDescription
        updateNowPlaying()
    }
    private func installRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        func register(_ command: MPRemoteCommand, _ action: @escaping @MainActor (PlaybackController, MPRemoteCommandEvent) -> Void) {
            command.isEnabled = true
            let target = command.addTarget { [weak self] event in
                guard let self else { return .commandFailed }
                Task { @MainActor in action(self, event) }
                return .success
            }
            remoteTargets.append((command, target))
        }
        register(center.playCommand) { player, _ in player.resume() }
        register(center.pauseCommand) { player, _ in player.pause() }
        register(center.togglePlayPauseCommand) { player, _ in player.toggle() }
        register(center.nextTrackCommand) { player, _ in player.next() }
        register(center.previousTrackCommand) { player, _ in player.previous() }
        register(center.changePlaybackPositionCommand) { player, event in
            if let event = event as? MPChangePlaybackPositionCommandEvent { player.seek(to: event.positionTime) }
        }
    }
    private func installAudioEvents() {
        systemObservers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
            let type = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue
            let options = (notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? NSNumber)?.uintValue ?? 0
            Task { @MainActor in
                guard let self, let type else { return }
                if type == AVAudioSession.InterruptionType.began.rawValue { self.interrupted = true; self.engine.pause(); self.isPlaying = false; self.updateNowPlaying() }
                else {
                    self.interrupted = false
                    if AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume), self.requestedPlayback { self.resume() }
                    else { self.requestedPlayback = false; self.updateNowPlaying() }
                }
            }
        })
        systemObservers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] notification in
            let reason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue
            Task { @MainActor in if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { self?.pause() } }
        })
        systemObservers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in guard let self, let track = self.current, self.requestedPlayback else { return }; self.start(track, at: self.position, refreshing: true) }
        })
    }
    private func loadArtwork(for track: Track) {
        artworkTask = Task { [weak self] in
            guard let image = await ArtworkStore.shared.image(for: track, pixels: 960), !Task.isCancelled, let self, self.current?.id == track.id else { return }
            self.artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            self.updateNowPlaying()
        }
    }
    private func updateNowPlaying() {
        lastNowPlayingUpdate = ProcessInfo.processInfo.systemUptime
        guard let current else { return }
        var info: [String: Any] = [MPMediaItemPropertyTitle: current.title, MPMediaItemPropertyArtist: current.artist,
                                  MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
                                  MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
                                  MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue]
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        if let artwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
    enum PlayerError: LocalizedError {
        case unavailable
        var errorDescription: String? { "Поток YouTube недоступен. Попробуй другой трек или повтори позже." }
    }
}
