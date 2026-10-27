import Combine
import Foundation
import Network
import UIKit
import FormaCore

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var library = Library()
    @Published private(set) var recommendations: [Recommendation] = []
    @Published private(set) var recentSearchResults: [Track] = []
    @Published private(set) var popularSearchResults: [Track] = []
    @Published private(set) var pulseTrackID: String?
    @Published private(set) var searchResults: [Track] = []
    @Published private(set) var completedSearchQuery = ""
    @Published private(set) var isRefreshing = false
    @Published private(set) var isSearching = false
    @Published private(set) var isSyncing = false
    @Published private(set) var isRestoringLibrary = true
    @Published private(set) var libraryRecoveryMessage: String?
    @Published private(set) var isStartingPulse = false
    @Published private(set) var pcHost: String?
    @Published private(set) var syncStatus = "Подключи ПК по Wi-Fi. Каждый обмен требует подтверждения"
    @Published private(set) var syncProposal: WiFiProposal?
    private var pendingExchange: WiFiCheckpoint?
    @Published var message: String?
    @Published private(set) var localWiFiAvailable = false
    @Published private(set) var verifiedPCNetwork = false
    var canSynchronizePC: Bool { player.networkPolicy.canSyncPC(localWiFi: localWiFiAvailable || verifiedPCNetwork) }
    private let localWiFiMonitor = NWPathMonitor(requiredInterfaceType: .wifi)
    private var syncBackoff = SyncBackoff()
    private var syncRouteAllowed = false
    @Published private(set) var tasteProfile = TasteProfile(library: Library())
    @Published private(set) var discoveredPages = 0
    private var discoveryPlanner = DiscoveryPlanner()
    private var discoveryTask: Task<Void, Never>?
    private var catalogueSeen: [String: Date] = [:]
    private var lastAutomaticRefresh = Date.distantPast
    let player: PlaybackController
    private let audioResolver: any StreamResolving
    private let catalog: any MusicCatalogProviding
    private let sync = SyncClient()
    private let soundAnalyzer = SoundAnalyzer()
    private let genreCatalog = GenreCatalog()
    private var genreTask: Task<Void, Never>?
    private var genreAttempts: [String: Date] = [:]
    private var soundTask: Task<Void, Never>?
    private var soundAttempts: [String: Date] = [:]
    private var storage: LibraryStorage?
    private var storageURL: URL?
    private var didLoadLibrary = false
    private var syncBase: Library?
    private var pcIdentity: String?
    private var saveRevision: UInt64 = 0
    private var moodWarmTask: Task<Void, Never>?
    private var moodWarmRounds = 0
    private var moodCache: [String: [Recommendation]] = [:]
    private var pulseCache: [Recommendation] = []
    private var pulseCacheTrackID: String?
    private var pulseCachePlaylistID: String?
    private var selectedContexts: [String: RecommendationContext] = [:]
    private var activeContext: RecommendationContext?
    private var playbackIndex: PulseEngine.RankingIndex?
    @Published private(set) var pulsePlaylistID: String?
    var isPersonalPulse: Bool { player.selectionSurface == "pulse" && pulsePlaylistID == nil && pulseTrackID == nil }
    private var searchGeneration = UUID()
    private var recommendationGeneration = UUID()
    private var pulseGeneration = UUID()
    private var pulseWork: Task<[Recommendation], Never>?
    private var linkTask: Task<Track?, Never>?
    private var syncEpoch = UUID()
    private var connectionEpoch = UUID()
    private var recommendationTask: Task<Void, Never>?
    private var rankingWork: Task<([Recommendation], [Recommendation], [String: [Recommendation]], PulseEngine.RankingIndex, TasteProfile), Never>?
    private var settingsTask: Task<Void, Never>?
    private var persistTask: Task<Void, Never>?
    private var syncTask: Task<Void, Never>?

    init(playbackResolver: (any StreamResolving)? = nil, catalog: any MusicCatalogProviding = YouTubeCatalog()) {
        self.catalog = catalog
        if let data = UserDefaults.standard.data(forKey: "forma.discoveryPlanner.v3"), let saved = try? JSONDecoder().decode(DiscoveryPlanner.self, from: data) { discoveryPlanner = saved; discoveredPages = saved.successfulPages }
        let streams = YouTubeStreamResolver()
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
            if policy.reachable { scheduleGenreMetadata(); scheduleDiscoveryIfLow() }
            if !policy.canPrewarmExtraTracks { Task { await self.audioResolver.prewarm(videoIDs: []) } }
        }
        player.onSelected = { [weak self] track in
            guard let self else { return }
            self.soundTask?.cancel()
            self.library.merge([track])
            self.activeContext = self.selectedContexts.removeValue(forKey: track.id) ?? self.context(for: track)
        }
        player.onStarted = { [weak self] track in
            guard let self else { return }
            self.library.record(ListeningEvent(trackID: track.id, kind: .play, seconds: 0, ratio: 0, newArtist: PulseDiversity.newArtist(track, library: self.library), recommendation: self.activeContext, surface: self.player.selectionSurface))
            self.persist(); self.updateRecommendations(); self.scheduleSoundAnalysis(track); self.scheduleDiscoveryIfLow()
        }
        player.onFeedback = { [weak self] event in
            guard let self else { return }
            let exposure = self.library.events.last { $0.trackID == event.trackID && $0.kind == .play }
            self.library.record(ListeningEvent(trackID: event.trackID, kind: event.kind, at: event.at, seconds: event.seconds, ratio: event.ratio, mood: event.mood, newArtist: exposure?.newArtist, recommendation: exposure?.recommendation, surface: exposure?.surface))
            self.persist(); self.updateRecommendations()
            if self.library.events.count % 4 == 0 { Task { await self.refresh(automatic: true) } }
        }
        player.pulseNext = { [weak self] excluded, mood in self?.nextPulse(excluded: excluded, mood: mood) }
        player.onPulseLow = { [weak self] in self?.scheduleDiscoveryIfLow(force: true) }
        player.pulseRefill = { [weak self] excluded, mood in
            guard let self else { return nil }
            for _ in 0..<2 {
                await self.refresh()
                guard !Task.isCancelled else { return nil }
                await self.waitForRecommendations()
                if let track = self.nextPulse(excluded: excluded, mood: mood) { return track }
            }
            return nil
        }
        Task {
            await restoreLibrary()
            await sync.retireGoogleCredentials()
            await restorePCConnection(epoch: connectionEpoch)
        }
    }
    deinit {
        moodWarmTask?.cancel()
        localWiFiMonitor.cancel(); recommendationTask?.cancel(); rankingWork?.cancel()
        settingsTask?.cancel(); persistTask?.cancel(); syncTask?.cancel()
        pulseWork?.cancel(); linkTask?.cancel(); soundTask?.cancel(); genreTask?.cancel(); discoveryTask?.cancel()
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
            if library.settings.tastePolicyVersion < RecommendationPolicy.version {
                for name in RecommendationPolicy.preferredArtists where !library.settings.preferredArtists.contains(name) { library.settings.preferredArtists.append(name) }
                library.settings.tastePolicyVersion = RecommendationPolicy.version
            }
            storage = store; didLoadLibrary = true; libraryRecoveryMessage = nil; message = loaded.notice
        } catch {
            // A read/access failure must never be followed by saving an empty profile.
            storage = nil; libraryRecoveryMessage = "Не удалось открыть библиотеку. \(error.localizedDescription)"
        }
        isRestoringLibrary = false; updateRecommendations()
        if didLoadLibrary { persist(immediately: true) }
    }
    func becameActive() async {
        if !isRestoringLibrary, !didLoadLibrary { await restoreLibrary() }
        await restorePCConnection(epoch: connectionEpoch)
        await synchronize()
    }
    func retryLibrary() async { if !isRestoringLibrary { await restoreLibrary() } }
    private func restorePCConnection(epoch: UUID) async {
        guard let connection = await sync.restore() else { return }
        let base = await storage?.syncBase(peerID: connection.pin, allowLegacy: connection.baselineVersion == nil)
        let pending = await storage?.pendingSync(peerID: connection.pin)
        guard connectionEpoch == epoch, pcHost == nil else { return }
        pcHost = connection.host; pcIdentity = connection.pin; syncBase = base
        pendingExchange = pending
        syncStatus = canSynchronizePC ? "ПК подключён. Подготовь обмен и подтверди изменения" : "Изменения сохранены. Для обмена нужна общая Wi-Fi сеть"
        scheduleSync()
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
    func isDisliked(_ track: Track) -> Bool { library.dislikedIDs.contains(track.id) }
    func toggleDislike(_ track: Track) {
        library.merge([track]); let disliked = isDisliked(track)
        library.likedIDs.removeAll { $0 == track.id }; library.events.removeAll { $0.trackID == track.id && $0.kind == .dislike }
        if disliked { library.dislikedIDs.removeAll { $0 == track.id } }
        else { library.dislikedIDs.append(track.id); library.record(.init(trackID: track.id, kind: .dislike, seconds: 0, ratio: 0, recommendation: context(for: track), surface: player.current?.id == track.id ? player.selectionSurface : "library")) }
        changed()
        if !disliked { player.skipDislikedTrack(track.id) }
    }
    func toggleLike(_ track: Track) {
        library.merge([track])
        if isLiked(track) { library.likedIDs.removeAll { $0 == track.id } }
        else { library.dislikedIDs.removeAll { $0 == track.id }; library.events.removeAll { $0.trackID == track.id && $0.kind == .dislike }; library.likedIDs.append(track.id); library.record(.init(trackID: track.id, kind: .like, seconds: 0, ratio: 0, recommendation: context(for: track), surface: player.current?.id == track.id ? player.selectionSurface : "library")) }
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
    func moodTracks(_ mix: MoodMix) -> [Track] { Array((moodCache[mix.id] ?? []).prefix(25)).map(\.track) }
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
        if let id = pulseTrackID, let seed = snapshot.tracks[id] { return TrackPulse.profile(snapshot, seed: seed) }
        return snapshot
    }
    private func selectionLibrary() -> Library {
        var result = contextualLibrary(); if pulsePlaylistID != nil { result.settings.discovery = 0.75 }; return result
    }
    func play(_ track: Track, list: [Track], context: String? = nil) {
        pulseGeneration = UUID(); pulseWork?.cancel(); linkTask?.cancel(); soundTask?.cancel()
        isStartingPulse = false
        let exposure = self.context(for: track)
        selectedContexts.removeAll()
        if let exposure { selectedContexts[track.id] = exposure }
        let hadPlaylist = pulsePlaylistID != nil || pulseTrackID != nil; pulsePlaylistID = nil; pulseTrackID = nil
        player.play(track, list: list, context: context)
        if hadPlaylist { updateRecommendations() }
    }
    func playRecommendation(_ track: Track, mood: String? = nil) {
        guard !isRestoringLibrary else { return }
        pulseGeneration = UUID(); pulseWork?.cancel(); linkTask?.cancel(); soundTask?.cancel()
        isStartingPulse = false
        let source = mood.flatMap { moodCache[$0] } ?? recommendations
        selectedContexts.removeAll()
        if let exposure = source.first(where: { $0.id == track.id })?.exposure { selectedContexts[track.id] = exposure }
        let hadPlaylist = pulsePlaylistID != nil || pulseTrackID != nil; pulsePlaylistID = nil; pulseTrackID = nil
        player.play(track, list: [track], asPulse: true, context: mood)
        if hadPlaylist { updateRecommendations() }
    }
    func startPulse(mood: String? = nil, playlistID: String? = nil) {
        guard !isRestoringLibrary else { return }
        pulseWork?.cancel(); linkTask?.cancel(); soundTask?.cancel()
        selectedContexts.removeAll(); isStartingPulse = true
        let changedProfile = pulsePlaylistID != playlistID || pulseTrackID != nil; pulseTrackID = nil
        pulsePlaylistID = playlistID
        if changedProfile { updateRecommendations() }
        let snapshot = library, excluded = player.current.map { Set([$0.id]) } ?? []
        let token = UUID(); pulseGeneration = token
        let cached = mood.flatMap { moodCache[$0] } ?? pulseCache
        if playlistID == nil, pulseCachePlaylistID == nil, pulseCacheTrackID == nil, let first = PulseEngine.selectCached(cached, library: snapshot, exclude: excluded, currentID: player.current?.id, index: playbackIndex, mood: mood) {
            if let exposure = first.exposure { selectedContexts[first.id] = exposure }
            isStartingPulse = false; player.startPulse(first.track, mood: mood); return
        }
        Task {
            guard pulseGeneration == token else { return }
            let work = Task.detached(priority: .userInitiated) { PulseEngine.rank(Array(snapshot.tracks.values), library: snapshot, limit: 60, mood: mood, exclude: excluded, playlistID: playlistID, retainFamiliarPool: true) }
            pulseWork = work
            let result = await work.value
            guard pulseGeneration == token else { return }
            isStartingPulse = false
            guard let first = result.first else {
                await refresh()
                await waitForRecommendations()
                guard pulseGeneration == token else { return }
                if let track = nextPulse(excluded: excluded, mood: mood) { player.startPulse(track, mood: mood) }
                else { message = "Пока нет подходящих треков. Добавь любимую музыку или обнови Пульс." }
                return
            }
            pulseCache = result; pulseCacheTrackID = nil
            pulseCachePlaylistID = playlistID
            if let mood { moodCache[mood] = result }
            if let exposure = first.exposure { selectedContexts[first.id] = exposure }
            player.startPulse(first.track, mood: mood)
            if let playlistID { await refreshFromPlaylist(playlistID) }
        }
    }
    func tracksForArtist(_ track: Track) async throws -> [Track] {
        let local = library.tracks.values.filter { PulseEngine.fold($0.artist) == PulseEngine.fold(track.artist) }
        guard player.networkPolicy.reachable else { return Array(local) }
        let tracks = try await catalog.artistTracks(track)
        try Task.checkCancellation(); merge(tracks)
        return tracks.isEmpty ? Array(local) : tracks
    }
    func startTrackPulse(_ track: Track) {
        guard !isRestoringLibrary else { return }
        pulseWork?.cancel(); linkTask?.cancel(); soundTask?.cancel()
        let token = UUID(); pulseGeneration = token
        pulsePlaylistID = nil; pulseTrackID = track.id; selectedContexts.removeAll()
        library.merge([track]); pulseCache = []; pulseCachePlaylistID = nil; pulseCacheTrackID = track.id
        isStartingPulse = false; player.play(track, list: [track], asPulse: true)
        updateRecommendations()
        Task {
            do {
                let nearby = try await catalog.related(to: track)
                guard pulseGeneration == token, pulseTrackID == track.id else { return }
                merge(nearby)
                for bridge in nearby.filter({ !TrackPulse.sameSong($0, track) }).prefix(2) {
                    guard pulseGeneration == token, !Task.isCancelled else { return }
                    if let extra = try? await catalog.related(to: bridge) {
                        guard pulseGeneration == token else { return }
                        merge(extra.map { item in var result = item; result.relatedTo = Array(Set(result.relatedTo + [track.id])); return result })
                    }
                }
            } catch { if pulseGeneration == token { message = error.localizedDescription } }
        }
    }
    private func refreshFromPlaylist(_ id: String) async {
        guard pulsePlaylistID == id else { return }
        await refresh()
    }
    private func nextPulse(excluded: Set<String>, mood: String?) -> Track? {
        if let id = pulsePlaylistID, !library.playlists.contains(where: { $0.id == id }) { return nil }
        let source = mood.flatMap { moodCache[$0] } ?? (pulseCachePlaylistID == pulsePlaylistID && pulseCacheTrackID == pulseTrackID ? pulseCache : pulseTrackID == nil ? recommendations : [])
        guard let choice = PulseEngine.selectCached(source, library: selectionLibrary(), exclude: excluded, currentID: player.current?.id, index: playbackIndex, mood: mood) else { return nil }
        if let seed = pulseTrackID.flatMap({ library.tracks[$0] }), TrackPulse.fit(choice.track, seed: seed) <= 0.1 { return nil }
        if let exposure = choice.exposure { selectedContexts[choice.id] = exposure }
        return choice.track
    }
    private func scheduleDiscoveryIfLow(force: Bool = false) {
#if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--forma-smoke") { return }
#endif
        guard didLoadLibrary, player.networkPolicy.reachable, discoveryTask == nil else { return }
        let remaining = pulseCache.filter { !player.pulseExclusions.contains($0.id) }.count
        guard force || remaining < 18 || Date().timeIntervalSince(lastAutomaticRefresh) > 120 else { return }
        // Selection/ranking calls can happen several times in one UI update.
        // This timestamp also bounds empty-source retries and offline recovery.
        guard Date().timeIntervalSince(lastAutomaticRefresh) > 8 else { return }
        Task { [weak self] in await self?.refresh(automatic: true) }
    }
    func refresh(automatic: Bool = false) async {
#if DEBUG && targetEnvironment(simulator)
        if automatic && ProcessInfo.processInfo.arguments.contains("--forma-smoke") { return }
#endif
        guard !isRestoringLibrary, player.networkPolicy.reachable else { return }
        if let work = discoveryTask { await work.value; return }
        if automatic && Date().timeIntervalSince(lastAutomaticRefresh) < 8 { return }
        lastAutomaticRefresh = Date(); isRefreshing = true
        let work = Task { [weak self] in await self?.discoverBatch(); return () }
        discoveryTask = work
        await work.value
        discoveryTask = nil; isRefreshing = false
    }
    private func discoverBatch() async {
        let source = contextualLibrary()
        let underfilled = MoodMix.all.filter { (moodCache[$0.id]?.prefix(25).count ?? 0) < 25 }.map(\.id)
        let planner = discoveryPlanner, discoveries = pulseCache.map(\.track)
        let mood = player.isPlaying || player.isLoading ? player.selectionMood : nil
        let jobLimit = !underfilled.isEmpty && !player.isPlaying && !player.isLoading ? 18 : 10
        let planning = Task.detached(priority: .utility) {
            var next = planner
            let jobs = next.plan(library: source, discoveries: discoveries, limit: jobLimit, mood: mood, underfilledMoods: underfilled)
            return (next, jobs)
        }
        let (nextPlanner, jobs) = await planning.value
        guard !Task.isCancelled else { planning.cancel(); return }
        discoveryPlanner = nextPlanner
        guard !jobs.isEmpty else { return }
        let catalog = self.catalog
        let parallelism = min(3, player.networkPolicy.catalogParallelism)
        var next = 0, successes = 0
        var collected: [Track] = []
        await withTaskGroup(of: (DiscoveryRequest?, DiscoveryPage?).self) { group in
            // A damaged radio endpoint must not hold the whole refill for minutes.
            group.addTask { try? await Task.sleep(nanoseconds: 25_000_000_000); return (nil, nil) }
            func submit(_ job: DiscoveryRequest) {
                group.addTask { (job, try? await catalog.discoveryPage(job)) }
            }
            var completed = 0
            while next < min(parallelism, jobs.count) { submit(jobs[next]); next += 1 }
            for await (job, page) in group {
                guard let job, !Task.isCancelled else { group.cancelAll(); break }
                completed += 1; discoveryPlanner.complete(job, page: page)
                if let page { successes += 1; collected.append(contentsOf: page.tracks) }
                if next < jobs.count { submit(jobs[next]); next += 1 }
                if completed == jobs.count { group.cancelAll(); break }
            }
        }
        guard !Task.isCancelled else { return }
        discoveredPages = discoveryPlanner.successfulPages
        if let data = try? JSONEncoder().encode(discoveryPlanner) { UserDefaults.standard.set(data, forKey: "forma.discoveryPlanner.v3") }
        // One merge/rebuild per batch avoids repeatedly cancelling a 3,000-track
        // ranking job as individual network responses arrive.
        if !collected.isEmpty { merge(collected) }
        else if successes == 0, !player.isPlaying { message = "Не удалось обновить Пульс. Проверим подключение и попробуем снова." }
    }
    func search(_ query: String) async {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = UUID(); searchGeneration = token
        defer { if searchGeneration == token { isSearching = false } }
        if query.count < 2 { searchResults = []; recentSearchResults = []; popularSearchResults = []; completedSearchQuery = query; isSearching = false; return }
        isSearching = true
        do {
            async let recent = try? catalog.orderedSearch(query, recent: true)
            async let popular = try? catalog.orderedSearch(query, recent: false)
            let response = await (recent, popular)
            try Task.checkCancellation()
            guard response.0 != nil || response.1 != nil else { throw YouTubeCatalog.CatalogError.unavailable }
            let columns = (response.0 ?? [], response.1 ?? [])
            let tracks = (columns.0 + columns.1).reduce(into: [Track]()) { result, track in if !result.contains(where: { $0.id == track.id }) { result.append(track) } }
            guard searchGeneration == token, !Task.isCancelled else { return }
            recentSearchResults = columns.0; popularSearchResults = columns.1
            searchResults = tracks; completedSearchQuery = query; merge(tracks)
            if player.networkPolicy.canPrewarmExtraTracks { await audioResolver.prewarm(videoIDs: Array(tracks.prefix(3).map(\.id))) }
        } catch is CancellationError { }
        catch { if searchGeneration == token, !Task.isCancelled { message = error.localizedDescription; searchResults = []; recentSearchResults = []; popularSearchResults = []; completedSearchQuery = query } }
    }
    func openYouTube(_ value: String) async {
        let token = UUID(); pulseGeneration = token; pulseWork?.cancel(); linkTask?.cancel(); soundTask?.cancel()
        isStartingPulse = false
        guard let id = VideoID.parse(value) else { message = "Вставь ссылку на трек или видео YouTube."; return }
        if let existing = library.tracks[id] { play(existing, list: [existing]); return }
        let work = Task { await catalog.describe(videoID: id) }; linkTask = work
        let track = await work.value
        guard pulseGeneration == token, !Task.isCancelled else { return }
        guard let track else { message = "Не удалось получить сведения о треке. Попробуй поиск по названию."; return }
        merge([track]); play(track, list: [track])
    }
    private func merge(_ tracks: [Track]) {
        library.merge(tracks)
        let now = Date()
        for track in tracks { catalogueSeen[track.id] = now }
        let protected = Set(pulseCache.map(\.id) + recommendations.map(\.id) + searchResults.map(\.id) + (player.current.map { [$0.id] } ?? []))
        DiscoveryCache.trim(&library, seen: catalogueSeen, protected: protected, limit: 4000)
        catalogueSeen = catalogueSeen.filter { library.tracks[$0.key] != nil }
        persist(); updateRecommendations()
    }
    private func waitForRecommendations() async {
        // Genre metadata or a fresh save can replace an in-flight ranking job.
        // Await the replacement rather than returning from the cancelled job.
        while !Task.isCancelled {
            let token = recommendationGeneration
            await recommendationTask?.value
            if token == recommendationGeneration { return }
        }
    }
    private func updateRecommendations() {
        let token = UUID(); recommendationGeneration = token
        let snapshot = library, playlistID = pulsePlaylistID, trackID = pulseTrackID
        recommendationTask?.cancel(); rankingWork?.cancel()
        recommendationTask = Task {
            try? await Task.sleep(nanoseconds: 120_000_000)
            guard !Task.isCancelled else { return }
            let work = Task.detached(priority: .utility) {
                let candidates = Array(snapshot.tracks.values)
                let index = PulseEngine.makeIndex(candidates, library: snapshot)
                let home = BilingualDiscovery.rankHome(candidates, library: snapshot, limit: 40, index: index)
                let next = PulseEngine.rank(candidates, library: snapshot, limit: 60, index: index, playlistID: playlistID, trackID: trackID, retainFamiliarPool: true)
                let moods = Dictionary(uniqueKeysWithValues: MoodMix.all.map { ($0.id, PulseEngine.rank(candidates, library: snapshot, limit: 25, mood: $0.id, allowRecent: true, index: index, retainFamiliarPool: true)) })
                return (home, next, moods, index, TasteProfile(library: snapshot))
            }
            rankingWork = work
            let result = await work.value
            guard recommendationGeneration == token, !Task.isCancelled, playlistID == pulsePlaylistID, trackID == pulseTrackID else { return }
            recommendations = result.0; pulseCache = result.1; pulseCacheTrackID = trackID; pulseCachePlaylistID = playlistID; moodCache = result.2; playbackIndex = result.3; tasteProfile = result.4
            scheduleGenreMetadata()
            scheduleMoodWarmup()
            player.pulseCandidatesChanged()
            if player.current == nil, player.networkPolicy.canPrewarmExtraTracks { await audioResolver.prewarm(videoIDs: Array(pulseCache.prefix(3).map(\.id))) }
        }
    }
    private func scheduleMoodWarmup() {
#if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--forma-smoke") { return }
#endif
        guard moodWarmTask == nil, moodWarmRounds < 8, didLoadLibrary, player.networkPolicy.reachable,
              UIApplication.shared.applicationState == .active,
              MoodMix.all.contains(where: { (moodCache[$0.id]?.count ?? 0) < 25 }) else { return }
        moodWarmTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            guard let self else { return }
            defer { self.moodWarmTask = nil }
            guard !Task.isCancelled, UIApplication.shared.applicationState == .active else { return }
            self.moodWarmRounds += 1
            await self.refresh(automatic: true)
        }
    }
    private func scheduleGenreMetadata() {
#if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--forma-smoke") { return }
#endif
        guard genreTask == nil, didLoadLibrary, player.networkPolicy.reachable else { return }
        let now = Date()
        var seen = Set<String>()
        let anchors = PulseEngine.genreMetadataAnchors(in: library, limit: Int.max)
        let pool = Array(anchors.prefix(4)) + pulseCache.prefix(6).map(\.track) + Array(anchors.dropFirst(4)) + recommendations.prefix(12).map(\.track)
        let tracks = pool.filter { track in
            seen.insert(track.id).inserted && now.timeIntervalSince(genreAttempts[track.id] ?? .distantPast) > 600 && now.timeIntervalSince1970 * 1000 - (library.tracks[track.id]?.genreEvidence?.checkedAt ?? 0) > 7 * 86400000
        }
        guard !tracks.isEmpty else { return }
        genreTask = Task(priority: .utility) {
            defer { genreTask = nil }
            for track in tracks.prefix(10) {
                guard !Task.isCancelled else { return }
                genreAttempts[track.id] = Date()
                if let evidence = await genreCatalog.lookup(track), !Task.isCancelled, let latest = library.tracks[track.id], GenreClassifier.recordingIdentity(latest.title) == GenreClassifier.recordingIdentity(track.title), GenreClassifier.artistIdentity(latest.artist) == GenreClassifier.artistIdentity(track.artist) {
                    var updated = evidence
                    if let old = latest.genreEvidence?.releasedAt { updated.releasedAt = min(old, evidence.releasedAt ?? old) }
                    library.tracks[track.id]?.genreEvidence = updated
                    persist(); updateRecommendations()
                }
            }
        }
    }
    func soundPolicyChanged() { soundTask?.cancel(); if let track = player.current { scheduleSoundAnalysis(track) } }
    private func scheduleSoundAnalysis(_ current: Track) {
        soundTask?.cancel()
        guard UserDefaults.standard.object(forKey: "forma.soundAnalysis") as? Bool != false else { return }
        let cellular = UserDefaults.standard.object(forKey: "forma.soundCellular") as? Bool != false
        guard cellular || !player.networkPolicy.lean else { return }
        let unanalysed = tasteProfile.seeds.first { library.tracks[$0.id]?.soundProfile == nil && Date().timeIntervalSince(soundAttempts[$0.id] ?? .distantPast) > 3600 }
        let pool = [current] + pulseCache.prefix(2).map(\.track) + (unanalysed.map { [$0] } ?? [])
        var seen = Set<String>(); let tracks = pool.filter { library.tracks[$0.id]?.soundProfile == nil && seen.insert($0.id).inserted }
        soundTask = Task(priority: .utility) {
            for track in tracks.prefix(4) {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                guard !Task.isCancelled, !player.isLoading else { return }
                soundAttempts[track.id] = Date()
                if let profile = await soundAnalyzer.analyze(track, resolver: audioResolver), !Task.isCancelled, library.tracks[track.id] != nil {
                    library.tracks[track.id]?.soundProfile = profile; persist(); updateRecommendations()
                }
            }
        }
    }
    func persist(immediately: Bool = false, background: Bool = false) {
        guard didLoadLibrary else { return }
        persistTask?.cancel()
        saveRevision += 1; let revision = saveRevision
        let snapshot = library
        let lease = background ? BackgroundSaveLease() : nil
        persistTask = Task {
            defer { lease?.finish() }
            if !immediately { try? await Task.sleep(nanoseconds: 250_000_000) }
            guard !Task.isCancelled, let storage else { return }
            do { try await storage.save(snapshot, revision: revision) }
            catch { if !Task.isCancelled, saveRevision == revision { message = "Не удалось сохранить библиотеку: \(error.localizedDescription)" } }
        }
        scheduleSync()
    }
    private func scheduleSync() {
        guard didLoadLibrary, pcHost != nil && canSynchronizePC && pendingExchange != nil else { return }
        let delay = max(5, syncBackoff.nextAttempt.timeIntervalSinceNow)
        syncTask?.cancel(); syncTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }; await synchronize()
        }
    }
    func pairPC(_ code: String) async {
        guard !isRestoringLibrary else { return }
        guard !isSyncing else { return }
        connectionEpoch = UUID(); let epoch = connectionEpoch; syncEpoch = UUID(); syncTask?.cancel()
        isSyncing = true
        do {
            let previous = await sync.restore()
            try await sync.pair(code)
            guard connectionEpoch == epoch else { return }
            let connection = await sync.connection
            guard connectionEpoch == epoch else { return }
            let samePeer = pcIdentity == connection?.pin
            let sameDevice = samePeer && previous?.token == connection?.token
            pcHost = connection?.host; pcIdentity = connection?.pin; verifiedPCNetwork = true
            if !samePeer { syncBase = nil; try await storage?.saveSyncBase(nil) }
            if !sameDevice { try await storage?.savePendingSync(nil); pendingExchange = nil; syncProposal = nil }
            updateSyncRoute()
            guard connectionEpoch == epoch else { return }
            isSyncing = false; await synchronize(showErrors: true)
        } catch { guard connectionEpoch == epoch else { return }; isSyncing = false; syncStatus = error.localizedDescription; message = error.localizedDescription }
    }
    func checkPCConnection(_ code: String) async {
        guard !isSyncing else { return }
        let epoch = connectionEpoch; isSyncing = true
        defer { if epoch == connectionEpoch { isSyncing = false; scheduleSync() } }
        do {
            let host = try await sync.checkConnection(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : code)
            guard epoch == connectionEpoch else { return }
            verifiedPCNetwork = true; updateSyncRoute()
            syncStatus = "ПК доступен · \(host). " + (pcHost == nil ? "Нажми «Подключить ПК»." : "Можно подготовить обмен.")
        } catch { guard epoch == connectionEpoch else { return }; syncStatus = error.localizedDescription; message = error.localizedDescription }
    }
    func disconnectPC() async {
        connectionEpoch = UUID(); let epoch = connectionEpoch; syncEpoch = UUID(); isSyncing = false; syncTask?.cancel(); await sync.disconnect()
        guard connectionEpoch == epoch else { return }
        verifiedPCNetwork = false
        pcHost = nil; pcIdentity = nil; syncBase = nil; pendingExchange = nil; syncProposal = nil
        try? await storage?.saveSyncBase(nil)
        try? await storage?.savePendingSync(nil)
        if connectionEpoch == epoch { syncStatus = "ПК отключён" }
    }
    func synchronize(showErrors: Bool = false) async {
        guard didLoadLibrary, !isSyncing, pcHost != nil, let pcIdentity, let storage else { return }
        guard canSynchronizePC else { stopSyncForNetwork(); if showErrors { message = "Для обмена нужна общая Wi-Fi сеть." }; return }
        guard syncBackoff.allows(manual: showErrors) else { return }
        if pendingExchange == nil && !showErrors { return }
        let epoch = syncEpoch
        isSyncing = true; defer { if syncEpoch == epoch { isSyncing = false; scheduleSync() } }
        do {
            if pendingExchange == nil {
                let checkpoint = WiFiCheckpoint(peerID: pcIdentity, sent: library, base: syncBase)
                try await storage.savePendingSync(checkpoint)
                guard epoch == syncEpoch else { return }; pendingExchange = checkpoint
            }
            guard let checkpoint = pendingExchange else { return }
            if checkpoint.applied { try await finishExchange(checkpoint, epoch: epoch); return }
            let proposal = showErrors && syncProposal == nil ? try await sync.prepare(checkpoint) : try await sync.review(checkpoint.id)
            guard epoch == syncEpoch else { return }
            syncProposal = proposal; syncBackoff.reset()
            try await receiveProposal(proposal, checkpoint: checkpoint, epoch: epoch)
        } catch SyncError.proposalMissing {
            guard epoch == syncEpoch else { return }
            do { try await storage.savePendingSync(nil) } catch { message = error.localizedDescription; return }
            guard epoch == syncEpoch else { return }
            pendingExchange = nil; syncProposal = nil; syncBackoff.reset()
            syncStatus = "Срок хранения пакета истёк. Подготовь новый обмен; библиотека сохранена"
        } catch {
            guard epoch == syncEpoch else { return }; syncBackoff.failed()
            syncStatus = error.localizedDescription
            if showErrors { message = error.localizedDescription }
        }
    }
    func approveExchange() async {
        guard let checkpoint = pendingExchange, syncProposal?.status == .pending, !isSyncing, canSynchronizePC else { return }
        let epoch = syncEpoch; isSyncing = true
        defer { if epoch == syncEpoch { isSyncing = false; scheduleSync() } }
        do {
            let proposal = try await sync.approve(checkpoint.id)
            guard epoch == syncEpoch else { return }; syncProposal = proposal
            try await receiveProposal(proposal, checkpoint: checkpoint, epoch: epoch)
        } catch { if epoch == syncEpoch { syncStatus = "Не удалось подтвердить обмен"; message = error.localizedDescription; await refreshProposalAfterFailure(checkpoint.id) } }
    }
    private func refreshProposalAfterFailure(_ id: String) async {
        let epoch = syncEpoch
        if let proposal = try? await sync.review(id), epoch == syncEpoch { syncProposal = proposal }
    }
    func rejectExchange() async {
        guard let checkpoint = pendingExchange, !isSyncing, canSynchronizePC else { return }
        let epoch = syncEpoch; isSyncing = true
        defer { if epoch == syncEpoch { isSyncing = false; scheduleSync() } }
        do {
            let proposal = try await sync.reject(checkpoint.id)
            guard epoch == syncEpoch else { return }; syncProposal = proposal
            try await receiveProposal(proposal, checkpoint: checkpoint, epoch: epoch)
        } catch { if epoch == syncEpoch { message = error.localizedDescription; await refreshProposalAfterFailure(checkpoint.id) } }
    }
    private func receiveProposal(_ proposal: WiFiProposal, checkpoint: WiFiCheckpoint, epoch: UUID) async throws {
        guard epoch == syncEpoch, let storage, let pcIdentity else { return }
        switch proposal.status {
        case .pending: syncStatus = "Ожидает подтверждения на iPhone или ПК. Библиотека не изменена"
        case .committing: syncStatus = "ПК сохраняет подтверждённый обмен"
        case .approved:
            let merged = try checkpoint.mergingApproved(proposal, into: library)
            guard let remote = proposal.library else { throw WiFiExchangeError.invalidProposal }
            persistTask?.cancel(); saveRevision += 1; library = merged; updateRecommendations()
            try await storage.saveSynchronized(merged, base: remote, peerID: pcIdentity, revision: saveRevision)
            guard epoch == syncEpoch else { return }; syncBase = remote
            var durable = checkpoint; durable.applied = true
            try await storage.savePendingSync(durable)
            guard epoch == syncEpoch else { return }; pendingExchange = durable
            try await finishExchange(durable, epoch: epoch)
        case .rejected, .stale:
            try await sync.acknowledge(checkpoint.id)
            guard epoch == syncEpoch else { return }
            try await storage.savePendingSync(nil)
            guard epoch == syncEpoch else { return }; pendingExchange = nil; syncProposal = nil
            syncStatus = proposal.status == .rejected ? "Обмен отклонён. Библиотеки не изменены" : "Просмотр устарел. Подготовь новый обмен"
        }
    }
    private func finishExchange(_ checkpoint: WiFiCheckpoint, epoch: UUID) async throws {
        try await sync.acknowledge(checkpoint.id)
        guard epoch == syncEpoch else { return }; try await storage?.savePendingSync(nil)
        guard epoch == syncEpoch else { return }
        pendingExchange = nil; syncProposal = nil; syncBackoff.reset()
        syncStatus = "Подтверждённый обмен завершён · \(Date().formatted(date: .omitted, time: .shortened))"
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
