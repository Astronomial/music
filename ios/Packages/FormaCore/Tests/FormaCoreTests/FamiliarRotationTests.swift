import Foundation
import XCTest
@testable import FormaCore

final class FamiliarRotationTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func song(_ n: Int, genre: String = "Pop", mood: String = "") -> Track {
        Track(videoID: String(format: "%011d", n), title: "Песня \(n)", artist: "Артист \(n)", duration: 200, genre: genre, mood: mood)
    }
    func testFullFavouritePoolSurvivesSixtyTrackCacheAndRotatesAfterRestart() throws {
        let tracks = (0..<180).map { song($0) }
        var library = Library(); library.merge(tracks); library.likedIDs = tracks.map(\.id)
        library.settings.discovery = 0; library.settings.artistDiversity = 0; library.settings.repeatHours = 0
        let index = PulseEngine.makeIndex(tracks, library: library)
        let cached = PulseEngine.rank(tracks, library: library, limit: 60, now: now, index: index, retainFamiliarPool: true)
        XCTAssertEqual(Set(cached.map(\.id)), Set(tracks.map(\.id)), "Cache truncation must not remove less highly ranked favourites")
        var drawn: [String] = []
        for i in 0..<tracks.count {
            let at = now.addingTimeInterval(Double(i))
            let choice = try XCTUnwrap(PulseEngine.selectCached(cached, library: library, exclude: [], now: at, index: index))
            XCTAssertTrue(choice.known); XCTAssertFalse(drawn.contains(choice.id)); drawn.append(choice.id)
            library.record(.init(trackID: choice.id, kind: .play, at: at, seconds: 0, ratio: 0))
            library.events = []
            library = try JSONDecoder().decode(Library.self, from: JSONEncoder().encode(library))
        }
        XCTAssertEqual(drawn.count, 180); XCTAssertNotEqual(drawn, tracks.map(\.id))
        XCTAssertEqual(PulseEngine.selectCached(cached, library: library, exclude: [], now: now.addingTimeInterval(1000), index: index)?.id, drawn.first)
    }
    func testCompletedUnsavedRecordingRemainsDiscoveryAndLiveDislikeWins() throws {
        let tracks = (0..<4).map { song($0) }
        var library = Library(); library.merge(tracks); library.likedIDs = [tracks[0].id]
        library.settings.repeatHours = 0; library.settings.discovery = 1
        library.events = [.init(trackID: tracks[1].id, kind: .listen, at: now, seconds: 190, ratio: 0.95)]
        let choices = PulseEngine.rank(tracks, library: library, now: now)
        XCTAssertFalse(try XCTUnwrap(choices.first { $0.id == tracks[1].id }).known)
        library.dislikedIDs = [tracks[0].id, tracks[1].id]
        let next = PulseEngine.selectCached(choices, library: library, exclude: [], now: now)
        XCTAssertFalse(library.dislikedIDs.contains(try XCTUnwrap(next).id))
    }
    func testEveryMoodHasTwentyFiveAndContinuesWithFreshVerifiedRecordings() {
        for mix in MoodMix.all {
            var tracks = (0..<65).map { song($0, mood: mix.id) }
            if mix.id == "focus" { for i in tracks.indices { tracks[i].tags = ["instrumental", "calm"] } }
            var library = Library(); library.merge(tracks); library.likedIDs = tracks.prefix(3).map(\.id)
            library.settings.repeatHours = 0
            let first = PulseEngine.rank(tracks, library: library, limit: 25, mood: mix.id, now: now)
            XCTAssertEqual(first.count, 25, mix.id)
            let more = PulseEngine.rank(tracks, library: library, limit: 25, mood: mix.id, exclude: Set(first.map(\.id)), now: now)
            XCTAssertEqual(more.count, 25, mix.id)
            XCTAssertTrue(more.allSatisfy { MoodFitness.scores($0.track)[mix.id, default: 0] > 0 })
        }
    }
    func testSparseShelvesGetDiscoveryJobsAndQueryDoesNotLabelUnknownTrack() {
        let seed = Track(videoID: "abcdefghijk", title: "Химия", artist: "Моя Мишель", genre: "Pop")
        var library = Library(); library.merge([seed]); library.likedIDs = [seed.id]
        var planner = DiscoveryPlanner()
        let jobs = planner.plan(library: library, limit: 10, now: now, mood: "bright", underfilledMoods: ["focus"])
        XCTAssertTrue(jobs.contains { $0.mood == "bright" && $0.kind == .search })
        XCTAssertTrue(jobs.contains { $0.kind == .related })
        let unknown = Track(videoID: "12345678901", title: "Unknown", artist: "Unknown", moodHints: ["bright"])
        XCTAssertEqual(MoodFitness.scores(unknown)["bright"], 0)
        XCTAssertEqual(MoodFitness.scores(Track(videoID: "12345678901", title: "Ева", artist: "Винтаж"))["bright"], 0)
        let remix = Track(videoID: "12345678901", title: "Химия (hardstyle remix)", artist: "Моя Мишель")
        XCTAssertTrue(GenreClassifier.genres(remix).isEmpty)
    }
    func testMusicalFacetsLearnIndependentlyAndLegacyHistoryStillTrains() {
        var library = Library()
        func features(_ positive: Bool) -> [Double] {
            ContextualLearning.features(taste: 0.6, nearby: 0.6, session: 0, newArtist: true, known: false, language: 0.8, context: 0, metadata: true, genre: positive ? 1 : 0, artist: 0, mood: positive ? 1 : 0, sound: 0.8)
        }
        library.events = (0..<40).map { i -> ListeningEvent in
            let positive = i % 2 == 0
            let snapshot = RecommendationContext(features: features(positive), lane: "nearby")
            return ListeningEvent(trackID: String(format: "%011d", i), kind: positive ? .listen : .skip, at: now.addingTimeInterval(-Double(i)), seconds: positive ? 190 : 8, ratio: positive ? 0.95 : 0.04, recommendation: snapshot)
        }
        let model = ContextualLearning.model(library, now: now)
        XCTAssertEqual(model.samples, 40)
        XCTAssertGreaterThan(ContextualLearning.predict(model, features: features(true)).mean, ContextualLearning.predict(model, features: features(false)).mean + 0.25)
        let legacy = RecommendationContext(features: Array(features(true).prefix(10)), lane: "nearby")
        library.events = [.init(trackID: "abcdefghijk", kind: .listen, at: now, seconds: 190, ratio: 0.95, recommendation: legacy)]
        XCTAssertEqual(legacy.version, 2); XCTAssertEqual(ContextualLearning.model(library, now: now).samples, 1)
    }
    func testConcentrationCanUseVerifiedInstrumentalsWithoutLeakingIntoPersonalPulse() {
        let favourite = song(500, genre: "Pop")
        var tracks = (0..<30).map { song($0, genre: "Classical", mood: "focus") }
        for i in tracks.indices { tracks[i].tags = ["calm", "instrumental"] }
        var library = Library(); library.merge(tracks + [favourite]); library.likedIDs = [favourite.id]
        XCTAssertTrue(PulseEngine.rank(tracks, library: library, now: now).isEmpty)
        XCTAssertEqual(PulseEngine.rank(tracks, library: library, limit: 25, mood: "focus", now: now).count, 25)
        library.settings.genreMode = "strict"; library.settings.genres = ["Pop"]
        XCTAssertTrue(PulseEngine.rank(tracks, library: library, mood: "focus", now: now).isEmpty)
    }
    func testCachedArtistNoveltyAndPlaybackMetadataAreRefreshed() throws {
        let seed = song(1), fresh = song(2)
        var library = Library(); library.merge([seed, fresh]); library.likedIDs = [seed.id]; library.settings.repeatHours = 0
        let cached = PulseEngine.rank([fresh], library: library, now: now)
        XCTAssertTrue(try XCTUnwrap(cached.first).newArtist)
        library.record(.init(trackID: fresh.id, kind: .play, at: now, seconds: 0, ratio: 0))
        library.tracks[fresh.id]?.title = "Обновлённое название"
        let choice = try XCTUnwrap(PulseEngine.selectCached(cached, library: library, exclude: [], now: now.addingTimeInterval(1)))
        XCTAssertFalse(choice.newArtist); XCTAssertEqual(choice.exposure?.features[5], 0)
        XCTAssertEqual(choice.track.title, "Обновлённое название")
    }
    func testImportedRecordingsAreFamiliarAndRecentArtistsGetDiscoveryPriority() throws {
        let likes = (0..<180).map { song($0) }, imported = song(800), heard = song(900)
        var library = Library(); library.merge(likes + [imported, heard]); library.likedIDs = likes.map(\.id)
        library.playlists = [.init(name: "Из Яндекса", trackIDs: [imported.id])]; library.settings.discovery = 1
        library.events = [.init(trackID: heard.id, kind: .listen, at: now.addingTimeInterval(-1), seconds: 190, ratio: 0.95)]
        XCTAssertTrue(try XCTUnwrap(PulseEngine.rank([imported], library: library, now: now).first).known)
        var planner = DiscoveryPlanner()
        XCTAssertTrue(planner.plan(library: library, limit: 10, now: now).contains { $0.kind == .artist && $0.seed.id == heard.id })
    }
    func testRotationSurvivesApprovedSyncAndLegacyPeer() {
        let tracks = [song(1), song(2)]
        var local = Library(); local.merge(tracks); local.likedIDs = tracks.map(\.id); local.familiarPlays[tracks[0].id] = 1_800_000_000_000
        var remote = local; remote.familiarPlays = [tracks[1].id: 1_800_000_001_000]
        let merged = LibrarySync.merge(current: local, base: local, incoming: remote)
        XCTAssertEqual(merged.familiarPlays.count, 2)
        XCTAssertEqual(LibrarySync.preservingLearning(in: remote, from: local).familiarPlays.count, 2)
    }
}
