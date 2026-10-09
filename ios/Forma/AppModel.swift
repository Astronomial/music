import Combine
import Foundation
import Network
import UIKit
import FormaCore

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var library = Library()
    @Published private(set) var recommendations: [Recommendation] = []
    @Published private(set) var searchResults: [Track] = []
    @Published private(set) var isRefreshing = false
    @Published private(set) var isSearching = false
    @Published private(set) var isSyncing = false
    @Published private(set) var isRestoringLibrary = true
    @Published private(set) var pcHost: String?
    @Published private(set) var syncStatus = "Подключи ПК, чтобы перенести библиотеку"
    @Published var message: String?
    @Published private(set) var localWiFiAvailable = false
    var canSynchronizePC: Bool { player.networkPolicy.canSyncPC(localWiFi: localWiFiAvailable) }
    private let localWiFiMonitor = NWPathMonitor(requiredInterfaceType: .wifi)
    private var syncBackoff = SyncBackoff()
    private var syncRouteAllowed = false
    private var lastAutomaticRefresh = Date.distantPast
    let player: PlaybackController
    private let streams: YouTubeStreamResolver
    private let audioResolver: any StreamResolving
    private let catalog = YouTubeCatalog()
    private let sync = SyncClient()
    private var storage: LibraryStorage?
    private var storageURL: URL?
    private var didLoadLibrary = false
    private var syncBase: Library?
    private var moodCache: [String: [Recommendation]] = [:]
    private var pulseCache: [Recommendation] = []
    private var pulseCachePlaylistID: String?
    private var selectedContexts: [String: RecommendationContext] = [:]
    private var activeContext: RecommendationContext?
    private var playbackIndex: PulseEngine.RankingIndex?
    private var pulsePlaylistID: String?
    private var searchGeneration = UUID()
    private var recommendationGeneration = UUID()
    private var pulseGeneration = UUID()
    private var pulseWork: Task<[Recommendation], Never>?
    private var linkTask: Task<Track?, Never>?
    private var syncEpoch = UUID()
    private var recommendationTask: Task<Void, Never>?
    private var rankingWork: Task<([Recommendation], [Recommendation], [String: [Recommendation]], PulseEngine.RankingIndex), Never>?
    private var settingsTask: Task<Void, Never>?
    private var persistTask: Task<Void, Never>?
    private var syncTask: Task<Void, Never>?

    init(playbackResolver: (any StreamResolving)? = nil) {
        let streams = YouTubeStreamResolver(); self.streams = streams
        let audioResolver = playbackResolver ?? streams; self.audioResolver = audioResolver
        player = PlaybackController(resolver: audioResolver)
        if let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            let url = directory.appendingPathComponent("forma-ios-library.json")
            storageURL = url
        }
        updateRecommendations()
        localWiFiMonitor.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            Task { @MainActor in self?.localWiFiChanged(available) }
        }
        localWiFiMonitor.start(queue: DispatchQueue(label: "music.forma.local-wifi"))
        player.onConnectivityChange = { [weak self] policy in
            guard let self else { return }
            updateSyncRoute()
            if !policy.canPrewarmExtraTracks { Task { await self.audioResolver.prewarm(videoIDs: []) } }
        }
        player.onSelected = { [weak self] track in
            guard let self else { return }
            self.activeContext = self.selectedContexts.removeValue(forKey: track.id) ?? self.context(for: track)
        }
        player.onStarted = { [weak self] track in
            guard let self else { return }
            self.library.record(ListeningEvent(trackID: track.id, kind: .play, seconds: 0, ratio: 0, newArtist: PulseDiversity.newArtist(track, library: self.library), recommendation: self.activeContext, surface: self.player.selectionSurface))
            self.persist(); self.updateRecommendations()
        }
        player.onFeedback = { [weak self] event in
            guard let self else { return }
            let exposure = self.library.events.last { $0.trackID == event.trackID && $0.kind == .play }
            self.library.record(ListeningEvent(trackID: event.trackID, kind: event.kind, at: event.at, seconds: event.seconds, ratio: event.ratio, mood: event.mood, newArtist: exposure?.newArtist, recommendation: exposure?.recommendation, surface: exposure?.surface))
            self.persist(); self.updateRecommendations()
            if self.library.events.count % 4 == 0 { Task { await self.refresh(automatic: true) } }
        }
        player.pulseNext = { [weak self] excluded, mood in
            guard let self else { return nil }
            if let id = self.pulsePlaylistID, !self.library.playlists.contains(where: { $0.id == id }) { return nil }
            let source = mood.flatMap { self.moodCache[$0] } ?? self.pulseCache
            guard let choice = PulseEngine.selectCached(source, library: self.selectionLibrary(), exclude: excluded, currentID: self.player.current?.id, index: self.playbackIndex, mood: mood) else { return nil }
            if let exposure = choice.exposure { self.selectedContexts[choice.id] = exposure }
            return choice.track
        }
        let startupEpoch = syncEpoch
        Task {
            await restoreLibrary()
            let connection = await sync.restore(), base = await storage?.syncBase()
            guard syncEpoch == startupEpoch else { return }
            pcHost = connection?.host; syncBase = base
            if pcHost != nil { syncStatus = canSynchronizePC ? "ПК подключён. Синхронизируем в общей Wi-Fi сети" : "Синхронизация продолжится по Wi-Fi. Изменения сохранены"; scheduleSync() }
        }
    }
    deinit {
        localWiFiMonitor.cancel(); recommendationTask?.cancel(); rankingWork?.cancel()
        settingsTask?.cancel(); persistTask?.cancel(); syncTask?.cancel()
        pulseWork?.cancel(); linkTask?.cancel()
    }
    private func restoreLibrary() async {
        guard !didLoadLibrary, let storageURL else { isRestoringLibrary = false; return }
        isRestoringLibrary = true
        let store = LibraryStorage(url: storageURL)
        do {
            var loaded = try await store.load()
            if loaded.library.settings.recommendationVersion < 2 {
                loaded.library.settings.discovery = 0.7; loaded.library.settings.recommendationVersion = 2
            }
            library = LibrarySync.merge(current: loaded.library, base: Library(), incoming: library)
            storage = store; didLoadLibrary = true; message = loaded.notice
        } catch {
            // A read/access failure must never be followed by saving an empty profile.
            storage = nil; message = "Не удалось прочитать библиотеку. Исходный файл не изменён: \(error.localizedDescription)"
        }
        isRestoringLibrary = false; updateRecommendations()
        if didLoadLibrary { persist(immediately: true) }
    }
    func becameActive() async {
        if !isRestoringLibrary, !didLoadLibrary { await restoreLibrary() }
        await synchronize()
    }
    private func localWiFiChanged(_ available: Bool) {
        guard available != localWiFiAvailable else { return }
        localWiFiAvailable = available; updateSyncRoute()
    }
    private func updateSyncRoute() {
        let allowed = canSynchronizePC
        guard allowed != syncRouteAllowed else { return }
        syncRouteAllowed = allowed; syncBackoff.reset()
        if allowed { scheduleSync() } else { stopSyncForNetwork() }
    }
    private func stopSyncForNetwork() {
        syncTask?.cancel(); syncEpoch = UUID(); isSyncing = false
        Task { await sync.cancelPendingRequests() }
        if pcHost != nil { syncStatus = "Синхронизация продолжится по Wi-Fi. Изменения сохранены" }
    }
    func prepareTracks(_ tracks: [Track]) async { guard player.networkPolicy.canPrewarmExtraTracks else { return }; await audioResolver.prewarm(videoIDs: Array(tracks.prefix(3).map(\.id))) }
    var liked: [Track] { library.likedIDs.compactMap { library.tracks[$0] } }
    func isLiked(_ track: Track) -> Bool { library.likedIDs.contains(track.id) }
    func toggleLike(_ track: Track) {
        library.merge([track])
        if isLiked(track) { library.likedIDs.removeAll { $0 == track.id } }
        else { library.likedIDs.append(track.id); library.record(.init(trackID: track.id, kind: .like, seconds: 0, ratio: 0, recommendation: context(for: track), surface: player.current?.id == track.id ? player.selectionSurface : "library")) }
        changed()
    }
    func createPlaylist(_ name: String) {
        let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        library.playlists.append(Playlist(name: String(title.prefix(100)), trackIDs: [])); changed()
    }
    func add(_ track: Track, to playlistID: String) {
        guard let index = library.playlists.firstIndex(where: { $0.id == playlistID }) else { return }
        library.merge([track]); if !library.playlists[index].trackIDs.contains(track.id) { library.playlists[index].trackIDs.append(track.id); library.record(.init(trackID: track.id, kind: .playlistAdd, seconds: 0, ratio: 0, recommendation: context(for: track), surface: "playlist")) }; changed()
    }
    func remove(_ track: Track, from playlistID: String) {
        guard let index = library.playlists.firstIndex(where: { $0.id == playlistID }) else { return }
        library.playlists[index].trackIDs.removeAll { $0 == track.id }; changed()
    }
    func deletePlaylist(_ id: String) {
        library.playlists.removeAll { $0.id == id }; library.settings.seedPlaylistIDs.removeAll { $0 == id }; changed()
    }
    func renamePlaylist(_ id: String, name: String) {
        let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, let index = library.playlists.firstIndex(where: { $0.id == id }) else { return }
        library.playlists[index].name = String(title.prefix(100)); changed()
    }
    func playlistTracks(_ id: String) -> [Track] { library.playlists.first { $0.id == id }?.trackIDs.compactMap { library.tracks[$0] } ?? [] }
    func configure(_ mutation: (inout PulseSettings) -> Void, refreshCatalog: Bool = false) {
        mutation(&library.settings); changed(); player.refreshPreparedSelection()
        if refreshCatalog {
            settingsTask?.cancel()
            settingsTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 700_000_000)
                guard !Task.isCancelled else { return }; await self?.refresh()
            }
        }
    }
    private func changed() { persist(); updateRecommendations() }
    func moodTracks(_ mix: MoodMix) -> [Track] { (moodCache[mix.id] ?? []).map(\.track) }
    private func context(for track: Track) -> RecommendationContext? {
        if player.current?.id == track.id, let activeContext { return activeContext }
        let source = player.selectionMood.flatMap { moodCache[$0] } ?? recommendations
        return source.first { $0.id == track.id }?.exposure ?? pulseCache.first { $0.id == track.id }?.exposure
    }
    private func contextualLibrary() -> Library {
        var snapshot = library
        if let id = pulsePlaylistID, let source = snapshot.playlists.first(where: { $0.id == id }) {
            snapshot.likedIDs = []; snapshot.playlists = [source]
            snapshot.settings.genres = []; snapshot.settings.playlistSource = "all"; snapshot.settings.discovery = 0.75
            let seeds = Set(source.trackIDs)
            snapshot.events = snapshot.events.filter { seeds.contains($0.trackID) || !(Set(snapshot.tracks[$0.trackID]?.relatedTo ?? [])).isDisjoint(with: seeds) }
        }
        return snapshot
    }
    private func selectionLibrary() -> Library {
        var result = library; if pulsePlaylistID != nil { result.settings.discovery = 0.75 }; return result
    }
    func play(_ track: Track, list: [Track], context: String? = nil) {
        pulseGeneration = UUID(); pulseWork?.cancel(); linkTask?.cancel()
        let exposure = self.context(for: track)
        selectedContexts.removeAll()
        if let exposure { selectedContexts[track.id] = exposure }
        let hadPlaylist = pulsePlaylistID != nil; pulsePlaylistID = nil
        player.play(track, list: list, context: context)
        if hadPlaylist { updateRecommendations() }
    }
    func startPulse(mood: String? = nil, playlistID: String? = nil) {
        guard !isRestoringLibrary else { return }
        pulseWork?.cancel(); linkTask?.cancel()
        let changedProfile = pulsePlaylistID != playlistID
        pulsePlaylistID = playlistID
        if changedProfile { updateRecommendations() }
        let snapshot = library, excluded = player.current.map { Set([$0.id]) } ?? []
        let token = UUID(); pulseGeneration = token
        let cached = mood.flatMap { moodCache[$0] } ?? pulseCache
        if playlistID == nil, pulseCachePlaylistID == nil, let first = PulseEngine.selectCached(cached, library: snapshot, exclude: excluded, currentID: player.current?.id, index: playbackIndex, mood: mood) {
            if let exposure = first.exposure { selectedContexts[first.id] = exposure }
            player.startPulse(first.track, mood: mood); return
        }
        Task {
            guard pulseGeneration == token else { return }
            let work = Task.detached(priority: .userInitiated) { PulseEngine.rank(Array(snapshot.tracks.values), library: snapshot, limit: 60, mood: mood, exclude: excluded, playlistID: playlistID) }
            pulseWork = work
            let result = await work.value
            guard pulseGeneration == token else { return }
            guard let first = result.first else { message = "Пока нет подходящих треков. Обнови подборки или найди музыку в поиске."; return }
            pulseCache = result
            pulseCachePlaylistID = playlistID
            if let mood { moodCache[mood] = result }
            if let exposure = first.exposure { selectedContexts[first.id] = exposure }
            player.startPulse(first.track, mood: mood)
            if let playlistID { await refreshFromPlaylist(playlistID) }
        }
    }
    private func refreshFromPlaylist(_ id: String) async {
        for track in playlistTracks(id).prefix(4) {
            guard pulsePlaylistID == id else { return }
            if let tracks = try? await catalog.related(to: track) { merge(tracks) }
        }
    }
    func refresh(automatic: Bool = false) async {
#if DEBUG && targetEnvironment(simulator)
        // The native smoke uses controlled audio/catalogue data, never live discovery.
        if automatic && ProcessInfo.processInfo.arguments.contains("--forma-smoke") { return }
#endif
        guard !isRefreshing else { return }
        let networkPolicy = player.networkPolicy
        if automatic {
            guard networkPolicy.reachable, !player.isLoading,
                  Date().timeIntervalSince(lastAutomaticRefresh) >= networkPolicy.automaticRefreshInterval else { return }
            lastAutomaticRefresh = Date()
        }
        isRefreshing = true; defer { isRefreshing = false }
        let settings = library.settings
        let genres = (settings.genres.isEmpty ? ["Pop"] : settings.genres).filter { !settings.excludedGenres.contains($0) }
        let suffix = PulseDirections.suffix(settings), hints = PulseDirections.hints(settings)
        let anchors = PulseEngine.anchors(in: contextualLibrary(), limit: 6)
        let catalog = self.catalog
        enum Request: Sendable { case search(BilingualDiscovery.Search), related(Track), artist(String) }
        let searches = BilingualDiscovery.searches(genres: genres, suffix: suffix, hints: hints, language: settings.languagePreference)
        let selectedSearches: [BilingualDiscovery.Search]
        if automatic && networkPolicy.lean {
            // Keep all six moods and the preferred language, without starting
            // two searches per mood plus every genre while audio needs the VPN.
            selectedSearches = MoodMix.all.compactMap { mood in
                let choices = searches.filter { $0.mood == mood.id }
                return settings.languagePreference == "ru" ? choices.first(where: { $0.hints.contains("discovery:ru") }) : choices.last
            }
        } else { selectedSearches = searches }
        let requests: [Request] = anchors.prefix(networkPolicy.lean ? 2 : 6).map { .related($0) } + settings.preferredArtists.prefix(networkPolicy.lean ? 1 : 3).map { .artist($0) } + selectedSearches.map { .search($0) }
        let parallelism = min(networkPolicy.catalogParallelism, player.current == nil ? 3 : 2)
        var index = 0, successes = 0, failure: String?, collected: [Track] = []
        // Bound parallelism to three network requests; show completed batches immediately.
        await withTaskGroup(of: ([Track], String?).self) { group in
            func submit(_ request: Request) {
                group.addTask {
                    do {
                        let tracks: [Track]
                        switch request {
                        case .search(let intent): tracks = try await catalog.search(intent.query, genre: intent.genre, mood: intent.mood, hints: intent.hints)
                        case .related(let track): tracks = try await catalog.related(to: track)
                        case .artist(let name): tracks = try await catalog.search("\(name) music \(suffix)", hints: hints)
                        }
                        return (tracks, nil)
                    } catch { return ([], error.localizedDescription) }
                }
            }
            while index < min(parallelism, requests.count) { submit(requests[index]); index += 1 }
            for await (tracks, notice) in group {
                if Task.isCancelled { group.cancelAll(); break }
                if notice == nil { collected += tracks; merge(tracks); successes += 1 } else { failure = notice }
                if index < requests.count, !(automatic && player.isLoading) { submit(requests[index]); index += 1 }
            }
        }
        if successes > 0, !Task.isCancelled {
            let snapshot = library, candidates = collected
            let bridges = await Task.detached(priority: .utility) { Array(PulseEngine.rank(candidates, library: snapshot, limit: 12).filter(\.newArtist).prefix(networkPolicy.lean ? 1 : 3).map(\.track)) }.value
            for bridge in bridges {
                guard !Task.isCancelled, !(automatic && player.isLoading) else { return }
                if var next = try? await catalog.related(to: bridge) {
                    for i in next.indices { next[i].relatedTo = Array(Set(next[i].relatedTo + bridge.relatedTo)).sorted() }
                    merge(next)
                }
            }
            UserDefaults.standard.set(4, forKey: "forma.discoveryRevision")
        }
        if successes == 0, !Task.isCancelled, !automatic { message = failure ?? "Каталог пока недоступен. Попробуй ссылку на конкретный трек." }
    }
    func search(_ query: String) async {
        let token = UUID(); searchGeneration = token
        if query.trimmingCharacters(in: .whitespacesAndNewlines).count < 2 { searchResults = []; isSearching = false; return }
        isSearching = true
        do {
            let tracks = try await catalog.search(query)
            guard searchGeneration == token, !Task.isCancelled else { return }
            searchResults = tracks; merge(tracks)
            if player.networkPolicy.canPrewarmExtraTracks { await audioResolver.prewarm(videoIDs: Array(tracks.prefix(3).map(\.id))) }
        } catch is CancellationError { }
        catch { if searchGeneration == token, !Task.isCancelled { message = error.localizedDescription; searchResults = [] } }
        if searchGeneration == token { isSearching = false }
    }
    func openYouTube(_ value: String) async {
        let token = UUID(); pulseGeneration = token; pulseWork?.cancel(); linkTask?.cancel()
        guard let id = VideoID.parse(value) else { message = "Вставь ссылку на трек или видео YouTube."; return }
        if let existing = library.tracks[id] { play(existing, list: [existing]); return }
        let work = Task { await streams.describe(videoID: id) }; linkTask = work
        let track = await work.value
        guard pulseGeneration == token, !Task.isCancelled else { return }
        guard let track else { message = "Не удалось получить сведения о треке. Попробуй поиск по названию."; return }
        merge([track]); play(track, list: [track])
    }
    private func merge(_ tracks: [Track]) {
        library.merge(tracks)
        if library.tracks.count > 3000 {
            let protected = Set(library.likedIDs + library.playlists.flatMap(\.trackIDs) + library.events.map(\.trackID) + (player.current.map { [$0.id] } ?? []))
            for id in library.tracks.keys.sorted() where !protected.contains(id) {
                if library.tracks.count <= 3000 { break }; library.tracks.removeValue(forKey: id)
            }
        }
        persist(); updateRecommendations()
    }
    private func updateRecommendations() {
        let token = UUID(); recommendationGeneration = token
        let snapshot = library, playlistID = pulsePlaylistID
        recommendationTask?.cancel(); rankingWork?.cancel()
        recommendationTask = Task {
            try? await Task.sleep(nanoseconds: 120_000_000)
            guard !Task.isCancelled else { return }
            let work = Task.detached(priority: .utility) {
                let candidates = Array(snapshot.tracks.values)
                let index = PulseEngine.makeIndex(candidates, library: snapshot)
                let home = BilingualDiscovery.rankHome(candidates, library: snapshot, limit: 40, index: index)
                let next = PulseEngine.rank(candidates, library: snapshot, limit: 60, index: index, playlistID: playlistID)
                let moods = Dictionary(uniqueKeysWithValues: MoodMix.all.map { ($0.id, BilingualDiscovery.rankHome(candidates, library: snapshot, limit: 30, mood: $0.id, allowRecent: true, index: index)) })
                return (home, next, moods, index)
            }
            rankingWork = work
            let result = await work.value
            guard recommendationGeneration == token, !Task.isCancelled, playlistID == pulsePlaylistID else { return }
            recommendations = result.0; pulseCache = result.1; pulseCachePlaylistID = playlistID; moodCache = result.2; playbackIndex = result.3
            player.refreshPreparedSelection()
            if player.current == nil, player.networkPolicy.canPrewarmExtraTracks { await audioResolver.prewarm(videoIDs: Array(pulseCache.prefix(3).map(\.id))) }
        }
    }
    func persist(immediately: Bool = false, background: Bool = false) {
        guard didLoadLibrary else { return }
        persistTask?.cancel()
        let snapshot = library
        let lease = background ? BackgroundSaveLease() : nil
        persistTask = Task {
            defer { lease?.finish() }
            if !immediately { try? await Task.sleep(nanoseconds: 250_000_000) }
            guard !Task.isCancelled, let storage else { return }
            do { try await storage.save(snapshot) } catch { message = "Не удалось сохранить библиотеку: \(error.localizedDescription)" }
        }
        scheduleSync()
    }
    private func scheduleSync() {
        guard didLoadLibrary, pcHost != nil, canSynchronizePC, syncBackoff.allows() else { return }
        syncTask?.cancel(); syncTask = Task {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled else { return }; await synchronize()
        }
    }
    func pairPC(_ code: String) async {
        guard !isRestoringLibrary else { return }
        guard canSynchronizePC else { message = "Для подключения ПК нужна общая Wi-Fi сеть."; return }
        guard !isSyncing else { return }
        syncEpoch = UUID(); let epoch = syncEpoch; syncTask?.cancel()
        isSyncing = true
        do {
            try await sync.pair(code)
            guard syncEpoch == epoch else { return }
            syncBase = nil; try await storage?.saveSyncBase(nil)
            guard syncEpoch == epoch else { return }
            pcHost = await sync.connection?.host; isSyncing = false; await synchronize(showErrors: true)
        } catch { guard syncEpoch == epoch else { return }; isSyncing = false; syncStatus = error.localizedDescription; message = error.localizedDescription }
    }
    func disconnectPC() async {
        syncEpoch = UUID(); isSyncing = false; syncTask?.cancel(); await sync.disconnect(); pcHost = nil; syncBase = nil
        try? await storage?.saveSyncBase(nil); syncStatus = "ПК отключён"
    }
    func synchronize(showErrors: Bool = false) async {
        guard didLoadLibrary, !isSyncing, pcHost != nil else { return }
        guard canSynchronizePC else { stopSyncForNetwork(); return }
        guard syncBackoff.allows(manual: showErrors) else { return }
        let epoch = syncEpoch
        isSyncing = true; defer { if syncEpoch == epoch { isSyncing = false } }
        let sent = library
        do {
            let remote = try await sync.synchronize(library: sent, base: syncBase)
            guard epoch == syncEpoch else { return }
            persistTask?.cancel()
            library = LibrarySync.merge(current: LibrarySync.preservingLearning(in: remote, from: sent), base: sent, incoming: library)
            do { try await storage?.saveSynchronized(library, base: remote) }
            catch {
                syncBackoff.failed()
                syncStatus = "Библиотека получена, но сохранить её не удалось"
                message = "Не удалось сохранить библиотеку: \(error.localizedDescription)"; persist(immediately: true); return
            }
            guard epoch == syncEpoch else { return }
            syncBase = remote
            syncBackoff.reset(); updateRecommendations(); syncStatus = "Синхронизировано · \(Date().formatted(date: .omitted, time: .shortened))"
        } catch {
            guard epoch == syncEpoch else { return }
            syncBackoff.failed()
            syncStatus = "ПК недоступен. Изменения сохранены на iPhone"
            if showErrors { message = error.localizedDescription }
        }
    }
    func exportLibrary() throws -> URL {
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent("Forma-iOS-library.json")
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(library).write(to: destination, options: .atomic); return destination
    }
}

/// A finite iOS background lease lets the last library write finish after a swipe
/// to another app, even when playback is paused. Every completion ends the lease.
@MainActor
private final class BackgroundSaveLease {
    private var identifier: UIBackgroundTaskIdentifier = .invalid
    init() {
        identifier = UIApplication.shared.beginBackgroundTask(withName: "Forma library save") { [weak self] in
            Task { @MainActor in self?.finish() }
        }
    }
    func finish() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier); identifier = .invalid
    }
}
