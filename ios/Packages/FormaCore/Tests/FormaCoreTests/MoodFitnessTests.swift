import Foundation
import XCTest
@testable import FormaCore

final class MoodFitnessTests: XCTestCase {
    private struct Fixture: Decodable { let name: String; let track: Track; let accept: [String]; let reject: [String] }
    private func fixtures() throws -> [Fixture] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "mood-fitness", withExtension: "json"))
        return try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: url))
    }
    func testSharedRecordingEvidenceCases() throws {
        for f in try fixtures() {
            let scores = MoodFitness.scores(f.track)
            for id in f.accept { XCTAssertGreaterThanOrEqual(scores[id] ?? 0, 0.6, f.name + ": " + id) }
            for id in f.reject { XCTAssertEqual(scores[id], 0, f.name + ": " + id) }
        }
        XCTAssertEqual(Set(MoodMix.all.map(\.id)), Set(["calm", "bright", "melancholic", "energetic", "focus", "night"]))
        XCTAssertTrue(MoodMix.all.allSatisfy { $0.title.range(of: "[A-Za-z]", options: .regularExpression) == nil })
    }
    func testFavouriteAndRetrievalHintsCannotOverrideMood() throws {
        let data = try fixtures()
        var calm = try XCTUnwrap(data.first { $0.name == "quiet_vocal" }?.track)
        var wrong = try XCTUnwrap(data.first { $0.name == "busy_instrumental" }?.track)
        var unknown = try XCTUnwrap(data.first { $0.name == "query_labels_only" }?.track)
        for track in [calm, wrong, unknown] { XCTAssertTrue(VideoID.isValid(track.id)) }
        calm.artist = "Любимый"; wrong.artist = "Любимый"; unknown.artist = "Любимый"
        calm.genre = "Pop"; wrong.genre = "Pop"; unknown.genre = "Pop"
        var library = Library(); library.merge([calm, wrong, unknown]); library.settings.repeatHours = 0
        library.settings.genres = ["Pop"]; library.likedIDs = [wrong.id, unknown.id]
        XCTAssertEqual(PulseEngine.rank([wrong, unknown, calm], library: library, mood: "calm").map(\.id), [calm.id])
        library.hiddenIDs = [calm.id]
        XCTAssertTrue(PulseEngine.rank([wrong, unknown, calm], library: library, mood: "calm").isEmpty)
    }
    func testCachedPlaybackChecksNewAudioEvidenceBeforeSelecting() throws {
        let data = try fixtures(), calm = try XCTUnwrap(data.first { $0.name == "quiet_vocal" }?.track)
        let busy = try XCTUnwrap(data.first { $0.name == "busy_instrumental" }?.track)
        var library = Library(); library.merge([calm]); library.settings.repeatHours = 0
        let index = PulseEngine.makeIndex([calm], library: library)
        let cached = PulseEngine.rank([calm], library: library, mood: "calm", index: index)
        XCTAssertNotNil(PulseEngine.selectCached(cached, library: library, exclude: [], index: index, mood: "calm"))
        library.tracks[calm.id]?.soundProfile = busy.soundProfile
        XCTAssertNil(PulseEngine.selectCached(cached, library: library, exclude: [], index: index, mood: "calm"))
    }
}
