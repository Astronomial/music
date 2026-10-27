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
    func testGenericPopDoesNotFillDiscoveryWithoutPersonalEvidence() {
        var seed = song(200); seed.mood = ""
        let generic = (201..<230).map { n -> Track in var track = song(n); track.mood = ""; return track }
        var related = song(230, genre: ""); related.relatedTo = [seed.id]; related.directRelatedTo = [seed.id]
        var library = Library(); library.merge([seed]); library.likedIDs = [seed.id]; library.settings.repeatHours = 0
        XCTAssertTrue(PulseEngine.rank(generic, library: library, now: now).isEmpty)
        XCTAssertEqual(PulseEngine.rank(generic + [related], library: library, now: now).map(\.id), [related.id])
    }
    func testManualForbiddenListeningDoesNotTrainPositiveModels() {
        let track = song(300, genre: "Russian Chanson")
        var library = Library(); library.merge([track])
        let snapshot = RecommendationContext(features: ContextualLearning.features(taste: 1, nearby: 1, session: 0, newArtist: false, known: true, language: 1, context: 0, metadata: true), lane: "familiar")
        library.events = [ListeningEvent(trackID: track.id, kind: .like, at: now, seconds: 0, ratio: 0, recommendation: snapshot)]
        XCTAssertEqual(ContextualLearning.model(library, now: now).samples, 0)
        XCTAssertTrue(ConsumptionFeedback.model(library, now: now).global.isEmpty)
    }
    func testNamedExclusionsAndChildrenMusicDoNotBanWinterSongsOrUnrelatedNames() {
        for name in ["Стас Михайлов - Topic", "Ваня Дмитриенко", "Vanya Dmitrienko"] {
            var track = song(400); track.artist = name
            XCTAssertTrue(PulseDiversity.blocked(track, settings: PulseSettings()), name)
        }
        for genre in ["Children’s Music", "Детская музыка"] { XCTAssertTrue(PulseDiversity.blocked(song(401, genre: genre), settings: PulseSettings())) }
        for name in ["ксюшенька", "бэя", "Три дня дождя", "MARKUL", "Janna RAY", "Михайловский оркестр"] {
            var track = song(402); track.artist = name; track.title = "Скоро новый год"
            XCTAssertFalse(PulseDiversity.blocked(track, settings: PulseSettings()), name)
        }
    }
}
