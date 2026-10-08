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
    @Published var message: String?
    let player: PlaybackController
    private let streams: YouTubeStreamResolver
    private let catalog = YouTubeCatalog()
    private let libraryURL: URL?
    private var searchGeneration = UUID()
    private var settingsTask: Task<Void, Never>?

    init() {
        let streams = YouTubeStreamResolver(); self.streams = streams
        player = PlaybackController(resolver: streams)
        let directory = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        libraryURL = directory?.appendingPathComponent("forma-ios-library.json")
        if let libraryURL {
            do { let loaded = try LibraryDiskStore(url: libraryURL).load(); library = loaded.library; message = loaded.notice }
            catch { message = "Не удалось прочитать библиотеку: \(error.localizedDescription)" }
        }
        updateRecommendations()
        player.onFeedback = { [weak self] event in
            guard let self else { return }
            self.library.record(event); self.persist(); self.updateRecommendations()
        }
        player.pulseNext = { [weak self] excluded, mood in
            guard let self else { return nil }
            return PulseEngine.rank(Array(self.library.tracks.values), library: self.library, limit: 1, mood: mood, exclude: excluded).first?.track
        }
    }
    var liked: [Track] { library.likedIDs.compactMap { library.tracks[$0] } }
    func isLiked(_ track: Track) -> Bool { library.likedIDs.contains(track.id) }
    func toggleLike(_ track: Track) {
        library.merge([track])
        if isLiked(track) { library.likedIDs.removeAll { $0 == track.id } }
        else { library.likedIDs.append(track.id) }
        persist(); updateRecommendations()
    }
    func configure(_ mutation: (inout PulseSettings) -> Void, refreshCatalog: Bool = false) {
        mutation(&library.settings); persist(); updateRecommendations()
        if refreshCatalog {
            settingsTask?.cancel()
            settingsTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        }
    }
    func moodTracks(_ mix: MoodMix) -> [Track] {
        PulseEngine.rank(Array(library.tracks.values), library: library, limit: 20, mood: mix.id, allowRecent: true).map(\.track)
    }
    func startPulse(mood: String? = nil) {
        guard let track = PulseEngine.rank(Array(library.tracks.values), library: library, limit: 1, mood: mood, exclude: player.current.map { Set([$0.id]) } ?? []).first?.track else {
            message = "Пока нет подходящих треков. Обнови подборки или найди музыку в поиске."; return
        }
        player.startPulse(track, mood: mood)
    }
    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true; defer { isRefreshing = false }
        let genres = library.settings.genres.isEmpty ? ["Pop"] : library.settings.genres
        var successes = 0, failure: Error?
        // Small initial requests: display each batch instead of waiting for the entire catalogue.
        for genre in genres.prefix(3) {
            do { merge(try await catalog.search("\(genre) music", genre: genre)); successes += 1 }
            catch is CancellationError { return }
            catch { failure = error }
        }
        for mix in MoodMix.all {
            do { merge(try await catalog.search("\(genres.first ?? "") \(mix.query)", genre: genres.first, mood: mix.id)); successes += 1 }
            catch is CancellationError { return }
            catch { failure = error }
        }
        for anchor in PulseEngine.anchors(in: library, limit: 4) {
            do { merge(try await catalog.related(to: anchor)); successes += 1 }
            catch is CancellationError { return }
            catch { failure = error }
        }
        if successes == 0 { message = failure?.localizedDescription ?? "Каталог пока недоступен. Попробуй ссылку на конкретный трек." }
    }
    func search(_ query: String) async {
        let token = UUID(); searchGeneration = token
        if query.trimmingCharacters(in: .whitespacesAndNewlines).count < 2 { searchResults = []; isSearching = false; return }
        isSearching = true
        do {
            let tracks = try await catalog.search(query)
            guard searchGeneration == token, !Task.isCancelled else { return }
            searchResults = tracks; library.merge(tracks); updateRecommendations(); persist()
        } catch is CancellationError { }
        catch { if searchGeneration == token, !Task.isCancelled { message = error.localizedDescription; searchResults = [] } }
        if searchGeneration == token { isSearching = false }
    }
    func openYouTube(_ value: String) async {
        guard let id = VideoID.parse(value) else { message = "Вставь ссылку на трек или видео YouTube."; return }
        do {
            let audio = try await streams.resolve(videoID: id, forceRefresh: false)
            let track = library.tracks[id] ?? Track(videoID: id, title: audio.title ?? "YouTube · \(id)", artist: "Исполнитель не указан", artworkURL: audio.artworkURL)
            merge([track]); player.play(track, list: [track])
        } catch { message = error.localizedDescription }
    }
    private func merge(_ tracks: [Track]) {
        library.merge(tracks)
        if library.tracks.count > 3000 {
            let protected = Set(library.likedIDs + library.playlists.flatMap(\.trackIDs) + library.events.map(\.trackID))
            for id in library.tracks.keys.sorted() where !protected.contains(id) {
                if library.tracks.count <= 3000 { break }; library.tracks.removeValue(forKey: id)
            }
        }
        persist(); updateRecommendations()
    }
    private func updateRecommendations() { recommendations = PulseEngine.rank(Array(library.tracks.values), library: library) }
    func persist() {
        guard let libraryURL else { message = "Хранилище библиотеки недоступно."; return }
        do { try LibraryDiskStore(url: libraryURL).save(library) }
        catch { message = "Не удалось сохранить библиотеку: \(error.localizedDescription)" }
    }
    func exportLibrary() throws -> URL {
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent("Forma-iOS-library.json")
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(library).write(to: destination, options: .atomic)
        return destination
    }
}
