import Foundation
import XCTest
@testable import FormaCore

final class FreshDiscoveryTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000), day = 86400000.0
    func song(_ id: Int, artist: String? = nil) -> Track { Track(videoID: String(format: "%011d", id), title: "Песня \(id)", artist: artist ?? "Артист \(id)", duration: 200, genre: "Pop") }
    func evidence(_ days: Double) -> GenreEvidence { .init(values: ["Pop"], confidence: 0.95, checkedAt: now.timeIntervalSince1970 * 1000, recordingId: "1", releasedAt: now.timeIntervalSince1970 * 1000 - days * day) }
    func testReleaseDateOverridesRecentUploadAndFutureOrUnknownDatesCannotBecomeNewReleases() {
        var track = song(1); track.publishedAt = now.timeIntervalSince1970 * 1000 - day
        XCTAssertTrue(ReleaseDiscovery.freshness(track, now: now).recent); XCTAssertFalse(ReleaseDiscovery.freshness(track, now: now).verified)
        track.genreEvidence = evidence(900); XCTAssertFalse(ReleaseDiscovery.freshness(track, now: now).recent)
        track.genreEvidence = evidence(5); XCTAssertGreaterThan(ReleaseDiscovery.freshness(track, now: now).score, 0.9)
        track.genreEvidence = evidence(-5); XCTAssertFalse(ReleaseDiscovery.freshness(track, now: now).recent)
        XCTAssertFalse(ReleaseDiscovery.freshness(song(2), now: now).recent)
    }
    func testNewReleaseAppetiteUsesOutcomesButNotErrorsOrInstantSkips() {
        let tracks = (0..<6).map { i -> Track in var track = song(i); track.genreEvidence = evidence(1); return track }
        var library = Library(); library.merge(tracks)
        library.events = tracks.map { .init(trackID: $0.id, kind: .error, at: now, seconds: 20, ratio: 0, surface: "pulse") }; XCTAssertEqual(ReleaseDiscovery.target(library, now: now), 0.6)
        library.events = tracks.map { .init(trackID: $0.id, kind: .skip, at: now, seconds: 0, ratio: 0, surface: "pulse") }; XCTAssertEqual(ReleaseDiscovery.target(library, now: now), 0.6)
        library.events = tracks.map { .init(trackID: $0.id, kind: .skip, at: now, seconds: 10, ratio: 0.05, surface: "pulse") }; XCTAssertLessThan(ReleaseDiscovery.target(library, now: now), 0.4)
        library.events = tracks.map { .init(trackID: $0.id, kind: .listen, at: now, seconds: 190, ratio: 0.95, surface: "pulse") }; XCTAssertGreaterThan(ReleaseDiscovery.target(library, now: now), 0.7)
    }
    func testCachedNewReleasePriorityAdaptsToEarlySkipsAndColdStartRemainsUsable() throws {
        let seed = song(1); var fresh = song(2, artist: seed.artist), old = song(3, artist: seed.artist)
        fresh.genreEvidence = evidence(1); old.genreEvidence = evidence(900)
        let past = (20..<26).map { i -> Track in var track = song(i); track.genreEvidence = evidence(1); return track }
        var library = Library(); library.merge([seed, fresh, old] + past); library.likedIDs = [seed.id]; library.settings.artistDiversity = 0; library.settings.discovery = 1
        let cache = PulseEngine.rank([old, fresh], library: library, now: now)
        XCTAssertEqual(PulseEngine.selectCached(cache, library: library, exclude: [], now: now)?.id, fresh.id)
        library.events = past.map { .init(trackID: $0.id, kind: .skip, at: now, seconds: 10, ratio: 0.05, surface: "pulse") }
        XCTAssertEqual(PulseEngine.selectCached(cache, library: library, exclude: [], now: now)?.id, old.id)
        var example = song(99); example.retrievalSources = ["mood-reference", "genre"]
        XCTAssertEqual(PulseEngine.rank([example], library: Library(), now: now).count, 1)
    }
    func testReleaseLookupKeepsEarliestRecordingAndArtistIdentity() throws {
        let fresh = ISO8601DateFormatter().string(from: now.addingTimeInterval(-5 * 86400)), old = ISO8601DateFormatter().string(from: now.addingTimeInterval(-900 * 86400))
        let rows = try JSONDecoder().decode([GenreClassifier.Recording].self, from: Data("""
        [{"kind":"song","artistName":"Артист 1","trackName":"Песня 1","releaseDate":"\(fresh)","primaryGenreName":"Pop","trackId":1},
         {"kind":"song","artistName":"Артист 1","trackName":"Песня 1","releaseDate":"\(old)","primaryGenreName":"Pop","trackId":2},
         {"kind":"song","artistName":"Чужой","trackName":"Песня 2","releaseDate":"\(fresh)"}]
        """.utf8))
        XCTAssertTrue(ReleaseDiscovery.recent(rows, artist: "Артист 1", now: now).isEmpty)
        XCTAssertEqual(GenreClassifier.match(song(1), recordings: rows, now: now).releasedAt, now.timeIntervalSince1970 * 1000 - 900 * day)
    }
    func testSamePopCatalogueRespondsToArtistTasteInsteadOfGenericHits() {
        let a = song(1), b = song(2)
        let groups = [a, b].enumerated().map { g, seed in (0..<30).map { i -> Track in var track = song(100 + g * 100 + i, artist: seed.artist); track.genreEvidence = evidence(7); return track } }
        let hits = (0..<80).map { i -> Track in var track = song(500 + i); track.genreEvidence = evidence(900); return track }
        let all = [a, b] + groups.flatMap { $0 } + hits
        for seed in [a, b] {
            var library = Library(); library.merge(all); library.likedIDs = [seed.id]; library.settings.artistDiversity = 0; library.settings.discovery = 1
            let result = PulseEngine.rank(groups.flatMap { $0 } + hits, library: library, limit: 15, now: now)
            XCTAssertEqual(result.count, 15); XCTAssertTrue(result.allSatisfy { $0.track.artist == seed.artist })
        }
    }
    func testGlobalMoodReferencesNeedAnActualPersonalConnection() {
        let seed = song(1); var other = song(2), personal = song(3, artist: seed.artist)
        other.retrievalSources = ["mood-reference"]; personal.retrievalSources = ["mood-reference"]
        var library = Library(); library.merge([seed, other, personal]); library.likedIDs = [seed.id]
        XCTAssertEqual(PulseEngine.rank([other, personal], library: library, now: now).map(\.id), [personal.id])
    }
    func testCachedChoiceUsesNewlyVerifiedReleaseBeforeBackgroundRankingAndSurvivesStorage() throws {
        let seed = song(1), old = song(2, artist: "Артист 1"); var fresh = song(3); fresh.relatedTo = [seed.id]; fresh.directRelatedTo = [seed.id]
        var library = Library(); library.merge([seed, old, fresh]); library.likedIDs = [seed.id]; library.settings.artistDiversity = 0; library.settings.discovery = 1
        let cache = PulseEngine.rank([old, fresh], library: library, now: now)
        library.tracks[fresh.id]?.genreEvidence = evidence(5)
        let choice = try XCTUnwrap(PulseEngine.selectCached(cache, library: library, exclude: [], now: now))
        XCTAssertEqual(choice.id, fresh.id); XCTAssertTrue(choice.reason.contains("Свежий релиз"))
        library.tracks[fresh.id]?.publishedAt = now.timeIntervalSince1970 * 1000; library.tracks[fresh.id]?.retrievalSources = ["release-catalog"]
        let restored = try JSONDecoder().decode(Library.self, from: JSONEncoder().encode(library))
        XCTAssertNotNil(restored.tracks[fresh.id]?.publishedAt); XCTAssertTrue(ReleaseDiscovery.freshness(try XCTUnwrap(restored.tracks[fresh.id]), now: now).verified)
        XCTAssertEqual(restored.tracks[fresh.id]?.retrievalSources, ["release-catalog"])
    }
    func testPlannerReservesNewReleaseRouteAndDoesNotInventGenreOrMood() {
        let seeds = (0..<40).map { song($0) }; var library = Library(); library.merge(seeds); library.likedIDs = seeds.map(\.id)
        var planner = DiscoveryPlanner(); let jobs = planner.plan(library: library, limit: 10, now: now, underfilledMoods: MoodMix.all.map(\.id))
        XCTAssertTrue(jobs.contains { $0.kind == .releases }); XCTAssertTrue(jobs.contains { $0.kind == .related })
    }
    func testFreshQuotaAndFullFamiliarRotationCoexist() throws {
        let likes = (0..<60).map { song($0) }
        let candidates = (0..<140).flatMap { i -> [Track] in
            var fresh = song(1000 + i), old = song(2000 + i)
            fresh.directRelatedTo = [likes[i % 60].id]; fresh.relatedTo = fresh.directRelatedTo; fresh.genreEvidence = evidence(10)
            old.directRelatedTo = fresh.directRelatedTo; old.relatedTo = fresh.directRelatedTo; old.genreEvidence = evidence(900)
            return [fresh, old]
        }
        var library = Library(); library.merge(likes + candidates); library.likedIDs = likes.map(\.id); library.settings.artistDiversity = 0
        let index = PulseEngine.makeIndex(likes + candidates, library: library)
        let cache = PulseEngine.rank(likes + candidates, library: library, limit: 340, now: now, index: index, retainFamiliarPool: true)
        var heard = Set<String>(), novel = 0, recent = 0
        for i in 0..<90 {
            let at = now.addingTimeInterval(Double(i * 210)), choice = try XCTUnwrap(PulseEngine.selectCached(cache, library: library, exclude: heard, now: at, index: index))
            heard.insert(choice.id); if !choice.known { novel += 1; if choice.recentRelease { recent += 1 } }
            library.record(.init(trackID: choice.id, kind: .play, at: at, seconds: 0, ratio: 0, recommendation: choice.exposure, surface: "pulse"))
        }
        XCTAssertEqual(heard.count, 90); XCTAssertTrue((60...65).contains(novel)); XCTAssertGreaterThanOrEqual(Double(recent), Double(novel) * 0.55)
    }
}
