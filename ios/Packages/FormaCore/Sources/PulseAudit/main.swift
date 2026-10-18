import Foundation
import FormaCore

// Runs the actual iOS engine. Synthetic labels are assigned before selection;
// exported-library replays deliberately make no claim about subjective taste.
struct AuditError: LocalizedError { let errorDescription: String? }
struct Replay: Codable {
    let label: String
    let candidateCount: Int
    let requested: Int
    var selected = 0
    var uniqueRecordings = 0
    var uniqueArtists = 0
    var discoveries = 0
    var newArtists = 0
    var russian = 0
    var genericUtility = 0
    var sameGenreOnly = 0
    var linkedToInitialLibrary = 0
    var knownGenreContradictions = 0
    var soundProfilesAvailable = 0
    var maxArtistIn12 = 0
    var repeats = 0
    var disliked = 0
    var syntheticNegativeSelections: Int?
    var selectedGenres: [String: Int] = [:]
    var initialGenres: [String: Double] = [:]
    var initialSavedCount = 0
    var confirmedSavedGenres = 0
    var elapsedSeconds = 0.0
}
func replay(label: String, original: Library, count: Int, negatives: Set<String>? = nil, refreshEvery: Int = 20) -> Replay {
    var library = original
    let time = max(Date(), (library.events.map(\.at).max() ?? .distantPast).addingTimeInterval(1))
    let profile = TasteProfile(library: library, now: time)
    let candidates = library.tracks.values.sorted { $0.id < $1.id }
    let index = PulseEngine.makeIndex(candidates, library: library)
    var result = Replay(label: label, candidateCount: candidates.count, requested: count)
    result.syntheticNegativeSelections = negatives == nil ? nil : 0
    result.initialGenres = profile.genres; result.initialSavedCount = profile.explicitIDs.count
    result.confirmedSavedGenres = profile.confirmedGenreCount
    var heard = Set<String>(), recordings = Set<String>(), artists = Set<String>(), rolling: [Set<String>] = []
    var cache: [Recommendation] = [], current: String?
    let start = Date()
    for step in 0..<count {
        let now = time.addingTimeInterval(Double(step) * 210)
        if cache.isEmpty || step % max(1, refreshEvery) == 0 {
            cache = PulseEngine.rank(candidates, library: library, limit: 60, exclude: heard, now: now, currentID: current, index: index)
        }
        var next = PulseEngine.selectCached(cache, library: library, exclude: heard, currentID: current, now: now, index: index)
        if next == nil {
            cache = PulseEngine.rank(candidates, library: library, limit: 60, exclude: heard, now: now, currentID: current, index: index)
            next = PulseEngine.selectCached(cache, library: library, exclude: heard, currentID: current, now: now, index: index)
        }
        guard let choice = next else { break }
        let track = choice.track, names = PulseDiversity.artists(track)
        result.selected += 1
        if !heard.insert(track.id).inserted { result.repeats += 1 }
        recordings.insert(PulseDiversity.recording(track)); artists.formUnion(names)
        if !choice.known { result.discoveries += 1 }; if choice.newArtist { result.newArtists += 1 }
        if DiscoveryPolicy.languageFit(track, preference: "ru") >= 0.6 { result.russian += 1 }
        if library.dislikedIDs.contains(track.id) { result.disliked += 1 }
        if RecordingQuality.utility(track) { result.genericUtility += 1 }
        if track.soundProfile?.isValid == true { result.soundProfilesAvailable += 1 }
        let genres = GenreClassifier.genres(track)
        for genre in genres { result.selectedGenres[genre, default: 0] += 1 }
        let linked = !Set(track.directRelatedTo).isDisjoint(with: profile.positiveIDs)
        let familiarArtist = !names.isDisjoint(with: profile.artists.keys)
        if linked { result.linkedToInitialLibrary += 1 }
        if !choice.known && !linked && !familiarArtist && !genres.isEmpty { result.sameGenreOnly += 1 }
        if !genres.isEmpty && !profile.genres.isEmpty && GenreClassifier.relation(genres, Array(profile.genres.keys)) == 0 { result.knownGenreContradictions += 1 }
        rolling.append(names); rolling = Array(rolling.suffix(12))
        for name in names { result.maxArtistIn12 = max(result.maxArtistIn12, rolling.filter { $0.contains(name) }.count) }
        let bad = negatives?.contains(track.id) == true
        if bad { result.syntheticNegativeSelections? += 1 }
        library.record(.init(trackID: track.id, kind: .play, at: now, seconds: 0, ratio: 0, newArtist: choice.newArtist, recommendation: choice.exposure, surface: "pulse"))
        // Only synthetic runs have an independent, predeclared reaction label.
        // Real exports are replayed without inventing user reactions.
        if negatives != nil {
            library.record(.init(trackID: track.id, kind: bad ? .skip : .listen, at: now.addingTimeInterval(bad ? 8 : 190), seconds: bad ? 8 : 190, ratio: bad ? 0.04 : 0.95, recommendation: choice.exposure, surface: "pulse"))
        }
        current = track.id
        if step % 100 == 99 { FileHandle.standardError.write(Data("\(label): \(step + 1)/\(count)\n".utf8)) }
    }
    result.uniqueRecordings = recordings.count; result.uniqueArtists = artists.count
    result.elapsedSeconds = Date().timeIntervalSince(start)
    return result
}
func song(_ n: Int, artist: String? = nil, genre: String = "House", title: String? = nil) -> Track {
    Track(videoID: String(format: "%011d", n), title: title ?? "Песня \(n)", artist: artist ?? "Артист \(n)", duration: 200, genre: genre, language: "ru")
}
func fixture(utilityLeak: Bool) -> (Library, Set<String>) {
    let saved = (0..<400).map { song($0) }
    var library = Library(); library.merge(saved)
    library.likedIDs = saved.prefix(80).map(\.id)
    library.playlists = [.init(name: "Synthetic imported playlist", trackIDs: saved.dropFirst(80).map(\.id))]
    if utilityLeak {
        let utility = song(999, artist: "Сохранённый фон", title: "Музыка для сна")
        library.merge([utility]); library.playlists[0].trackIDs.append(utility.id)
    }
    var negative = Set<String>()
    for i in 1000..<4100 {
        let junk = i >= 2600
        var track = song(i, artist: junk ? "Background Music source \(i)" : nil, genre: junk && !utilityLeak ? "Jazz" : "House", title: junk ? "Energetic Music \(i)" : nil)
        track.directRelatedTo = [saved[junk ? 0 : i % saved.count].id]; track.relatedTo = track.directRelatedTo
        // The unrelated track deliberately carries a misleading retrieval label.
        if junk { track.genres = ["House"]; negative.insert(track.id) }
        library.merge([track])
    }
    library.settings.artistDiversity = 0.8; library.settings.repeatHours = 24
    return (library, negative)
}
func sourcePriority() -> Replay {
    let likes = (0..<100).map { song($0, artist: "Один любимый исполнитель", genre: "Rock") }
    let imported = (200..<700).map { song($0, genre: "Jazz") }
    var library = Library(); library.merge(likes + imported); library.likedIDs = likes.map(\.id)
    library.playlists = [.init(name: "Synthetic import", trackIDs: imported.map(\.id))]
    let fresh = (1000..<3000).map { song($0, genre: $0 < 2000 ? "Rock" : "Jazz") }
    library.merge(fresh); library.settings.includeLibrary = false
    return replay(label: "source-priority-100-likes-one-artist-vs-500-playlist-artists", original: library, count: 200)
}
let args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? { guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }; return args[i + 1] }
let count = min(10000, max(1, Int(option("--count") ?? "1100") ?? 1100))
let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
struct Report: Codable {
    let kind: String
    let subjectiveTasteMeasured: Bool
    let liveYouTubeUsed: Bool
    let refreshEveryChoices: Int
    let warning: String
    let runs: [Replay]
}
let report: Report
if let path = option("--library") {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    let library = LibraryValidation.normalized(try JSONDecoder().decode(Library.self, from: data))
    guard library.version == 1, !library.tracks.isEmpty else { throw AuditError(errorDescription: "Expected a Forma iOS library export") }
    report = Report(kind: "actual-library-offline-replay", subjectiveTasteMeasured: false, liveYouTubeUsed: false, refreshEveryChoices: 20, warning: "Metadata/feedback replay only. No invented reactions, no listening-based judgement. Finite cached candidates may be exhausted before the requested count.", runs: [replay(label: "provided-library", original: library, count: count)])
} else if args.contains("--synthetic") {
    let clean = fixture(utilityLeak: false), polluted = fixture(utilityLeak: true)
    report = Report(kind: "synthetic-adversarial-replay", subjectiveTasteMeasured: false, liveYouTubeUsed: false, refreshEveryChoices: 20, warning: "Synthetic labels fixed before ranking. These measurements test logic and are not an estimate of this user's taste or live YouTube recommendations.", runs: [replay(label: "unrelated-genre-and-misleading-links", original: clean.0, count: count, negatives: clean.1), replay(label: "one-background-save-must-not-open-all-generic-uploads", original: polluted.0, count: count, negatives: polluted.1), sourcePriority()])
} else { throw AuditError(errorDescription: "Use --synthetic or --library /path/Forma-iOS-library.json [--count 1100] [--output report.json]") }
let output = try encoder.encode(report)
if let path = option("--output") { try output.write(to: URL(fileURLWithPath: path), options: .atomic) }
else { print(String(decoding: output, as: UTF8.self)) }
