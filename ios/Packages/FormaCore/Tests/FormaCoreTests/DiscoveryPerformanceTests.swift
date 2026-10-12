import Foundation
import XCTest
@testable import FormaCore

final class DiscoveryPerformanceTests: XCTestCase {
    func testEveryMoodGetsRegionalAndInternationalSearches() {
        let queries = BilingualDiscovery.searches(genres: ["Pop", "Rock"], suffix: "vocal", hints: ["vocals:vocal"], language: "any")
        for mix in MoodMix.all {
            let searches = queries.filter { $0.mood == mix.id }
            XCTAssertEqual(searches.count, 2)
            XCTAssertTrue(searches.contains { $0.query.contains("русская музыка") })
            XCTAssertTrue(searches.contains { $0.query.contains(mix.query) })
            XCTAssertTrue(searches.allSatisfy { $0.hints.contains("vocals:vocal") })
        }
    }
    func testRussianHomeAndEveryMoodKeepWeakMetadataNeighbours() {
        let tracks = (0..<62).map { i in Track(videoID: String(format: "%011d", i), title: i < 30 ? "Song \(i)" : "Песня \(i)", artist: "Artist \(i)", genres: i < 30 ? [] : ["Pop"], moodHints: MoodMix.all.map(\.id), genre: i < 30 ? "Pop" : "") }
        var library = Library(); library.merge(tracks)
        library.settings.genres = ["Pop"]; library.settings.languagePreference = "ru"
        library.settings.repeatHours = 0; library.settings.artistDiversity = 0.8
        library.likedIDs = [tracks[0].id, tracks[30].id]
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        for mood in [nil] + MoodMix.all.map({ Optional($0.id) }) {
            let result = PulseEngine.rank(tracks, library: library, limit: 12, mood: mood, now: now)
            XCTAssertEqual(result.count, 12)
            XCTAssertGreaterThanOrEqual(result.filter { $0.track.title.hasPrefix("Песня") }.count, 8, "Home/mood language preference was lost before diversity selection")
            XCTAssertEqual(Set(result.map { $0.track.artist }).count, 12)
        }
        library.settings.genreMode = "strict"; library.hiddenIDs = [tracks[31].id]
        library.settings.excludedArtists = [tracks[32].artist]
        let jazz = Track(videoID: "jazz0000001", title: "Чужой джаз", artist: "Other", genres: ["Jazz"], genre: "Jazz")
        let result = PulseEngine.rank(tracks + [jazz], library: library, limit: 20, now: now)
        XCTAssertFalse(result.contains { $0.id == jazz.id || $0.id == tracks[31].id || $0.id == tracks[32].id })
    }
    func testRussianSearchesFollowTasteWithoutInventingLanguageEvidence() {
        let anchor = Track(videoID: "anchor00001", title: "Любимое", artist: "Мой артист", genres: ["Rock"])
        var settings = PulseSettings(); settings.genres = []; settings.excludedGenres = ["Jazz"]
        let genres = BilingualDiscovery.tasteGenres(anchors: [anchor], settings: settings)
        XCTAssertEqual(genres, ["Rock"])
        let queries = BilingualDiscovery.searches(genres: genres, suffix: "vocal", hints: ["vocals:vocal"], language: "ru", artists: [anchor.artist])
        for mood in MoodMix.all {
            let searches = queries.filter { $0.mood == mood.id }
            XCTAssertEqual(searches.count, 2)
            XCTAssertTrue(searches.allSatisfy { $0.query.contains("русская музыка") && $0.query.contains("рок") && !$0.query.contains("vocal") })
            XCTAssertTrue(searches.contains { $0.query.contains(anchor.artist) })
            XCTAssertTrue(searches.allSatisfy { $0.hints.contains("discovery:ru") })
        }
        let english = BilingualDiscovery.searches(genres: genres, suffix: "", hints: [], language: "en", artists: [anchor.artist])
        XCTAssertTrue(english.allSatisfy { $0.hints.contains("discovery:en") && !$0.hints.contains("discovery:ru") })
    }
    func testHomeAndAllMoodsRespondToLibraryTasteWithoutExplicitGenres() {
        let tracks = (0..<60).map { i in Track(videoID: String(format: "%011d", i), title: "Песня \(i)", artist: "Артист \(i)", moodHints: MoodMix.all.map(\.id), genre: i < 30 ? "Rock" : "Jazz") }
        for (anchor, genre) in [(tracks[0], "Rock"), (tracks[30], "Jazz")] {
            var library = Library(); library.merge(tracks); library.settings.genres = []; library.settings.repeatHours = 0
            library.likedIDs = [anchor.id]
            for mood in [nil] + MoodMix.all.map({ Optional($0.id) }) {
                let result = PulseEngine.rank(tracks, library: library, limit: 12, mood: mood)
                XCTAssertEqual(result.count, 12)
                XCTAssertGreaterThanOrEqual(result.filter { $0.track.genre == genre }.count, 10, "Mood must refine actual library taste")
            }
        }
    }
    func testRegionalSlotsExistEvenWhenEnglishCandidatesRankFirst() {
        let tracks = (0..<30).map { i in Track(videoID: String(format: "%011d", i), title: i >= 24 ? "Песня \(i)" : "Song \(i)", artist: "Artist \(i)") }
        var library = Library(); library.merge(tracks)
        let ranked = tracks.enumerated().map { Recommendation(track: $0.element, score: Double(30 - $0.offset), reason: "Test") }
        let result = BilingualDiscovery.balanced(ranked)
        XCTAssertEqual(Set(result.map(\.id)), Set(ranked.map(\.id)))
        XCTAssertEqual(result.prefix(12).filter { BilingualDiscovery.regional($0.track) }.count, 4)
    }
    func testRegionalDiscoverySurvivesAStrongEnglishLibraryAndHonorsHiddenTracks() {
        let tracks = (0..<90).map { i in Track(videoID: String(format: "%011d", i), title: i >= 70 ? "Песня \(i)" : "Song \(i)", artist: "Artist \(i)", genres: ["Pop"], moodHints: ["calm"], genre: "Pop") }
        var library = Library(); library.merge(tracks); library.likedIDs = Array(tracks.prefix(70).map(\.id)); library.settings.artistDiversity = 0
        library.hiddenIDs = [tracks[70].id]
        let result = BilingualDiscovery.rankHome(tracks, library: library, limit: 30, mood: "calm")
        XCTAssertGreaterThanOrEqual(result.prefix(12).filter { BilingualDiscovery.regional($0.track) }.count, 3)
        XCTAssertFalse(result.contains { library.hiddenIDs.contains($0.id) })
    }
    func testCachedIndexPreservesRankingAndFeedbackChangesTaste() {
        let tracks = (0..<120).map { i in Track(videoID: String(format: "%011d", i), title: "Song \(i)", artist: "Artist \(i % 20)", genres: [i % 2 == 0 ? "Rock" : "Pop"], moodHints: ["calm"]) }
        var library = Library(); library.merge(tracks); library.likedIDs = [tracks[0].id]
        let index = PulseEngine.makeIndex(tracks, library: library), now = Date()
        let cold = PulseEngine.rank(tracks, library: library, limit: 20, now: now)
        let cached = PulseEngine.rank(tracks, library: library, limit: 20, now: now, index: index)
        XCTAssertEqual(cached.map(\.id), cold.map(\.id)); XCTAssertEqual(cached.map(\.score), cold.map(\.score))
        library.hiddenIDs = [cached[0].id]
        let changed = PulseEngine.rank(tracks, library: library, limit: 20, now: now, index: index)
        XCTAssertFalse(changed.contains { library.hiddenIDs.contains($0.id) })
    }
    func testThreeThousandTracksAndSixMoodsHaveBoundedRankingCost() {
        let tracks = (0..<3000).map { i in Track(videoID: String(format: "%011d", i), title: i % 3 == 2 ? "Песня \(i)" : "Song \(i)", artist: "Artist \(i % 500)", genres: ["Pop"], moodHints: [MoodMix.all[i % 6].id]) }
        var library = Library(); library.merge(tracks); library.likedIDs = Array(tracks.prefix(10).map(\.id))
        let start = Date(), index = PulseEngine.makeIndex(tracks, library: library)
        XCTAssertEqual(BilingualDiscovery.rankHome(tracks, library: library, limit: 40, index: index).count, 40)
        for mood in MoodMix.all { XCTAssertEqual(BilingualDiscovery.rankHome(tracks, library: library, limit: 30, mood: mood.id, index: index).count, 30) }
        let elapsed = Date().timeIntervalSince(start)
        print("FORMA_RANK_BENCHMARK: 3000 tracks + six mood lists = \(elapsed) seconds; metadata index shared")
        XCTAssertLessThan(elapsed, 10, "Large libraries must not cause runaway ranking work")
    }
    func testPreparedAndNetworkPercentilesStaySeparate() {
        let values = [PlaybackMeasurement(title: "A", source: "network", totalMilliseconds: 1200, resolutionMilliseconds: 800), PlaybackMeasurement(title: "B", source: "prepared", totalMilliseconds: 8, resolutionMilliseconds: 0), PlaybackMeasurement(title: "C", source: "network", totalMilliseconds: 1800, resolutionMilliseconds: 1000)]
        XCTAssertEqual(PlaybackMeasurement.percentile(values, source: "network", fraction: 0.95), 1800)
        XCTAssertEqual(PlaybackMeasurement.percentile(values, source: "prepared", fraction: 0.95), 8)
        XCTAssertEqual(values[0].bufferMilliseconds, 400)
    }
}
