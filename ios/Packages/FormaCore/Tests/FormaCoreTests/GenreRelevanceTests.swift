import Foundation
import XCTest
@testable import FormaCore

final class GenreRelevanceTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func song(_ n: Int, genre: String = "") -> Track { Track(videoID: String(format: "%011d", n), title: "Песня \(n)", artist: "Артист \(n)", duration: 200, genre: genre) }
    func testQueryLabelsCannotTrainTasteOrPassStrictGenreFilters() {
        var seed = song(1); seed.genres = Array(GenreClassifier.aliases.keys)
        var library = Library(); library.merge([seed]); library.likedIDs = [seed.id]
        XCTAssertTrue(GenreClassifier.genres(seed).isEmpty)
        XCTAssertTrue(BilingualDiscovery.tasteGenres(anchors: [seed], settings: library.settings).isEmpty)
        library.settings.genreMode = "strict"; library.settings.genres = ["Rock"]
        XCTAssertEqual(PulseEngine.genreMetadataAnchors(in: library, now: now).map(\.id), [seed.id])
        XCTAssertTrue(PulseEngine.rank([seed], library: library, now: now).isEmpty)
        XCTAssertFalse(ConsumptionFeedback.arms(seed).contains { $0.0.hasPrefix("genre:") })
        XCTAssertTrue(PulseSettings().genres.isEmpty)
    }
    func testCanonicalGenresAndCompositeLabels() {
        XCTAssertEqual(GenreClassifier.canonical("Alternative Rock"), ["Alternative"])
        XCTAssertEqual(GenreClassifier.canonical("Deep House"), ["House"])
        XCTAssertEqual(Set(GenreClassifier.canonical("Rock / House")), ["Rock", "House"])
        XCTAssertEqual(GenreClassifier.canonical("R&B/Soul"), ["R&B/Soul"])
        XCTAssertTrue(GenreClassifier.canonical("soundtrack of my life").isEmpty)
    }
    func testExactRecordingMatchRejectsRemixesCoversWrongDurationAndConflictingLabels() throws {
        let track = Track(videoID: "00000000001", title: "ВНИМАНИЕ! (Official Audio)", artist: "ксюшенька - Topic", duration: 200)
        let row: [String: Any] = ["kind": "song", "trackName": "ВНИМАНИЕ!", "artistName": "ксюшенька", "trackTimeMillis": 200000, "primaryGenreName": "Russian Pop", "trackId": 12]
        func records(_ rows: [[String: Any]]) throws -> [GenreClassifier.Recording] { try JSONDecoder().decode([GenreClassifier.Recording].self, from: JSONSerialization.data(withJSONObject: rows)) }
        XCTAssertEqual(GenreClassifier.match(track, recordings: try records([row]), now: now).values, ["Pop"])
        let variants: [[String: Any]] = [["artistName": "Другой"], ["trackName": "ВНИМАНИЕ! (Remix)"], ["trackTimeMillis": 260000], ["kind": "music-video"]]
        for changes in variants {
            XCTAssertTrue(GenreClassifier.match(track, recordings: try records([row.merging(changes, uniquingKeysWith: { _, b in b })])).values.isEmpty)
        }
        XCTAssertTrue(GenreClassifier.match(track, recordings: try records([row, row.merging(["primaryGenreName": "Jazz"], uniquingKeysWith: { _, b in b })])).values.isEmpty)
    }
    func testRussianMoodPopularityAndLegacyDefaultsCannotOverrideRockTaste() {
        let seed = song(1, genre: "Rock")
        var library = Library(); library.merge([seed]); library.likedIDs = [seed.id]; library.settings.repeatHours = 0
        library.settings.genres = ["Electronic", "Rock", "Hip-Hop/Rap"]
        let good = (10..<28).map { i -> Track in var t = song(i, genre: "Rock"); t.language = "en"; t.mood = "calm"; return t }
        let garbage = (100..<180).map { i -> Track in
            var t = song(i, genre: i % 2 == 0 ? "Jazz" : "Hip-Hop/Rap"); t.mood = "calm"; t.genres = ["Rock"]; t.relatedTo = [seed.id]; t.directRelatedTo = [seed.id]; return t
        }
        var moodOnly = song(300); moodOnly.mood = "calm"; moodOnly.genres = ["Rock"]
        for mood in [nil] + MoodMix.all.map({ Optional($0.id) }) {
            let result = PulseEngine.rank(garbage + [moodOnly] + good, library: library, limit: 30, mood: mood, now: now)
            XCTAssertTrue(result.allSatisfy { $0.track.genre == "Rock" })
            if mood == nil { XCTAssertEqual(result.count, 18) }
        }
        XCTAssertTrue(PulseEngine.rank(garbage, library: library, now: now).isEmpty)
    }
    func testUnknownArtistsNeedDirectTasteEvidenceAndCachedSelectionRechecksLatestGenres() throws {
        let seed = song(1)
        var direct = song(2); direct.relatedTo = [seed.id]; direct.directRelatedTo = [seed.id]
        var indirect = song(3); indirect.relatedTo = [seed.id]
        var library = Library(); library.merge([seed, direct, indirect]); library.likedIDs = [seed.id]
        let cache = PulseEngine.rank([indirect, direct], library: library, now: now)
        XCTAssertEqual(cache.map(\.id), [direct.id])
        library.tracks[seed.id]?.genre = "Rock"; library.tracks[direct.id]?.genre = "Jazz"
        XCTAssertNil(PulseEngine.selectCached(cache, library: library, exclude: [], now: now))
    }
    func testGenreEvidenceSurvivesMergeAndRoundTripWhileOldContextIsIgnored() throws {
        var seed = song(1)
        seed.genreEvidence = GenreEvidence(values: ["Rock"], confidence: 0.95, checkedAt: now.timeIntervalSince1970 * 1000, recordingId: "12")
        var library = Library(); library.merge([seed]); library.merge([song(1)])
        XCTAssertEqual(GenreClassifier.genres(try XCTUnwrap(library.tracks[seed.id])), ["Rock"])
        let loaded = try JSONDecoder().decode(Library.self, from: JSONEncoder().encode(library))
        XCTAssertEqual(loaded.tracks[seed.id]?.genreEvidence, seed.genreEvidence)
        var old = RecommendationContext(features: [1,0,0,0,0,0,0,0,0,0], lane: "nearby"); old.version = 1
        XCTAssertFalse(old.isValid)
    }
    func testSavedTrackNeighbourBeatsAnUnrelatedSongWithOnlyTheSameBroadGenre() {
        let seed = song(1, genre: "Pop"), generic = song(3, genre: "Pop")
        var direct = song(2); direct.relatedTo = [seed.id]; direct.directRelatedTo = [seed.id]
        var library = Library(); library.merge([seed]); library.likedIDs = [seed.id]; library.settings.artistDiversity = 0
        XCTAssertEqual(PulseEngine.rank([generic, direct], library: library, limit: 2, now: now).first?.id, direct.id)
    }

    func testGenericEnergeticMusicDoesNotReplaceSongsOrLearnFromAnAccidentalCompletion() {
        let seed = song(1, genre: "Pop")
        var generic = song(2, genre: "Pop"); generic.title = "Energetic Music"; generic.relatedTo = [seed.id]; generic.directRelatedTo = [seed.id]
        var real = song(3, genre: "Pop"); real.title = "Энергия"; real.relatedTo = [seed.id]; real.directRelatedTo = [seed.id]
        var library = Library(); library.merge([seed, generic, real]); library.likedIDs = [seed.id]
        library.events = [.init(trackID: generic.id, kind: .listen, at: now, seconds: 190, ratio: 0.95)]
        XCTAssertEqual(PulseEngine.rank([generic, real], library: library, now: now).map(\.id), [real.id])
        XCTAssertFalse(PulseEngine.anchors(in: library, now: now).contains { $0.id == generic.id })
        library.likedIDs = [generic.id]
        XCTAssertEqual(PulseEngine.rank([generic], library: library, now: now).first?.id, generic.id)
    }

}
