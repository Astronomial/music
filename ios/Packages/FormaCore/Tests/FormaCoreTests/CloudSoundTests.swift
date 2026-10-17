import Foundation
import XCTest
@testable import FormaCore

final class CloudSoundTests: XCTestCase {
    private let id = "abcdefghijk", other = "lmnopqrstuv"
    private struct Fixture: Decodable { let warm: SoundProfile; let bright: SoundProfile; let library: Library }
    private func fixture() throws -> Fixture {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "cloud-sound", withExtension: "json"))
        let d = JSONDecoder(); d.dateDecodingStrategy = .millisecondsSince1970
        return try d.decode(Fixture.self, from: Data(contentsOf: url))
    }
    func testPCWireLibraryKeepsDislikeSoundAndSelectionContext() throws {
        let f = try fixture(), l = f.library
        XCTAssertEqual(l.dislikedIDs, [id]); XCTAssertTrue(l.likedIDs.isEmpty)
        XCTAssertEqual(l.tracks[id]?.soundProfile, f.warm); XCTAssertEqual(l.events.first?.kind, .dislike)
        XCTAssertEqual(l.settings.languagePreference, "ru"); XCTAssertEqual(l.playlists.first?.trackIDs, [id])
    }
    func testPCAndSwiftPCMDescriptorsAgreeAndSilenceIsNotInvented() throws {
        let f = try fixture()
        let samples: [Float] = (0..<(16000 * 12)).map { i in
            let time: Double = Double(i) / 16000
            let carrier: Double = sin(2 * Double.pi * 220 * time)
            let amplitude: Double = 0.3 * (0.1 + exp(-time.truncatingRemainder(dividingBy: 0.5) * 15))
            return Float(carrier * amplitude)
        }
        let profile = try XCTUnwrap(SoundProfile.analyze(samples))
        for (a, b) in zip(profile.bands, f.warm.bands) { XCTAssertEqual(a, b, accuracy: 0.00001) }
        XCTAssertEqual(profile.tempo, f.warm.tempo, accuracy: 0.001); XCTAssertEqual(profile.dynamicRange, f.warm.dynamicRange, accuracy: 0.00001)
        XCTAssertGreaterThan(SoundProfile.similarity(profile, f.warm) ?? 0, 0.99); XCTAssertLessThan(SoundProfile.similarity(profile, f.bright) ?? 1, 0.6)
        XCTAssertNil(SoundProfile.analyze([Float](repeating: 0, count: 16000 * 12)))
    }
    func testDislikeAlwaysHasLastPriorityIncludingCachedQuotaSelection() throws {
        let f = try fixture(); var l = Library(); l.settings.genres = []; l.settings.artistDiversity = 1
        var seed = Track(videoID: id, title: "Seed", artist: "Seed artist"), near = Track(videoID: other, title: "Near", artist: "New artist"), far = Track(videoID: "12345678901", title: "Far", artist: "Other artist")
        seed.soundProfile = f.warm; near.soundProfile = f.warm; far.soundProfile = f.bright
        l.merge([seed, near, far]); l.likedIDs = [id]
        let cache = PulseEngine.rank([near, far], library: l, limit: 2)
        XCTAssertEqual(cache.first?.id, near.id)
        l.dislikedIDs = [near.id]; l.playlists = [Playlist(name: "Saved", trackIDs: [near.id])]
        XCTAssertTrue(PulseEngine.rank([near, far], library: l, limit: 1).isEmpty)
        XCTAssertNil(PulseEngine.selectCached(cache, library: l, exclude: []))
        XCTAssertFalse(PulseEngine.anchors(in: l).contains { $0.id == near.id })
        XCTAssertTrue(PulseEngine.rank([near], library: l, limit: 1).isEmpty)
    }
}
