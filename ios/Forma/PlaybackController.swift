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
    @Published var volume: Float = {
        guard let stored = UserDefaults.standard.object(forKey: "forma.volume") as? NSNumber, stored.floatValue.isFinite else { return 0.7 }
        return max(0, min(1, stored.floatValue))
    }() { didSet { engine.volume = volume; UserDefaults.standard.set(volume, forKey: "forma.volume") } }
    @Published private(set) var networkPolicy = NetworkPolicy.unknown
    var onConnectivityChange: ((NetworkPolicy) -> Void)?
    var onStarted: ((Track) -> Void)?
    var onSelected: ((Track) -> Void)?
    var selectionMood: String? { mood }
    var selectionSurface: String { mood != nil ? "mood" : pulseMode ? "pulse" : "manual" }
    private var startedID: String?
    private var interrupted = false
    private var mediaServicesLost = false
    private var preparationToken = UUID()
    private var lastNowPlayingUpdate: TimeInterval = 0
    var onFeedback: ((ListeningEvent) -> Void)?
    var pulseNext: ((Set<String>, String?) -> Track?)?
    private var engine = AVQueuePlayer()
    private let resolver: any StreamResolving
    private let network = NWPathMonitor()
    private var task: Task<Void, Never>?
    private var startWatchdog: Task<Void, Never>?
    private var startConfirmation: Task<Void, Never>?
    private var confirmationID = UUID()
    private let extractionTimeout: TimeInterval
    private let bufferTimeout: TimeInterval
    private var prefetch: Task<Void, Never>?
    private var prefetchedCurrent: String?
    private var prepared: (track: Track, item: AVPlayerItem, audio: ResolvedAudio)?
    @Published private(set) var preparationDepth = 3
    private struct BufferedItem { let track: Track; let item: AVPlayerItem; let audio: ResolvedAudio; let player: AVQueuePlayer }
    private var bufferedItems: [String: BufferedItem] = [:]
    private var extraPrefetch: Task<Void, Never>?
    private var extraToken = UUID()
    private var extraDesired: [String] = []
    private var extraPending: [String: BufferedItem] = [:]
    private var warmingFailures: [String: Date] = [:]
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
    private var networkRecoveryTask: Task<Void, Never>?
    private var stallTask: Task<Void, Never>?
    private var stallObserver: NSObjectProtocol?
    private var networkRecovering = false

    init(resolver: any StreamResolving = YouTubeStreamResolver(), extractionTimeout: TimeInterval = 12, bufferTimeout: TimeInterval = 8) {
        self.resolver = resolver; self.extractionTimeout = extractionTimeout; self.bufferTimeout = bufferTimeout
        preparationDepth = UserDefaults.standard.integer(forKey: "forma.preparationDepth") == 1 ? 1 : 3
        configureEngine()
        installRemoteCommands()
        installAudioEvents()
        network.pathUpdateHandler = { [weak self] path in
            let policy = NetworkPolicy(reachable: path.status == .satisfied, cellular: path.usesInterfaceType(.cellular), expensive: path.isExpensive, constrained: path.isConstrained)
            let interfaces = path.availableInterfaces.filter { path.usesInterfaceType($0.type) }.map(\.name).sorted().joined(separator: ",")
            let signature = "\(path.status)|\(interfaces)|\(path.gateways)|\(policy.cellular)|\(policy.expensive)"
            Task { @MainActor in self?.networkChanged(policy, signature: signature) }
        }
        network.start(queue: DispatchQueue(label: "music.forma.network"))
    }
    private func configureEngine() {
        engine.isMuted = false
        engine.volume = volume
        // AAC can start with a small buffer; AVPlayer's conservative wait can take seconds.
        engine.automaticallyWaitsToMinimizeStalling = false
        periodic = engine.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self, weak observedEngine = engine] _ in
            Task { @MainActor in guard let self, self.engine === observedEngine else { return }; self.tick() }
        }
        statusObservation = engine.observe(\.timeControlStatus, options: [.new]) { [weak self, weak observedEngine = engine] _, _ in
            Task { @MainActor in
                guard let self, self.engine === observedEngine else { return }
                self.adoptPreparedItem()
                let now = ProcessInfo.processInfo.systemUptime
                self.clock.tick(at: now, playing: self.isPlaying, seeking: self.seeking)
                self.clock.tick(at: now, playing: false)
                if self.requestedPlayback, !self.interrupted, !self.mediaServicesLost, self.engine.timeControlStatus == .playing {
                    if !self.isPlaying { self.isLoading = true; self.confirmStart() }
                } else {
                    self.isPlaying = false; self.cancelStartConfirmation()
                }
                self.updateNowPlaying()
            }
        }
        engine.actionAtItemEnd = .advance
        currentObservation = engine.observe(\.currentItem, options: [.new]) { [weak self, weak observedEngine = engine] _, _ in
            Task { @MainActor in guard let self, self.engine === observedEngine else { return }; self.adoptPreparedItem() }
        }
    }
    private func promote(_ player: AVQueuePlayer) {
        // Promote the owning player, never move its AVPlayerItem to another
        // player. AVFoundation may keep that association after replace(nil).
        engine.pause()
        if let periodic { engine.removeTimeObserver(periodic); self.periodic = nil }
        statusObservation = nil; currentObservation = nil; itemObservation = nil
        engine.removeAllItems(); engine = player; configureEngine()
    }
    deinit {
        extraPrefetch?.cancel()
        for entry in extraPending.values { entry.player.cancelPendingPrerolls(); entry.player.replaceCurrentItem(with: nil) }
        for entry in bufferedItems.values { entry.player.cancelPendingPrerolls(); entry.player.replaceCurrentItem(with: nil) }
        task?.cancel(); startWatchdog?.cancel(); startConfirmation?.cancel(); prefetch?.cancel(); artworkTask?.cancel(); networkRecoveryTask?.cancel(); stallTask?.cancel(); network.cancel()
        if let periodic { engine.removeTimeObserver(periodic) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        if let stallObserver { NotificationCenter.default.removeObserver(stallObserver) }
        for observer in systemObservers { NotificationCenter.default.removeObserver(observer) }
        for (command, target) in remoteTargets { command.removeTarget(target) }
    }
    private func networkChanged(_ policy: NetworkPolicy, signature: String) {
        let previous = networkSignature; networkSignature = signature
        networkPolicy = policy; onConnectivityChange?(policy)
        if previous == nil, policy.reachable {
            // Initial delivery updates budgets, without cancelling the cold start.
            if isLoading { armStartWatchdog(seconds: engine.currentItem == nil ? policy.extractionDeadline(base: extractionTimeout) : policy.bufferDeadline(base: bufferTimeout), token: generation) }
            if isPlaying { scheduleExtraPreparation() }
            return
        }
        guard previous != signature else { return }
        networkRecoveryTask?.cancel(); stallTask?.cancel(); networkRecovering = true
        adoptPreparedItem()
        clearBufferedItems()
        preparationToken = UUID(); prefetch?.cancel(); preparing = false; prefetchedCurrent = nil; failedCandidates = []
        if let ready = prepared, engine.currentItem !== ready.item { engine.remove(ready.item) }
        prepared = nil
        // URLs are tied to the connection that resolved them. Keep audible buffered
        // audio, but cancel an unfinished old-route start and replace it after settling.
        if isLoading {
            generation = UUID(); task?.cancel(); startWatchdog?.cancel(); cancelStartConfirmation(); engine.removeAllItems()
        }
        networkRecoveryTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 350_000_000) } catch { return }
            guard let self, networkSignature == signature, !Task.isCancelled else { return }
            await resolver.invalidate()
            guard networkSignature == signature, !Task.isCancelled else { return }
            networkRecovering = !policy.reachable
            guard policy.reachable, requestedPlayback else { return }
            if let current, isLoading || engine.currentItem == nil || engine.currentItem?.status == .failed || engine.timeControlStatus != .playing {
                start(current, at: position, refreshing: true)
            } else { prepareNext() }
        }
    }
#if DEBUG && targetEnvironment(simulator)
    func debugNetworkChanged(_ policy: NetworkPolicy, signature: String) { networkChanged(policy, signature: signature) }
#endif
    private func recoverStall(token: UUID) {
        stallTask?.cancel()
        let initial = engine.currentTime().seconds
        isPlaying = false; isLoading = requestedPlayback && !interrupted && !mediaServicesLost
        cancelStartConfirmation(); confirmStart()
        stallTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
            guard let self, generation == token, requestedPlayback, !networkRecovering,
                  !interrupted, !mediaServicesLost,
                  networkPolicy.reachable, !isPlaying,
                  retryCount < 2, let current else { return }
            let cursor = engine.currentTime().seconds
            if initial.isFinite, cursor.isFinite, cursor > initial + 0.01 { return }
            retryCount += 1
            start(current, at: position, refreshing: true)
        }
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
        if alreadyAdvanced { refreshPreparedSelection(); resume(); return }
        if bufferedItems[track.id]?.audio.isFresh(margin: 45) == true { start(track); return }
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
        let buffered = refreshing ? nil : takeBufferedItem(track.id)
        cancelExtraPreparation()
        if refreshing { clearBufferedItems() }
        task?.cancel(); prefetch?.cancel(); startWatchdog?.cancel(); cancelStartConfirmation(); artworkTask?.cancel(); artworkTask = nil; stallTask?.cancel()
        prefetchedCurrent = nil; failedCandidates = []
        let token = UUID(); generation = token
        engine.pause(); engine.removeAllItems(); prepared = nil; preparing = false
        if !refreshing { onSelected?(track) }
        current = track; if !refreshing { startedID = nil }; position = seconds; duration = track.duration
        if !refreshing { clock.reset() }; seeking = false; error = nil; isLoading = true; isPlaying = false; requestedPlayback = true
        if !refreshing { retryCount = 0; artwork = nil }
        updateNowPlaying()
        if mediaServicesLost || (networkPolicy.known && !networkPolicy.reachable) { return }
        if !interrupted { armStartWatchdog(seconds: networkPolicy.extractionDeadline(base: extractionTimeout), token: token) }
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let resolved: ResolvedAudio
                if let buffered { resolved = buffered.audio; if var timing = startTiming { timing.source = "buffered"; startTiming = timing } }
                else { resolved = try await resolver.resolve(videoID: track.id, forceRefresh: refreshing) }
                try Task.checkCancellation()
                guard generation == token else { return }
                if var timing = startTiming {
                    timing.resolved = ProcessInfo.processInfo.systemUptime
                    if buffered == nil, resolved.resolvedAt < timing.wall { timing.source = "cached" }
                    startTiming = timing
                }
                if requestedPlayback, !interrupted { armStartWatchdog(seconds: networkPolicy.bufferDeadline(base: bufferTimeout), token: token) }
                let item = buffered?.item ?? makePlayerItem(resolved.url)
                item.preferredForwardBufferDuration = networkPolicy.lean ? 6 : 3
                if let buffered { promote(buffered.player) }
                else { engine.insert(item, after: nil) }
                observe(item, token: token)
                if seconds > 0 { await engine.seek(to: CMTime(seconds: seconds, preferredTimescale: 600)) }
                guard generation == token, !Task.isCancelled else { return }
                if requestedPlayback, !interrupted, !mediaServicesLost { try activateAudio(); confirmStart(); engine.play() }
                updateNowPlaying()
            } catch is CancellationError { }
            catch {
                guard generation == token, !Task.isCancelled else { return }
                fail(error)
            }
        }
    }
    func toggle() { requestedPlayback ? pause() : resume() }
    func pause() {
        cancelExtraPreparation()
        clock.tick(at: ProcessInfo.processInfo.systemUptime, playing: isPlaying, seeking: seeking)
        if isLoading, engine.currentItem == nil { generation = UUID(); task?.cancel() }
        stallTask?.cancel(); startWatchdog?.cancel(); cancelStartConfirmation(); startTiming = nil; requestedPlayback = false
        engine.pause(); isPlaying = false; isLoading = false
        clock.tick(at: ProcessInfo.processInfo.systemUptime, playing: false)
        updateNowPlaying()
    }
    func resume() {
        guard let current else { return }
        requestedPlayback = true
        guard !interrupted, !mediaServicesLost else { updateNowPlaying(); return }
        if engine.currentItem == nil || engine.currentItem?.status == .failed { start(current, at: position, refreshing: true); return }
        do {
            try activateAudio(); error = nil
            clock.tick(at: ProcessInfo.processInfo.systemUptime, playing: false)
            isLoading = true; isPlaying = false
            armStartWatchdog(seconds: networkPolicy.bufferDeadline(base: bufferTimeout), token: generation)
            confirmStart(); engine.play(); updateNowPlaying()
        }
        catch { fail(error) }
    }
    func next(ended: Bool = false) {
        advance(ended: ended, recordFeedback: true)
    }
    /// An explicit dislike is already feedback. Do not also train a skip/listen.
    func skipDislikedTrack(_ id: String) {
        adoptPreparedItem()
        guard current?.id == id else { return }
        advance(ended: false, recordFeedback: false)
    }
    private func advance(ended: Bool, recordFeedback: Bool) {
        adoptPreparedItem()
        if recordFeedback { finish(ended ? .listen : .skip) } else { clock.reset() }
        if let current { playedInRun.insert(current.id) }
        if pulseMode { refreshPreparedSelection() }
        if let ready = prepared, ready.audio.isFresh(margin: 15), ready.item.status != .failed, engine.items().contains(ready.item) {
            if bufferedItems[ready.track.id]?.audio.isFresh(margin: 45) == true {
                if !pulseMode { queue.removeAll { $0.id == ready.track.id } }
                start(ready.track); return
            }
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
        onSelected?(ready.track)
        current = ready.track; startedID = nil; prepared = nil; position = 0; duration = ready.track.duration
        clock.reset(); retryCount = 0; artworkTask?.cancel(); artworkTask = nil; artwork = nil; error = nil
        generation = UUID(); prefetchedCurrent = nil; failedCandidates = []
        if let buffered = takeBufferedItem(ready.track.id, allowPending: false) {
            promote(buffered.player)
            observe(buffered.item, token: generation)
            if requestedPlayback, !interrupted, !mediaServicesLost { engine.play() }
        } else { observe(ready.item, token: generation) }
        cancelStartConfirmation(); isPlaying = false
        isLoading = requestedPlayback && !interrupted && !mediaServicesLost
        if isLoading { armStartWatchdog(seconds: networkPolicy.bufferDeadline(base: bufferTimeout), token: generation); confirmStart() }
        updateNowPlaying()
    }
#if DEBUG && targetEnvironment(simulator)
    var debugPreparedTrackID: String? { guard let prepared else { return nil }; return prepared.item.status == .readyToPlay || bufferedItems[prepared.track.id]?.item.status == .readyToPlay ? prepared.track.id : nil }
    var debugBufferedTrackIDs: Set<String> { Set(bufferedItems.filter { $0.value.item.status == .readyToPlay && $0.value.audio.isFresh(margin: 45) }.keys) }
    var debugExtraPlayersMuted: Bool { bufferedItems.values.allSatisfy { $0.player.isMuted && $0.player.rate == 0 } }
    var debugWarmingTrackIDs: Set<String> { Set(extraPending.keys) }
    var debugPlayerIdentity: ObjectIdentifier { ObjectIdentifier(engine) }
    func debugWarmingPlayerIdentity(_ id: String) -> ObjectIdentifier? { extraPending[id].map { ObjectIdentifier($0.player) } }
    var debugHasPlayerItem: Bool { engine.currentItem != nil }
    var debugPlaybackState: String { "loading=\(isLoading), playing=\(isPlaying), cursor=\(engine.currentTime().seconds), itemCursor=\(engine.currentItem?.currentTime().seconds ?? -1), itemStatus=\(engine.currentItem?.status.rawValue ?? -1), next=\(prepared?.track.id ?? "none"), nextStatus=\(prepared?.item.status.rawValue ?? -1), preparing=\(preparing), warmFailures=\(warmingFailures.keys.sorted())" }
    func debugAdvanceEngine() { engine.advanceToNextItem() }
#endif
    func previous() { seek(to: 0) }
    func seek(to value: Double) {
        guard value.isFinite, engine.currentItem != nil else { return }
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
    private func cancelStartConfirmation() {
        startConfirmation?.cancel(); startConfirmation = nil; confirmationID = UUID()
    }
    private func confirmStart() {
        guard startConfirmation == nil, requestedPlayback, !interrupted, !mediaServicesLost, let item = engine.currentItem else { return }
        let token = generation, id = UUID(); confirmationID = id
        let initial = item.currentTime().seconds
        startConfirmation = Task { [weak self, weak item] in
            var baseline: Double? = initial.isFinite ? initial : nil
            while !Task.isCancelled {
                guard let self, let item, generation == token, confirmationID == id, requestedPlayback,
                      !interrupted, !mediaServicesLost, engine.currentItem === item else { break }
                let cursor = item.currentTime().seconds
                if seeking { baseline = cursor.isFinite ? cursor : nil }
                else if item.status == .readyToPlay, engine.timeControlStatus == .playing, cursor.isFinite {
                    if let previous = baseline, cursor < previous { baseline = cursor }
                    if let baseline, cursor > baseline + 0.005 {
                        // `playing` alone can arrive before an HTTP asset supplies
                        // audio. Confirm an advancing item before cancelling its deadline.
                        isPlaying = true; isLoading = false; startConfirmation = nil
                        clock.tick(at: ProcessInfo.processInfo.systemUptime, playing: false)
                        markStarted(); updateNowPlaying(); return
                    }
                    if baseline == nil { baseline = cursor }
                }
                do { try await Task.sleep(nanoseconds: 15_000_000) } catch { break }
            }
            if let self, confirmationID == id { startConfirmation = nil }
        }
    }
    var performanceReport: String {
        let header = "Forma · iOS · замер от выбора трека до движения позиции готового потока\n"
        return header + measurements.map { "\($0.title) | \($0.source) | всего \(Int($0.totalMilliseconds)) мс | поток \(Int($0.resolutionMilliseconds)) мс | буфер \(Int($0.bufferMilliseconds)) мс" }.joined(separator: "\n")
    }
    private func markStarted() {
        guard let current else { return }
        startWatchdog?.cancel(); stallTask?.cancel()
        if let timing = startTiming {
            let now = ProcessInfo.processInfo.systemUptime
            let sample = PlaybackMeasurement(title: "\(current.artist) — \(current.title)", source: timing.source,
                totalMilliseconds: (now - timing.at) * 1000,
                resolutionMilliseconds: timing.resolved.map { ($0 - timing.at) * 1000 } ?? 0)
            measurements = Array((measurements + [sample]).suffix(30)); startTiming = nil
        }
        if startedID != current.id { startedID = current.id; onStarted?(current) }
        if artwork == nil && artworkTask == nil { loadArtwork(for: current) }
        // Begin next-track extraction as soon as the current track is audible.
        prepareNext()
    }
    private func finish(_ kind: FeedbackKind) {
        clock.tick(at: ProcessInfo.processInfo.systemUptime, playing: isPlaying, seeking: seeking)
        guard let current, clock.seconds >= 3 else { clock.reset(); return }
        let ratio = duration > 0 ? min(1, clock.seconds / duration) : 0
        onFeedback?(ListeningEvent(trackID: current.id, kind: kind, seconds: clock.seconds, ratio: ratio, mood: mood))
        clock.reset()
    }
    private func tick() {
        adoptPreparedItem()
        clock.tick(at: ProcessInfo.processInfo.systemUptime, playing: isPlaying && engine.timeControlStatus == .playing, seeking: seeking)
        let time = engine.currentTime().seconds
        if time.isFinite { position = max(0, time) }
        if let total = engine.currentItem?.duration.seconds, total.isFinite, total > 0 { duration = min(86400, total) }
        if let ready = prepared, !ready.audio.isFresh(margin: 45), engine.currentItem !== ready.item {
            engine.remove(ready.item); prepared = nil; prefetchedCurrent = nil
        }
        if isPlaying, prepared == nil, !preparing { prepareNext() }
        if isPlaying { scheduleExtraPreparation() }
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
        if let stallObserver { NotificationCenter.default.removeObserver(stallObserver) }
        stallObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemPlaybackStalled, object: item, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.recoverStall(token: token) }
        }
        itemObservation = item.observe(\.status, options: [.initial, .new]) { [weak self, weak item] _, _ in
            Task { @MainActor in
                guard let self, let item, self.generation == token, item.status == .failed,
                      !self.networkRecovering, !self.interrupted, !self.mediaServicesLost else { return }
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
        guard !networkRecovering, !preparing, prepared == nil, let next = candidate(), let active = engine.currentItem else { return }
        cancelExtraPreparation()
        preparing = true
        prefetchedCurrent = next.id
        let token = generation, requestToken = UUID(); preparationToken = requestToken
        prefetch = Task { [weak self] in
            guard let self else { return }
            do {
                let buffered = bufferedItems[next.id].flatMap { $0.audio.isFresh(margin: 45) ? $0 : nil }
                let audio: ResolvedAudio
                if let buffered { audio = buffered.audio }
                else { audio = try await resolver.resolve(videoID: next.id, forceRefresh: false) }
                try Task.checkCancellation()
                guard generation == token, preparationToken == requestToken, engine.currentItem === active else { return }
                // The main queue retains its normal automatic transition. Its
                // item is distinct from the independently warmed player's item.
                let item = makePlayerItem(audio.url); item.preferredForwardBufferDuration = networkPolicy.lean ? 12 : 8
                guard engine.canInsert(item, after: active) else { preparing = false; return }
                prepared = (next, item, audio); engine.insert(item, after: active); preparing = false
                scheduleExtraPreparation()
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
            clearBufferedItems()
            preparationToken = UUID(); prefetch?.cancel(); preparing = false
            if let ready = prepared, engine.currentItem !== ready.item { engine.remove(ready.item); prepared = nil }
            return
        }
        if preparing, prefetchedCurrent == next.id { return }
        if let ready = prepared, engine.currentItem !== ready.item, ready.track.id != next.id {
            engine.remove(ready.item); prepared = nil
        } else if prepared != nil { scheduleExtraPreparation(); return }
        preparationToken = UUID(); prefetch?.cancel(); preparing = false
        if isPlaying { prepareNext() }
    }
    private func makePlayerItem(_ url: URL) -> AVPlayerItem {
        let asset = AVURLAsset(url: url, options: [AVURLAssetAllowsCellularAccessKey: true, AVURLAssetAllowsExpensiveNetworkAccessKey: true, AVURLAssetAllowsConstrainedNetworkAccessKey: true])
        return AVPlayerItem(asset: asset)
    }
    func setPreparationDepth(_ depth: Int) {
        preparationDepth = depth == 1 ? 1 : 3
        UserDefaults.standard.set(preparationDepth, forKey: "forma.preparationDepth")
        clearBufferedItems(); if isPlaying { scheduleExtraPreparation() }
    }
    private func cancelExtraPreparation() {
        extraToken = UUID(); extraPrefetch?.cancel(); extraPrefetch = nil; extraDesired = []
        for entry in extraPending.values { entry.player.cancelPendingPrerolls(); entry.player.replaceCurrentItem(with: nil) }
        extraPending.removeAll()
    }
    private func clearBufferedItems() {
        cancelExtraPreparation()
        for entry in bufferedItems.values { entry.player.cancelPendingPrerolls(); entry.player.replaceCurrentItem(with: nil) }
        bufferedItems.removeAll(); warmingFailures.removeAll()
    }
    private func takeBufferedItem(_ id: String, allowPending: Bool = true) -> BufferedItem? {
        let ready = bufferedItems.removeValue(forKey: id)
        // An automatic transition already owns a prepared main-queue item.
        // Replace that item only with a completed, preroll-ready warmer.
        guard let entry = ready ?? (allowPending ? extraPending.removeValue(forKey: id) : nil) else { return nil }
        guard entry.audio.isFresh(margin: 45), entry.item.status != .failed else { entry.player.removeAllItems(); return nil }
        // Transfer the existing AVPlayer/asset, including partially downloaded
        // bytes. The old warm task no longer owns this entry and cannot clear it.
        entry.player.cancelPendingPrerolls()
        return entry
    }
    private func scheduleExtraPreparation() {
        guard isPlaying, requestedPlayback, !isLoading, !interrupted, !mediaServicesLost,
              !networkRecovering, networkPolicy.canPrewarmExtraTracks, let prepared, prepared.item.status != .failed else { return }
        var exclude: Set<String> = [prepared.track.id], desired: [Track] = [prepared.track]
        for _ in 1..<preparationDepth {
            guard let track = candidate(excluding: exclude) else { break }
            exclude.insert(track.id); desired.append(track)
        }
        let ids = desired.map(\.id), wanted = Set(ids), now = Date()
        for (id, entry) in bufferedItems where !wanted.contains(id) || !entry.audio.isFresh(margin: 45) || entry.item.status == .failed {
            entry.player.cancelPendingPrerolls(); entry.player.replaceCurrentItem(with: nil); bufferedItems[id] = nil
        }
        if extraDesired == ids, extraPrefetch != nil { return }
        cancelExtraPreparation(); extraDesired = ids
        let missing = desired.filter { bufferedItems[$0.id] == nil && now.timeIntervalSince(warmingFailures[$0.id] ?? .distantPast) > 30 }
        guard !missing.isEmpty else { return }
        let token = extraToken, nearest = prepared
        extraPrefetch = Task(priority: .utility) { [weak self] in
            await withTaskGroup(of: Void.self) { group in
                // At most three independent buffers. A slow/failing second
                // track cannot hold the third behind two preroll deadlines.
                for track in missing {
                    group.addTask { @MainActor [weak self] in
                        guard let self else { return }
                        await self.warm(track, nearest: nearest, token: token)
                    }
                }
            }
            if let self, extraToken == token { extraPrefetch = nil }
        }
    }
    private func warm(_ track: Track, nearest: (track: Track, item: AVPlayerItem, audio: ResolvedAudio), token: UUID) async {
        guard !Task.isCancelled, extraToken == token, isPlaying else { return }
        do {
            let audio: ResolvedAudio
            if track.id == nearest.track.id { audio = nearest.audio }
            else { audio = try await resolver.analysisAudio(videoID: track.id) }
            try Task.checkCancellation(); guard extraToken == token, isPlaying else { return }
            let item = makePlayerItem(audio.url); item.preferredForwardBufferDuration = 3
            item.canUseNetworkResourcesForLiveStreamingWhilePaused = false
            let warmer = AVQueuePlayer(items: [item]); warmer.isMuted = true; warmer.volume = 0; warmer.allowsExternalPlayback = false
            let entry = BufferedItem(track: track, item: item, audio: audio, player: warmer)
            extraPending[track.id] = entry
            let deadline: Double = networkPolicy.lean ? 12 : 8
            var ready = await AudioPreroll(warmer).wait(seconds: deadline)
            guard extraPending[track.id]?.player === warmer else { return }
            try Task.checkCancellation()
            if !ready, extraToken == token, isPlaying, item.status != .failed, audio.isFresh(margin: 45) {
                ready = await AudioPreroll(warmer).wait(seconds: deadline)
            }
            guard extraPending[track.id]?.player === warmer else { return }
            try Task.checkCancellation()
            guard extraToken == token, isPlaying else { return }
            extraPending[track.id] = nil
            if ready, item.status == .readyToPlay, audio.isFresh(margin: 45) { bufferedItems[track.id] = entry }
            else { warmer.replaceCurrentItem(with: nil); warmingFailures[track.id] = Date() }
        } catch {
            guard extraToken == token else { return }
            if let entry = extraPending.removeValue(forKey: track.id) { entry.player.cancelPendingPrerolls(); entry.player.replaceCurrentItem(with: nil) }
            if !Task.isCancelled { warmingFailures[track.id] = Date() }
        }
    }
    private func armStartWatchdog(seconds: TimeInterval, token: UUID) {
        startWatchdog?.cancel()
        startWatchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0.1, seconds) * 1_000_000_000))
            guard !Task.isCancelled, let self, generation == token, requestedPlayback, !interrupted, !mediaServicesLost, isLoading, !isPlaying, let track = current else { return }
            generation = UUID(); task?.cancel(); engine.removeAllItems()
            fail(PlayerError.startTimedOut)
            await resolver.cancel(videoID: track.id)
        }
    }
    private func activateAudio() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
    }
    private func fail(_ failure: Error) {
        clearBufferedItems()
        startWatchdog?.cancel(); cancelStartConfirmation(); prefetch?.cancel(); preparationToken = UUID(); preparing = false
        if let ready = prepared, engine.currentItem !== ready.item { engine.remove(ready.item) }
        prepared = nil
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
                self.handleInterruption(began: type == AVAudioSession.InterruptionType.began.rawValue,
                    shouldResume: AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume))
            }
        })
        systemObservers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] notification in
            let reason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue
            Task { @MainActor in if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { self?.pause() } }
        })
        systemObservers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.resetMediaServices() }
        })
        systemObservers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.mediaServicesWereLostNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.suspendForMediaServicesLoss() }
        })
    }
    private func handleInterruption(began: Bool, shouldResume: Bool) {
        if began {
            clock.tick(at: ProcessInfo.processInfo.systemUptime, playing: isPlaying, seeking: seeking)
            if isLoading, engine.currentItem == nil { generation = UUID(); task?.cancel() }
            cancelExtraPreparation()
            interrupted = true; startWatchdog?.cancel(); cancelStartConfirmation(); stallTask?.cancel()
            engine.pause(); isPlaying = false; isLoading = false; updateNowPlaying()
        } else {
            interrupted = false
            if shouldResume, requestedPlayback { resume() }
            else { requestedPlayback = false; isLoading = false; updateNowPlaying() }
        }
    }
#if DEBUG && targetEnvironment(simulator)
    func debugInterruption(began: Bool, shouldResume: Bool = true) { handleInterruption(began: began, shouldResume: shouldResume) }
    func debugMediaServicesReset() { resetMediaServices() }
    func debugMediaServicesLost() { suspendForMediaServicesLoss() }
#endif
    private func suspendForMediaServicesLoss() {
        clearBufferedItems()
        clock.tick(at: ProcessInfo.processInfo.systemUptime, playing: isPlaying, seeking: seeking)
        mediaServicesLost = true; generation = UUID(); preparationToken = UUID()
        task?.cancel(); prefetch?.cancel(); startWatchdog?.cancel(); cancelStartConfirmation(); stallTask?.cancel()
        preparing = false; prepared = nil; engine.pause()
        isPlaying = false; isLoading = false; updateNowPlaying()
    }
    private func resetMediaServices() {
        clearBufferedItems()
        mediaServicesLost = false
        task?.cancel(); prefetch?.cancel(); startWatchdog?.cancel(); cancelStartConfirmation(); stallTask?.cancel()
        generation = UUID(); preparationToken = UUID(); prepared = nil; preparing = false
        engine.pause(); engine.removeAllItems()
        if let periodic { engine.removeTimeObserver(periodic); self.periodic = nil }
        statusObservation = nil; currentObservation = nil; itemObservation = nil
        engine = AVQueuePlayer(); configureEngine()
        isPlaying = false; isLoading = false
        if requestedPlayback, !interrupted, let current { start(current, at: position, refreshing: true) }
        else { updateNowPlaying() }
    }
    func refreshArtworkPreference() {
        artworkTask?.cancel(); artworkTask = nil; artwork = nil
        if isPlaying, let current { loadArtwork(for: current) }
        updateNowPlaying()
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
        case unavailable, startTimedOut
        var errorDescription: String? {
            switch self {
            case .unavailable: return "Поток YouTube недоступен. Попробуй другой трек или повтори позже."
            case .startTimedOut: return "YouTube слишком долго отвечает. Нажми «Повторить» или выбери другой трек."
            }
        }
    }
}
