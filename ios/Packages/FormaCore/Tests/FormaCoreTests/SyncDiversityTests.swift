import Foundation
import XCTest
@testable import FormaCore

final class SyncDiversityTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func track(_ n: Int, artist: String) -> Track { Track(videoID: String(format: "%011d", n), title: "Song \(n)", artist: artist, duration: 200, genres: ["House"]) }
    func testDesktopWireFormatDecodesRealIDsUnicodePreferencesAndMilliseconds() throws {
        let file = try XCTUnwrap(Bundle.module.url(forResource: "pc-sync", withExtension: "json"))
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .millisecondsSince1970
        let library = try decoder.decode(Library.self, from: Data(contentsOf: file))
        XCTAssertEqual(library.tracks["abcdefghijk"]?.title, "Свет — live")
        XCTAssertEqual(library.playlists[0].name, "Вечер 🎵")
        XCTAssertEqual(library.events[0].kind, .play); XCTAssertEqual(library.events[0].newArtist, true)
        XCTAssertEqual(library.events[0].at.timeIntervalSince1970, 1_800_000_000.123, accuracy: 0.001)
        XCTAssertEqual(library.hiddenIDs, ["12345678901"])
        XCTAssertEqual(library.settings.artistDiversity, 1); XCTAssertEqual(library.settings.seedPlaylistIDs, ["pc-list"])
        XCTAssertEqual(library.settings.excludedGenres, ["Rock"]); XCTAssertEqual(library.settings.excludedArtists, ["Скрытый"])
        XCTAssertEqual(library.settings.vocals, "instrumental")
    }
    func testPreviousMobileLibraryGetsCompatibleDefaults() throws {
        let data = Data(#"{"version":1,"tracks":{},"likedIDs":[],"events":[],"playlists":[],"settings":{"genres":["House"],"discovery":0.8}}"#.utf8)
        let library = try JSONDecoder().decode(Library.self, from: data)
        XCTAssertEqual(library.hiddenIDs, []); XCTAssertEqual(library.settings.artistDiversity, 0.6)
        XCTAssertEqual(library.settings.discovery, 0.8); XCTAssertTrue(library.settings.includeLibrary)
    }
    func testMergePreservesConcurrentEditsAndPropagatesDeletesAndHistoryReset() {
        var base = Library(); base.likedIDs = ["old"]; base.playlists = [Playlist(id: "old", name: "Old", trackIDs: ["old"])]
        base.events = [.init(trackID: "old", kind: .play, at: now, seconds: 0, ratio: 0)]
        var current = base; current.likedIDs.append("pc"); current.playlists.append(Playlist(id: "pc", name: "PC", trackIDs: ["pc"]))
        var incoming = base; incoming.likedIDs = ["phone"]; incoming.playlists = []; incoming.events = []; incoming.settings.artistDiversity = 1
        let result = LibrarySync.merge(current: current, base: base, incoming: incoming)
        XCTAssertEqual(Set(result.likedIDs), ["pc", "phone"]); XCTAssertEqual(result.playlists.map(\.id), ["pc"])
        XCTAssertTrue(result.events.isEmpty); XCTAssertEqual(result.settings.artistDiversity, 1)
        XCTAssertEqual(LibrarySync.merge(current: result, base: incoming, incoming: incoming).likedIDs, result.likedIDs)
    }
    func testPlaylistMembershipAndRenameMergeWithoutLosingConcurrentAdditions() {
        var base = Library(); base.playlists = [Playlist(id: "p", name: "Before", trackIDs: ["a"])]
        var current = base; current.playlists[0].trackIDs.append("pc")
        var incoming = base; incoming.playlists[0].trackIDs = ["phone"]; incoming.playlists[0].name = "After"
        let result = LibrarySync.merge(current: current, base: base, incoming: incoming)
        XCTAssertEqual(result.playlists[0].name, "After"); XCTAssertEqual(Set(result.playlists[0].trackIDs), ["pc", "phone"])
    }
    func testLiveCachedSelectionHonorsExposureAndNormalizesAliasesAndCollaborations() {
        let playing = track(1, artist: "A - Topic"), repeatArtist = track(2, artist: "A VEVO"), collaboration = track(3, artist: "A feat. B"), fresh = track(4, artist: "C")
        var library = Library(); library.merge([playing, repeatArtist, collaboration, fresh])
        library.record(.init(trackID: playing.id, kind: .play, at: Date(), seconds: 0, ratio: 0))
        XCTAssertEqual(PulseDiversity.artists(playing), PulseDiversity.artists(repeatArtist))
        XCTAssertEqual(PulseDiversity.next([repeatArtist, collaboration, fresh], library: library, exclude: [])?.id, fresh.id)
        library.settings.artistDiversity = 0
        XCTAssertEqual(PulseDiversity.next([repeatArtist, fresh], library: library, exclude: [])?.id, repeatArtist.id)
    }
    func testQueueDeliversUniqueRecordingsAndSpacedArtistsFromSkewedCatalogue() {
        var library = Library(); let seed = track(1, artist: "Saved")
        let tracks = (2...40).map { track($0, artist: "Saved") } + (41...64).map { track($0, artist: "New \($0)") }
        library.merge([seed] + tracks); library.likedIDs = [seed.id]; library.settings.artistDiversity = 1
        let result = PulseEngine.rank(tracks, library: library, limit: 18, now: now)
        XCTAssertEqual(result.count, 18); XCTAssertGreaterThanOrEqual(Set(result.map { $0.track.artist }).count, 16)
        XCTAssertGreaterThanOrEqual(result.filter(\.newArtist).count, 15)
        for i in result.indices where i > 0 { XCTAssertTrue(PulseDiversity.artists(result[i].track).isDisjoint(with: Set(result[max(0, i-5)..<i].flatMap { PulseDiversity.artists($0.track) }))) }
        let original = Track(videoID: "abcdefghijk", title: "Signal (Official Audio)", artist: "One")
        let duplicate = Track(videoID: "12345678901", title: "Signal (Official Video)", artist: "One - Topic")
        let remix = Track(videoID: "abcdefghij2", title: "Signal (Remix)", artist: "One")
        XCTAssertEqual(PulseDiversity.recording(original), PulseDiversity.recording(duplicate))
        XCTAssertNotEqual(PulseDiversity.recording(original), PulseDiversity.recording(remix))
        XCTAssertEqual(PulseEngine.rank([original, duplicate, remix], library: Library(), now: now).count, 2)
    }
    func testSearchDirectionsAndWeakCharacterEvidenceHonorSyncedPreferences() {
        var settings = PulseSettings(); settings.energy = "medium"; settings.vocals = "vocal"
        XCTAssertEqual(PulseDirections.suffix(settings), "mid tempo vocal")
        settings.energy = "low"; settings.vocals = "instrumental"
        XCTAssertTrue(PulseDirections.suffix(settings).contains("instrumental"))
        let instrumental = Track(videoID: "abcdefghijk", title: "Instrumental", artist: "New", moodHints: ["calm"])
        let unrelated = Track(videoID: "12345678901", title: "Song", artist: "Other")
        XCTAssertGreaterThan(PulseDirections.score(instrumental, settings: settings), PulseDirections.score(unrelated, settings: settings))
    }
}
