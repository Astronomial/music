import Foundation
import XCTest
@testable import FormaCore

final class CloudSoundTests: XCTestCase {
    private let id = "abcdefghijk", other = "lmnopqrstuv"
    private struct Fixture: Decodable { let warm: SoundProfile; let bright: SoundProfile; let document: CloudDocument; let library: Library }
    private func fixture() throws -> Fixture {
        let url = Bundle.module.url(forResource: "cloud-sound", withExtension: "json", subdirectory: "Fixtures")!
        let d = JSONDecoder(); d.dateDecodingStrategy = .millisecondsSince1970
        return try d.decode(Fixture.self, from: Data(contentsOf: url))
    }
    func testPCCloudDocumentKeepsDislikeSoundAndSelectionContext() throws {
        let f = try fixture(), l = try f.document.library()
        XCTAssertEqual(l.dislikedIDs, [id]); XCTAssertTrue(l.likedIDs.isEmpty)
        XCTAssertEqual(l.tracks[id]?.soundProfile, f.warm)
        XCTAssertEqual(l.events.first?.kind, .dislike); XCTAssertEqual(l.events.first?.recommendation?.features, f.library.events.first?.recommendation?.features)
        XCTAssertEqual(l.settings.languagePreference, "ru"); XCTAssertEqual(l.playlists.first?.trackIDs, [id])
    }
    func testOfflineConcurrentEditsConvergeAndDeletionDoesNotResurrect() throws {
        var base = Library(); base.merge([Track(videoID: id, title: "Track", artist: "Artist")]); base.likedIDs = [id]; base.playlists = [Playlist(id: "mix", name: "Тест", trackIDs: [id])]
        let now = Date(); var a = try CloudDocument(actor: "desktop-device").capturing(base, base: nil).publishing(now: now)
        var b = try CloudDocument(actor: "iphone-device").merging(a)
        var pc = base, phone = base; pc.likedIDs = []; pc.dislikedIDs = [id]; phone.playlists[0].trackIDs.append(other)
        a = try a.capturing(pc, base: base, now: now.addingTimeInterval(1)); b = try b.capturing(phone, base: base, now: now.addingTimeInterval(2))
        let ab = try a.merging(b), ba = try b.merging(a)
        XCTAssertEqual(ab.records, ba.records); let l = try ab.library(); XCTAssertEqual(l.dislikedIDs, [id]); XCTAssertEqual(l.playlists.first?.trackIDs, [id, other]); XCTAssertTrue(l.likedIDs.isEmpty)
        var edited = l; edited.dislikedIDs = []; edited.likedIDs = [id]; edited.playlists = []
        let updated = try ab.capturing(edited, base: l, now: now.addingTimeInterval(3)).merging(b).library()
        XCTAssertEqual(updated.likedIDs, [id]); XCTAssertTrue(updated.dislikedIDs.isEmpty); XCTAssertTrue(updated.playlists.isEmpty)
    }
    func testFirstLoginDoesNotReplaceExistingAccountSettings() throws {
        var base = Library(); base.settings.discovery = 0.9
        let published = try CloudDocument(actor: "first-device").capturing(base, base: nil).publishing()
        let new = try CloudDocument(actor: "second-device").capturing(Library(), base: nil).merging(published).library()
        XCTAssertEqual(new.settings.discovery, 0.9)
    }
    func testPCAndSwiftPCMDescriptorsAgreeAndSilenceIsNotInvented() throws {
        let f = try fixture()
        let samples = (0..<(16000 * 12)).map { i in Float(sin(2 * Double.pi * 220 * Double(i) / 16000) * 0.3 * (0.1 + exp(-(Double(i) / 16000).truncatingRemainder(dividingBy: 0.5) * 15))) }
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
        XCTAssertEqual(PulseEngine.rank([near, far], library: l, limit: 1).first?.id, far.id)
        XCTAssertEqual(PulseEngine.selectCached(cache, library: l, exclude: [])?.id, far.id)
        XCTAssertFalse(PulseEngine.anchors(in: l).contains { $0.id == near.id })
        XCTAssertEqual(PulseEngine.rank([near], library: l, limit: 1).first?.id, near.id)
    }
}
