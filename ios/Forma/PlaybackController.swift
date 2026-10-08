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
    @Published var volume: Float = 0.7 { didSet { engine.volume = volume } }
    var onFeedback: ((ListeningEvent) -> Void)?
    var pulseNext: ((Set<String>, String?) -> Track?)?
    private let engine = AVPlayer()
    private let resolver: any StreamResolving
    private let network = NWPathMonitor()
    private var task: Task<Void, Never>?
    private var prefetch: Task<Void, Never>?
    private var prefetchedCurrent: String?
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

    init(resolver: any StreamResolving = YouTubeStreamResolver()) {
        self.resolver = resolver
        engine.volume = volume
        engine.automaticallyWaitsToMinimizeStalling = true
        periodic = engine.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        statusObservation = engine.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in
                guard let self else { return }
                self.isPlaying = self.engine.timeControlStatus == .playing
                self.updateNowPlaying()
            }
        }
        installRemoteCommands()
        installAudioEvents()
        network.pathUpdateHandler = { [resolver] _ in Task { await resolver.invalidate() } }
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
        finish(.skip)
        if let list {
            queue = Array(list.drop { $0.id != track.id }.dropFirst())
            pulseMode = asPulse; mood = context; playedInRun = []
        }
        start(track)
    }
    func startPulse(_ track: Track, mood: String? = nil) {
        play(track, list: [track], asPulse: true, context: mood)
    }
    private func start(_ track: Track, at seconds: Double = 0, refreshing: Bool = false) {
        task?.cancel(); prefetch?.cancel(); artworkTask?.cancel()
        prefetchedCurrent = nil
        let token = UUID(); generation = token
        engine.pause(); engine.replaceCurrentItem(with: nil)
        current = track; position = seconds; duration = track.duration
        clock.reset(); seeking = false; error = nil; isLoading = true; isPlaying = false; requestedPlayback = true
        if !refreshing { retryCount = 0; artwork = nil; loadArtwork(for: track) }
        updateNowPlaying()
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let resolved = try await resolver.resolve(videoID: track.id, forceRefresh: refreshing)
                try Task.checkCancellation()
                guard generation == token else { return }
                let item = AVPlayerItem(url: resolved.url)
                observe(item, token: token)
                engine.replaceCurrentItem(with: item)
                if seconds > 0 { await engine.seek(to: CMTime(seconds: seconds, preferredTimescale: 600)) }
                guard generation == token, !Task.isCancelled else { return }
                isLoading = false
                if requestedPlayback { try activateAudio(); engine.play() }
                updateNowPlaying()
            } catch is CancellationError { }
            catch {
                guard generation == token, !Task.isCancelled else { return }
                fail(error)
            }
        }
    }
    func toggle() { requestedPlayback ? pause() : resume() }
    func pause() { requestedPlayback = false; engine.pause(); isPlaying = false; updateNowPlaying() }
    func resume() {
        guard let current else { return }
        if engine.currentItem == nil || engine.currentItem?.status == .failed { start(current, at: position, refreshing: true); return }
        do { try activateAudio(); requestedPlayback = true; engine.play(); updateNowPlaying() }
        catch { fail(error) }
    }
    func next(ended: Bool = false) {
        finish(ended ? .listen : .skip)
        if let current { playedInRun.insert(current.id) }
        let next: Track?
        if pulseMode { next = pulseNext?(playedInRun, mood) }
        else { next = queue.isEmpty ? nil : queue.removeFirst() }
        if let next { start(next) }
        else { pause(); error = "Очередь закончилась. Обнови каталог или выбери трек." }
    }
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
    private func finish(_ kind: FeedbackKind) {
        guard let current, clock.seconds >= 3 else { clock.reset(); return }
        let ratio = duration > 0 ? min(1, clock.seconds / duration) : 0
        onFeedback?(ListeningEvent(trackID: current.id, kind: kind, seconds: clock.seconds, ratio: ratio, mood: mood))
        clock.reset()
    }
    private func tick() {
        clock.tick(at: ProcessInfo.processInfo.systemUptime, playing: engine.timeControlStatus == .playing, seeking: seeking)
        let time = engine.currentTime().seconds
        if time.isFinite { position = max(0, time) }
        if let total = engine.currentItem?.duration.seconds, total.isFinite, total > 0 { duration = total }
        if duration > 0, duration - position < 45, requestedPlayback,
           let current, prefetchedCurrent != current.id {
            prefetchedCurrent = current.id; prepareNext()
        }
        updateNowPlaying()
    }
    private func observe(_ item: AVPlayerItem, token: UUID) {
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            Task { @MainActor in guard let self, self.generation == token else { return }; self.next(ended: true) }
        }
        itemObservation = item.observe(\.status, options: [.initial, .new]) { [weak self, weak item] _, _ in
            Task { @MainActor in
                guard let self, let item, self.generation == token, item.status == .failed else { return }
                if self.retryCount < 1, self.requestedPlayback, let track = self.current {
                    self.retryCount += 1
                    self.start(track, at: self.position, refreshing: true)
                } else { self.fail(item.error ?? PlayerError.unavailable) }
            }
        }
    }
    private func prepareNext() {
        let candidate = pulseMode ? pulseNext?(playedInRun.union(current.map { [$0.id] } ?? []), mood) : queue.first
        guard let candidate else { return }
        // Warm the next short-lived URL during active audio; selection is refreshed after feedback.
        prefetch = Task { [resolver] in _ = try? await resolver.resolve(videoID: candidate.id, forceRefresh: false) }
    }
    private func activateAudio() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
    }
    private func fail(_ failure: Error) {
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
                if type == AVAudioSession.InterruptionType.began.rawValue { self.engine.pause(); self.isPlaying = false; self.updateNowPlaying() }
                else if AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume), self.requestedPlayback { self.resume() }
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
        guard let url = track.artworkURL, url.scheme == "https" else { return }
        artworkTask = Task { [weak self] in
            guard let (data, _) = try? await URLSession.shared.data(from: url), data.count < 5 * 1024 * 1024,
                  let image = UIImage(data: data), !Task.isCancelled, let self, self.current?.id == track.id else { return }
            self.artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            self.updateNowPlaying()
        }
    }
    private func updateNowPlaying() {
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
