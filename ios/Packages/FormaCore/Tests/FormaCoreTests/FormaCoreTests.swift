import Foundation
import XCTest
@testable import FormaCore

final class FormaCoreTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func track(_ number: Int, artist: String = "Artist", genre: String = "House", mood: String? = nil, related: [String] = []) -> Track {
        Track(videoID: String(format: "%011d", number), title: "Track \(number)", artist: artist, duration: 200, genres: genre.isEmpty ? [] : [genre], moodHints: mood.map { [$0] } ?? [], relatedTo: related)
    }
    func testPublicYouTubeLinksAndBareIDs() {
        for link in ["abcdefghijk", "https://youtu.be/abcdefghijk?t=3", "https://music.youtube.com/watch?v=abcdefghijk", "https://www.youtube.com/shorts/abcdefghijk", "https://youtube.com/live/abcdefghijk"] { XCTAssertEqual(VideoID.parse(link), "abcdefghijk") }
    }
    func testRejectsSpoofedHostsCredentialsAndInvalidIDs() {
        for link in ["https://youtube.com.evil.example/watch?v=abcdefghijk", "https://user@youtube.com/watch?v=abcdefghijk", "https://youtube.com:443/watch?v=abcdefghijk", "http://youtu.be/abcdefghijk", "https://youtu.be/short", "https://evil.example/abcdefghijk", "https://youtube.com/playlist?list=abcdefghijk"] { XCTAssertNil(VideoID.parse(link)) }
    }
    func testSameMusicRendererAsDesktopHasCleanTitleArtistAndDuration() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "music-search", withExtension: "json"))
        let tracks = try CatalogParser.tracks(from: Data(contentsOf: url))
        XCTAssertEqual(tracks.count, 1); XCTAssertEqual(tracks[0].title, "Soft Focus")
        XCTAssertEqual(tracks[0].artist, "Test Artist"); XCTAssertEqual(tracks[0].duration, 200)
        XCTAssertEqual(tracks[0].artworkURL?.host, "i.ytimg.com")
    }
    func testPanelQueueDeduplicatesAndRejectsUnavailableRows() throws {
        let row: [String: Any] = ["playlistPanelVideoRenderer": ["videoId": "abcdefghijk", "title": ["simpleText": "Song"], "longBylineText": ["runs": [["text": "Artist"]]], "lengthText": ["simpleText": "1:02:03"]]]
        let unavailable: [String: Any] = ["playlistPanelVideoRenderer": ["videoId": "12345678901", "title": ["simpleText": "Hidden"], "unplayableText": ["simpleText": "No"]]]
        let data = try JSONSerialization.data(withJSONObject: ["contents": [row, row, unavailable]])
        let tracks = try CatalogParser.tracks(from: data)
        XCTAssertEqual(tracks.count, 1); XCTAssertEqual(tracks[0].duration, 3723)
    }
    func testUnknownWrappersDoNotInventTracks() throws {
        XCTAssertEqual(try CatalogParser.tracks(from: Data(#"{"newShape":{"title":"Imaginary song","videoId":"abcdefghijk"}}"#.utf8)), [])
        XCTAssertThrowsError(try CatalogParser.tracks(from: Data("<html>Verification required</html>".utf8)))
    }
    func testLikesAndPlaylistMembershipShapeCommonTaste() {
        var library = Library(); let seed = track(1, artist: "Mine"), good = track(2, artist: "Mine"), other = track(3, artist: "Other", genre: "Rock")
        library.merge([seed, good, other]); library.likedIDs = [seed.id]
        XCTAssertEqual(PulseEngine.rank([other, good], library: library, now: now).first?.id, good.id)
        library.likedIDs = []; library.playlists = [Playlist(name: "Favorites", trackIDs: [seed.id])]
        XCTAssertEqual(PulseEngine.rank([other, good], library: library, now: now).first?.id, good.id)
    }
    func testEarlySkipsPenalizeRelatedMusicAndErrorsDoNot() {
        var library = Library(); library.settings.genres = []
        let skipped = track(1, artist: "Skipped"), related = track(2, artist: "Skipped"), other = track(3, artist: "Other")
        library.merge([skipped, related, other]); library.record(.init(trackID: skipped.id, kind: .skip, at: now, seconds: 8, ratio: 0.04))
        let result = PulseEngine.rank([related, other], library: library, now: now)
        XCTAssertGreaterThan(try! XCTUnwrap(result.first(where: { $0.id == other.id })?.score), try! XCTUnwrap(result.first(where: { $0.id == related.id })?.score))
        let before = result.map(\.score); library.record(.init(trackID: related.id, kind: .error, at: now, seconds: 8, ratio: 0))
        XCTAssertEqual(PulseEngine.rank([related, other], library: library, now: now).map(\.score), before)
    }
    func testLateAndInstantSkipsDoNotTrainTaste() {
        XCTAssertNil(ListeningEvent(trackID: "abcdefghijk", kind: .skip, seconds: 1, ratio: 0.01).reward)
        XCTAssertNil(ListeningEvent(trackID: "abcdefghijk", kind: .skip, seconds: 190, ratio: 0.95).reward)
    }
    func testSessionInterestFadesWhileExplicitFavoriteRemains() {
        var library = Library(); library.settings.genres = []
        let seed = track(1, artist: "Recent"), related = track(2, artist: "Recent")
        library.merge([seed, related]); library.record(.init(trackID: seed.id, kind: .listen, at: now, seconds: 195, ratio: 0.95))
        let scoreNow = PulseEngine.rank([related], library: library, now: now)[0].score
        let scoreLater = PulseEngine.rank([related], library: library, now: now.addingTimeInterval(3 * 3600))[0].score
        XCTAssertGreaterThan(scoreNow, scoreLater)
        library.likedIDs = [seed.id]; library.events = []
        XCTAssertEqual(PulseEngine.rank([related], library: library, now: now)[0].score, PulseEngine.rank([related], library: library, now: now.addingTimeInterval(90 * 86400))[0].score)
    }
    func testBlockedArtistsAndCooldownWinOverLikes() {
        var library = Library(); let first = track(1, artist: "Hidden"), recent = track(2, artist: "Recent"), valid = track(3, artist: "Other")
        library.merge([first, recent, valid]); library.likedIDs = [first.id]
        library.settings.excludedArtists = ["hidden"]
        library.record(.init(trackID: recent.id, kind: .listen, at: now, seconds: 100, ratio: 0.5))
        XCTAssertEqual(PulseEngine.rank([first, recent, valid], library: library, now: now).map(\.id), [valid.id])
    }
    func testRetrievalKeepsMinorityArtists() {
        var library = Library(); let tracks = (1...12).map { track($0, artist: "Main") } + [track(20, artist: "Minority")]
        library.merge(tracks); library.likedIDs = tracks.map(\.id)
        XCTAssertTrue(PulseEngine.anchors(in: library, limit: 4, now: now).contains { $0.artist == "Minority" })
    }
    func testMoodPlaylistsShareLikesAndConsumedFeedback() {
        var library = Library(); let seed = track(1, artist: "Mine", mood: "calm"), good = track(2, artist: "Mine", mood: "calm"), other = track(3, artist: "Other", mood: "calm"), wrong = track(4, mood: "energetic")
        library.merge([seed, good, other, wrong]); library.likedIDs = [seed.id]
        let before = library.events.count
        let shelf = PulseEngine.rank([other, good, wrong], library: library, mood: "calm", now: now)
        XCTAssertEqual(shelf.first?.id, good.id); XCTAssertFalse(shelf.contains { $0.id == wrong.id }); XCTAssertEqual(library.events.count, before)
        library.likedIDs = []; library.record(.init(trackID: good.id, kind: .listen, at: now, seconds: 190, ratio: 0.95, mood: "calm"))
        XCTAssertEqual(PulseEngine.rank([other, seed], library: library, now: now).first?.id, seed.id)
    }
    func testArtistDiversityAndSeedRelations() {
        var library = Library(); let seed = track(1, artist: "Saved", genre: "")
        let related = track(2, artist: "New", genre: "", related: [seed.id]), unrelated = track(3, artist: "Other", genre: "")
        library.merge([seed]); library.likedIDs = [seed.id]; library.settings.genres = []
        XCTAssertEqual(PulseEngine.rank([unrelated, related], library: library, now: now).first?.id, related.id)
        let many = (4...15).map { track($0, artist: "Same") } + [track(20, artist: "Different")]
        XCTAssertTrue(PulseEngine.rank(many, library: Library(), limit: 3, now: now).contains { $0.track.artist == "Different" })
    }
    func testConsumptionUsesPlaybackTimeNotSeekPositionOrPause() {
        var clock = ConsumptionClock()
        clock.tick(at: 10, playing: true); clock.tick(at: 10.5, playing: true)
        clock.tick(at: 11, playing: false); clock.tick(at: 100, playing: false)
        clock.tick(at: 100.5, playing: true, seeking: true); clock.tick(at: 101, playing: true)
        XCTAssertEqual(clock.seconds, 1, accuracy: 0.001)
        clock.tick(at: 400, playing: true); XCTAssertEqual(clock.seconds, 3, accuracy: 0.001)
    }
    func testStreamCacheHonorsExpiryAndValidatesSource() throws {
        let good = try ResolvedAudio(url: URL(string: "https://rr1.googlevideo.com/videoplayback?expire=1800000200")!, resolvedAt: now)
        XCTAssertTrue(good.isFresh(at: now)); XCTAssertFalse(good.isFresh(at: now.addingTimeInterval(150)))
        let unknown = try ResolvedAudio(url: URL(string: "https://rr1.googlevideo.com/videoplayback")!, resolvedAt: now)
        XCTAssertFalse(unknown.isFresh(at: now.addingTimeInterval(250)))
        for url in ["https://googlevideo.com.evil.example/a", "file:///a", "http://rr1.googlevideo.com/a", "https://user@rr1.googlevideo.com/a"] {
            XCTAssertThrowsError(try ResolvedAudio(url: URL(string: url)!, resolvedAt: now))
        }
    }
    func testLibraryRoundTripHasNoStreamURLsAndPreservesHistory() throws {
        var library = Library(); let song = track(1); library.merge([song]); library.likedIDs = [song.id]
        library.record(.init(trackID: song.id, kind: .listen, at: now, seconds: 190, ratio: 0.95, mood: "calm"))
        let data = try JSONEncoder().encode(library)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("googlevideo"))
        let loaded = try JSONDecoder().decode(Library.self, from: data)
        XCTAssertEqual(loaded.events[0].mood, "calm"); XCTAssertEqual(loaded.likedIDs, [song.id])
    }
    func testAtomicSaveBackupAndCorruptionRecovery() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = LibraryDiskStore(url: directory.appendingPathComponent("library.json"))
        var library = Library(); library.likedIDs = ["abcdefghijk"]
        try store.save(library); library.likedIDs.append("12345678901"); try store.save(library)
        XCTAssertEqual(try store.load().library.likedIDs.count, 2)
        try Data("corrupt".utf8).write(to: store.url)
        let recovered = try store.load(); XCTAssertEqual(recovered.library.likedIDs, ["abcdefghijk"]); XCTAssertNotNil(recovered.notice)
        let archived = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first { $0.lastPathComponent.contains("unreadable") }
        XCTAssertEqual(try String(contentsOf: XCTUnwrap(archived), encoding: .utf8), "corrupt")
    }
    func testMergingRetainsDiscoveryEvidenceAndHistoryIsBounded() {
        var library = Library(); let song = track(1, mood: "calm"); library.merge([song])
        library.merge([Track(videoID: song.id, title: song.title, artist: song.artist)])
        XCTAssertEqual(library.tracks[song.id]?.moodHints, ["calm"])
        for _ in 0..<3100 { library.record(.init(trackID: song.id, kind: .listen, seconds: 190, ratio: 0.95)) }
        XCTAssertEqual(library.events.count, 3000)
    }
}
