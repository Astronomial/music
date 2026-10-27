import Foundation
import XCTest
@testable import FormaCore

final class RecommendationPolicyTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func song(_ n: Int, genre: String = "Pop") -> Track {
        Track(videoID: String(format: "%011d", n), title: "Песня \(n)", artist: "Артист \(n)", duration: 200, genre: genre, mood: "calm")
    }
    func testHardGenreVetoCannotBeOverriddenBySavesMoodOrStaleCache() {
        let seed = song(1)
        let styles = ["Russian Chanson", "Русский шансон", "шансон", "Блатная песня", "Blatnaya", "Кавказская эстрада", "Caucasian Pop"]
        let bad = styles.enumerated().map { song($0.offset + 10, genre: $0.element) }
        var library = Library(); library.merge([seed] + bad); library.likedIDs = [seed.id] + bad.map(\.id); library.settings.repeatHours = 0
        let profile = TasteProfile(library: library, now: now)
        for track in bad {
            XCTAssertTrue(PulseDiversity.blocked(track, settings: library.settings), track.genre)
            XCTAssertFalse(profile.positiveIDs.contains(track.id))
        }
        XCTAssertTrue(PulseEngine.rank(bad, library: library, now: now).isEmpty)
        for mix in MoodMix.all { XCTAssertTrue(PulseEngine.rank(bad, library: library, mood: mix.id, now: now).isEmpty) }
        let old = bad.map { Recommendation(track: $0, score: 999, reason: "Old cache", known: true, nearby: true, taste: 1) }
        XCTAssertNil(PulseEngine.selectCached(old, library: library, exclude: [], now: now))
        XCTAssertEqual(library.likedIDs.count, bad.count + 1)
    }
    func testVetoInspectsRawGenresEvenWhenPopEvidenceOverridesThem() {
        var track = song(21, genre: "Pop / Русский шансон")
        track.genreEvidence = GenreEvidence(values: ["Pop"], confidence: 0.95, checkedAt: now.timeIntervalSince1970 * 1000, recordingId: "12")
        XCTAssertTrue(PulseDiversity.blocked(track, settings: PulseSettings()))
        track.genre = "Pop"; track.artist = "Кавказ"; track.title = "Шансон моей жизни"
        XCTAssertFalse(PulseDiversity.blocked(track, settings: PulseSettings()))
    }
    func testSparseQueueCannotOverrideSurpriseBudget() {
        let seed = song(100)
        let adjacent = (101..<125).map { song($0, genre: "R&B/Soul") }
        var library = Library(); library.merge([seed] + adjacent); library.likedIDs = [seed.id]; library.settings.repeatHours = 0
        XCTAssertTrue(PulseEngine.rank(adjacent, library: library, now: now).isEmpty)
        let stale = adjacent.map { Recommendation(track: $0, score: 100, reason: "Generic adjacent genre", nearby: false, taste: 0.2) }
        XCTAssertNil(PulseEngine.selectCached(stale, library: library, exclude: [], now: now))
    }
}
