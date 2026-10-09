import Combine
import Foundation
import FormaCore

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var library = Library()
    @Published private(set) var recommendations: [Recommendation] = []
    @Published private(set) var searchResults: [Track] = []
    @Published private(set) var isRefreshing = false
    @Published private(set) var isSearching = false
    @Published private(set) var isSyncing = false
    @Published private(set) var pcHost: String?
    @Published private(set) var syncStatus = "Подключи ПК, чтобы перенести библиотеку"
    @Published var message: String?
    let player: PlaybackController
    private let streams: YouTubeStreamResolver
    private let catalog = YouTubeCatalog()
    private let sync = SyncClient()
    private var storage: LibraryStorage?
    private var syncBase: Library?
    private var moodCache: [String: [Track]] = [:]
    private var pulseCache: [Track] = []
    private var pulsePlaylistID: String?
    private var searchGeneration = UUID()
    private var recommendationGeneration = UUID()
    private var pulseGeneration = UUID()
    private var syncEpoch = UUID()
    private var recommendationTask: Task<Void, Never>?
    private var rankingWork: Task<([Recommendation], [Track], [String: [Track]]), Never>?
    private var settingsTask: Task<Void, Never>?
    private var persistTask: Task<Void, Never>?
    private var syncTask: Task<Void, Never>?

    init(playbackResolver: (any StreamResolving)? = nil) {
        let streams = YouTubeStreamResolver(); self.streams = streams
        player = PlaybackController(resolver: playbackResolver ?? streams)
        if let directory = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true) {
            let url = directory.appendingPathComponent("forma-ios-library.json")
            storage = LibraryStorage(url: url)
            do { let loaded = try LibraryDiskStore(url: url).load(); library = loaded.library; message = loaded.notice }
            catch { message = "Не удалось прочитать библиотеку: \(error.localizedDescription)" }
        }
        updateRecommendations()
        player.onStarted = { [weak self] track in
            guard let self else { return }
            self.library.record(ListeningEvent(trackID: track.id, kind: .play, seconds: 0, ratio: 0, newArtist: PulseDiversity.newArtist(track, library: self.library)))
            self.persist(); self.updateRecommendations()
        }
        player.onFeedback = { [weak self] event in
            guard let self else { return }
            let exposure = self.library.events.last { $0.trackID == event.trackID && $0.kind == .play }
            self.library.record(ListeningEvent(trackID: event.trackID, kind: event.kind, at: event.at, seconds: event.seconds, ratio: event.ratio, mood: event.mood, newArtist: exposure?.newArtist))
            self.persist(); self.updateRecommendations()
            if self.library.events.count % 4 == 0 { Task { await self.refresh() } }
        }
        player.pulseNext = { [weak self] excluded, mood in
            guard let self else { return nil }
            let source = mood.flatMap { self.moodCache[$0] } ?? self.pulseCache
            return PulseDiversity.next(source, library: self.library, exclude: excluded, currentID: self.player.current?.id)
        }
        Task {
            let connection = await sync.restore(); pcHost = connection?.host
            syncBase = await storage?.syncBase()
            if pcHost != nil { syncStatus = "ПК подключён. Синхронизируем в общей Wi-Fi сети" }
        }
    }
    func prepareTracks(_ tracks: [Track]) async { await streams.prewarm(videoIDs: Array(tracks.prefix(3).map(\.id))) }
    var liked: [Track] { library.likedIDs.compactMap { library.tracks[$0] } }
    func isLiked(_ track: Track) -> Bool { library.likedIDs.contains(track.id) }
    func toggleLike(_ track: Track) {
        library.merge([track])
        if isLiked(track) { library.likedIDs.removeAll { $0 == track.id } }
        else { library.likedIDs.append(track.id) }
        changed()
    }
    func createPlaylist(_ name: String) {
        let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        library.playlists.append(Playlist(name: String(title.prefix(100)), trackIDs: [])); changed()
    }
    func add(_ track: Track, to playlistID: String) {
        guard let index = library.playlists.firstIndex(where: { $0.id == playlistID }) else { return }
        library.merge([track]); if !library.playlists[index].trackIDs.contains(track.id) { library.playlists[index].trackIDs.append(track.id) }; changed()
    }
    func remove(_ track: Track, from playlistID: String) {
        guard let index = library.playlists.firstIndex(where: { $0.id == playlistID }) else { return }
        library.playlists[index].trackIDs.removeAll { $0 == track.id }; changed()
    }
    func deletePlaylist(_ id: String) { library.playlists.removeAll { $0.id == id }; changed() }
    func renamePlaylist(_ id: String, name: String) {
        let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, let index = library.playlists.firstIndex(where: { $0.id == id }) else { return }
        library.playlists[index].name = String(title.prefix(100)); changed()
    }
    func playlistTracks(_ id: String) -> [Track] { library.playlists.first { $0.id == id }?.trackIDs.compactMap { library.tracks[$0] } ?? [] }
    func configure(_ mutation: (inout PulseSettings) -> Void, refreshCatalog: Bool = false) {
        mutation(&library.settings); changed()
        if refreshCatalog {
            settingsTask?.cancel()
            settingsTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 700_000_000)
                guard !Task.isCancelled else { return }; await self?.refresh()
            }
        }
    }
    private func changed() { persist(); updateRecommendations() }
    func moodTracks(_ mix: MoodMix) -> [Track] { moodCache[mix.id] ?? [] }
    private func contextualLibrary() -> Library {
        var snapshot = library
        if let id = pulsePlaylistID, let source = snapshot.playlists.first(where: { $0.id == id }) {
            snapshot.likedIDs = Array(Set(snapshot.likedIDs + source.trackIDs))
            snapshot.playlists.append(Playlist(id: "pulse-context", name: source.name, trackIDs: source.trackIDs))
        }
        return snapshot
    }
    func startPulse(mood: String? = nil, playlistID: String? = nil) {
        pulsePlaylistID = playlistID
        let snapshot = contextualLibrary(), excluded = player.current.map { Set([$0.id]) } ?? []
        let token = UUID(); pulseGeneration = token
        let cached = mood.flatMap { moodCache[$0] } ?? pulseCache
        if playlistID == nil, let first = PulseDiversity.next(cached, library: snapshot, exclude: excluded, currentID: player.current?.id) {
            player.startPulse(first, mood: mood); return
        }
        Task {
            let result = await Task.detached(priority: .userInitiated) { PulseEngine.rank(Array(snapshot.tracks.values), library: snapshot, limit: 60, mood: mood, exclude: excluded) }.value
            guard pulseGeneration == token else { return }
            guard let first = result.first else { message = "Пока нет подходящих треков. Обнови подборки или найди музыку в поиске."; return }
            pulseCache = result.map(\.track)
            if let mood { moodCache[mood] = result.map(\.track) }
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
    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true; defer { isRefreshing = false }
        let settings = library.settings
        let genres = (settings.genres.isEmpty ? ["Pop"] : settings.genres).filter { !settings.excludedGenres.contains($0) }
        let suffix = PulseDirections.suffix(settings), hints = PulseDirections.hints(settings)
        let anchors = PulseEngine.anchors(in: contextualLibrary(), limit: 6)
        let catalog = self.catalog
        enum Request: Sendable { case search(BilingualDiscovery.Search), related(Track), artist(String) }
        let requests: [Request] = BilingualDiscovery.searches(genres: genres, suffix: suffix, hints: hints).map { .search($0) } + anchors.map { .related($0) } + settings.preferredArtists.prefix(3).map { .artist($0) }
        let parallelism = player.current == nil ? 3 : 2
        var index = 0, successes = 0, failure: String?
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
                if notice == nil { merge(tracks); successes += 1 } else { failure = notice }
                if index < requests.count { submit(requests[index]); index += 1 }
            }
        }
        if successes > 0, !Task.isCancelled { UserDefaults.standard.set(3, forKey: "forma.discoveryRevision") }
        if successes == 0, !Task.isCancelled { message = failure ?? "Каталог пока недоступен. Попробуй ссылку на конкретный трек." }
    }
    func search(_ query: String) async {
        let token = UUID(); searchGeneration = token
        if query.trimmingCharacters(in: .whitespacesAndNewlines).count < 2 { searchResults = []; isSearching = false; return }
        isSearching = true
        do {
            let tracks = try await catalog.search(query)
            guard searchGeneration == token, !Task.isCancelled else { return }
            searchResults = tracks; merge(tracks)
            await streams.prewarm(videoIDs: Array(tracks.prefix(3).map(\.id)))
        } catch is CancellationError { }
        catch { if searchGeneration == token, !Task.isCancelled { message = error.localizedDescription; searchResults = [] } }
        if searchGeneration == token { isSearching = false }
    }
    func openYouTube(_ value: String) async {
        guard let id = VideoID.parse(value) else { message = "Вставь ссылку на трек или видео YouTube."; return }
        if let existing = library.tracks[id] { player.play(existing, list: [existing]); return }
        guard let track = await streams.describe(videoID: id) else { message = "Не удалось получить сведения о треке. Попробуй поиск по названию."; return }
        merge([track]); player.play(track, list: [track])
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
        let snapshot = library, pulse = contextualLibrary()
        recommendationTask?.cancel(); rankingWork?.cancel()
        recommendationTask = Task {
            try? await Task.sleep(nanoseconds: 120_000_000)
            guard !Task.isCancelled else { return }
            let work = Task.detached(priority: .utility) {
                let candidates = Array(snapshot.tracks.values)
                let index = PulseEngine.makeIndex(candidates, library: snapshot)
                let home = BilingualDiscovery.rankHome(candidates, library: snapshot, limit: 40, index: index)
                let next = PulseEngine.rank(candidates, library: pulse, limit: 60, index: index).map(\.track)
                let moods = Dictionary(uniqueKeysWithValues: MoodMix.all.map { ($0.id, BilingualDiscovery.rankHome(candidates, library: snapshot, limit: 30, mood: $0.id, allowRecent: true, index: index).map(\.track)) })
                return (home, next, moods)
            }
            rankingWork = work
            let result = await work.value
            guard recommendationGeneration == token, !Task.isCancelled else { return }
            recommendations = result.0; pulseCache = result.1; moodCache = result.2
            player.refreshPreparedSelection()
            if player.current == nil { await streams.prewarm(videoIDs: Array(pulseCache.prefix(3).map(\.id))) }
        }
    }
    func persist(immediately: Bool = false) {
        persistTask?.cancel()
        let snapshot = library
        persistTask = Task {
            if !immediately { try? await Task.sleep(nanoseconds: 250_000_000) }
            guard !Task.isCancelled, let storage else { return }
            do { try await storage.save(snapshot) } catch { message = "Не удалось сохранить библиотеку: \(error.localizedDescription)" }
        }
        scheduleSync()
    }
    private func scheduleSync() {
        guard pcHost != nil else { return }
        syncTask?.cancel(); syncTask = Task {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled else { return }; await synchronize()
        }
    }
    func pairPC(_ code: String) async {
        guard !isSyncing else { return }
        isSyncing = true
        do {
            try await sync.pair(code); syncBase = nil; try await storage?.saveSyncBase(nil)
            pcHost = await sync.connection?.host; isSyncing = false; await synchronize(showErrors: true)
        } catch { isSyncing = false; syncStatus = error.localizedDescription; message = error.localizedDescription }
    }
    func disconnectPC() async {
        syncEpoch = UUID(); isSyncing = false; syncTask?.cancel(); await sync.disconnect(); pcHost = nil; syncBase = nil
        try? await storage?.saveSyncBase(nil); syncStatus = "ПК отключён"
    }
    func synchronize(showErrors: Bool = false) async {
        guard !isSyncing, pcHost != nil else { return }
        isSyncing = true; defer { isSyncing = false }
        let epoch = syncEpoch
        let sent = library
        do {
            let remote = try await sync.synchronize(library: sent, base: syncBase)
            guard epoch == syncEpoch else { return }
            persistTask?.cancel()
            library = LibrarySync.merge(current: remote, base: sent, incoming: library)
            syncBase = remote; try await storage?.saveSyncBase(remote); try await storage?.save(library)
            updateRecommendations(); syncStatus = "Синхронизировано · \(Date().formatted(date: .omitted, time: .shortened))"
        } catch {
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
