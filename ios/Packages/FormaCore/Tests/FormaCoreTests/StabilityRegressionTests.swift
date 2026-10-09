import Foundation
import XCTest
@testable import FormaCore

final class StabilityRegressionTests: XCTestCase {
    private let a = "abcdefghijk", b = "12345678901", c = "abcdefghij2"
    func testUnchangedIncomingSnapshotDoesNotResurrectLocalUnlike() {
        XCTAssertEqual(LibrarySync.mergeIDs(current: [a], base: [a, b], incoming: [a, b]), [a])
        XCTAssertEqual(Set(LibrarySync.mergeIDs(current: [a, c], base: [a, b], incoming: [a, b, "other"])), Set([a, c, "other"]))
        XCTAssertEqual(LibrarySync.mergeIDs(current: [], base: [a], incoming: []), [])
    }
    func testSyncKeepsDeletionOnEitherSideAndConcurrentNewLikes() {
        var base = Library(); base.likedIDs = [a, b]
        var current = base; current.likedIDs = [a, c]
        var incoming = base; incoming.likedIDs = [b, "phone"]
        let result = LibrarySync.merge(current: current, base: base, incoming: incoming)
        XCTAssertEqual(Set(result.likedIDs), Set([c, "phone"]))
        XCTAssertEqual(LibrarySync.merge(current: result, base: incoming, incoming: incoming).likedIDs, result.likedIDs)
    }
    func testConcurrentPlaylistDeletionWinsOverRenameAndMembershipChange() {
        var base = Library(); base.playlists = [Playlist(id: "p", name: "Old", trackIDs: [a])]
        var current = base; current.playlists = []
        var incoming = base; incoming.playlists[0].name = "Renamed"; incoming.playlists[0].trackIDs.append(b)
        XCTAssertTrue(LibrarySync.merge(current: current, base: base, incoming: incoming).playlists.isEmpty)
    }
    func testMillisecondRoundTripDoesNotDuplicateHistoryOrLoseReset() {
        var base = Library(); base.record(.init(trackID: a, kind: .listen, at: Date(timeIntervalSince1970: 1_800_000_000.123456), seconds: 180, ratio: 0.9))
        var remote = base; remote.events = [.init(trackID: a, kind: .listen, at: Date(timeIntervalSince1970: 1_800_000_000.123), seconds: 180, ratio: 0.9)]
        let result = LibrarySync.merge(current: remote, base: base, incoming: base)
        XCTAssertEqual(result.events.count, 1)
        var reset = base; reset.events = []
        XCTAssertTrue(LibrarySync.merge(current: remote, base: base, incoming: reset).events.isEmpty)
    }
    func testSparseCatalogueUpdatesPreserveDurationArtistAndArtwork() {
        let cover = URL(string: "https://i.ytimg.com/vi/\(a)/hqdefault.jpg")!
        var library = Library()
        library.merge([Track(videoID: a, title: "Known", artist: "Artist", duration: 210, artworkURL: cover)])
        library.merge([Track(videoID: a, title: "", artist: "Исполнитель не указан", genres: ["Rock"])])
        XCTAssertEqual(library.tracks[a]?.duration, 210); XCTAssertEqual(library.tracks[a]?.artworkURL, cover)
        XCTAssertEqual(library.tracks[a]?.artist, "Artist"); XCTAssertEqual(library.tracks[a]?.title, "Known")
        library.merge([Track(videoID: a, title: "Corrected", artist: "Corrected artist", duration: 200)])
        XCTAssertEqual(library.tracks[a]?.duration, 200); XCTAssertEqual(library.tracks[a]?.artist, "Corrected artist")
    }
    func testCachedSelectionAppliesNewMoodBeforeBackgroundRankingFinishes() {
        let calm = Track(videoID: a, title: "Тихо", artist: "A", moodHints: ["calm"])
        let energy = Track(videoID: b, title: "Громко", artist: "B", moodHints: ["energetic"])
        var library = Library(); library.settings.genres = []; library.merge([energy, calm])
        let cached = PulseEngine.rank([energy, calm], library: library)
        library.settings.mood = "calm"
        XCTAssertEqual(PulseEngine.selectCached(cached, library: library, exclude: [])?.id, a)
        XCTAssertEqual(PulseEngine.selectCached(cached, library: library, exclude: [], mood: "energetic")?.id, b)
    }
    func testNormalizationRepairsDuplicateUIIdentitiesAndUnsafeSliderValues() {
        var library = Library(); library.tracks = [a: Track(videoID: a, title: "Song", artist: "A"), b: Track(videoID: a, title: "Wrong identity", artist: "B")]
        library.likedIDs = [a, a, "invalid"]
        library.playlists = [Playlist(id: "p", name: "One", trackIDs: [a]), Playlist(id: "p", name: "Duplicate", trackIDs: [b, a])]
        library.settings.discovery = 900; library.settings.artistDiversity = -.infinity; library.settings.sessionInfluence = .nan
        library.settings.repeatHours = 500; library.settings.mood = "bad-value"; library.settings.languagePreference = "missing"
        let fixed = LibraryValidation.normalized(library)
        XCTAssertEqual(fixed.tracks.count, 1); XCTAssertEqual(fixed.likedIDs, [a]); XCTAssertEqual(fixed.playlists.count, 1)
        XCTAssertEqual(fixed.playlists[0].trackIDs, [a, b]); XCTAssertEqual(fixed.settings.discovery, 1)
        XCTAssertEqual(fixed.settings.artistDiversity, 0.6); XCTAssertEqual(fixed.settings.sessionInfluence, 0.65)
        XCTAssertEqual(fixed.settings.repeatHours, 24); XCTAssertEqual(fixed.settings.mood, "any"); XCTAssertEqual(fixed.settings.languagePreference, "ru")
    }
    func testDecodedExtremeDurationAndPreferencesCannotOverflowUI() throws {
        let data = Data(#"{"version":1,"tracks":{"abcdefghijk":{"videoID":"abcdefghijk","title":"Song","artist":"A","duration":1e300}},"likedIDs":[],"playlists":[],"events":[],"settings":{"discovery":1e300,"artistDiversity":-1,"repeatHours":1e300,"sessionInfluence":1e300}}"#.utf8)
        let library = try JSONDecoder().decode(Library.self, from: data)
        XCTAssertEqual(library.tracks[a]?.duration, 86400); XCTAssertEqual(library.settings.discovery, 1)
        XCTAssertEqual(library.settings.artistDiversity, 0); XCTAssertEqual(library.settings.repeatHours, 24)
        XCTAssertEqual(library.settings.sessionInfluence, 1)
    }
    func testMissingPrimaryFileRecoversBackupRatherThanStartingEmpty() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = LibraryDiskStore(url: dir.appendingPathComponent("library.json"))
        var library = Library(); library.likedIDs = [a]; try store.save(library)
        library.likedIDs.append(b); try store.save(library)
        try FileManager.default.removeItem(at: store.url)
        let loaded = try store.load(); XCTAssertEqual(loaded.library.likedIDs, [a]); XCTAssertNotNil(loaded.notice)
    }
    func testMalformedDurationIsRejectedAndHugeThumbnailSizeDoesNotOverflow() throws {
        for value in ["1:x:30", "1::30", "-1:30", "1:99", "inf:00", "NaN:00"] { XCTAssertEqual(CatalogParser.seconds(value), 0, value) }
        XCTAssertEqual(CatalogParser.seconds("1:02:03"), 3723)
        let data = try JSONSerialization.data(withJSONObject: ["thumbnail": ["thumbnails": [["url": "https://i.ytimg.com/large.jpg", "width": Int.max, "height": Int.max], ["url": "https://i.ytimg.com/small.jpg", "width": 120, "height": 90]]]])
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(CatalogParser.thumb(object)?.lastPathComponent, "large.jpg")
    }
    func testLearningIgnoresInvalidDatesAndMeasurementHandlesNonfiniteNumbers() {
        var library = Library(); library.events = [.init(trackID: a, kind: .like, at: Date(timeIntervalSince1970: -1e300), seconds: 0, ratio: 0, recommendation: .init(features: [1] + Array(repeating: 0.5, count: 9), lane: "nearby"))]
        XCTAssertTrue(LibraryValidation.normalized(library).events.isEmpty)
        let sample = PlaybackMeasurement(title: "test", source: "network", totalMilliseconds: .infinity, resolutionMilliseconds: .nan)
        XCTAssertEqual(sample.totalMilliseconds, 0); XCTAssertEqual(sample.resolutionMilliseconds, 0)
        XCTAssertEqual(PlaybackMeasurement.percentile([sample], source: "network", fraction: .nan), 0)
    }
    func testEditsDuringAsynchronousRestoreMergeWithoutLosingStoredLibrary() {
        var stored = Library(); stored.likedIDs = [a]; stored.settings.discovery = 0.9
        var session = Library(); session.likedIDs = [b]; session.playlists = [Playlist(id: "new", name: "During startup", trackIDs: [b])]
        let restored = LibrarySync.merge(current: stored, base: Library(), incoming: session)
        XCTAssertEqual(Set(restored.likedIDs), Set([a, b])); XCTAssertEqual(restored.settings.discovery, 0.9)
        XCTAssertEqual(restored.playlists.map(\.id), ["new"])
    }
    func testRestoreAndSyncPreservePlaylistDisplayOrder() {
        var stored = Library(); stored.playlists = [Playlist(id: "z", name: "First", trackIDs: [a]), Playlist(id: "a", name: "Second", trackIDs: [b])]
        XCTAssertEqual(LibrarySync.merge(current: stored, base: Library(), incoming: Library()).playlists.map(\.id), ["z", "a"])
        var incoming = stored; incoming.playlists.append(Playlist(id: "m", name: "New", trackIDs: [c]))
        XCTAssertEqual(LibrarySync.merge(current: stored, base: stored, incoming: incoming).playlists.map(\.id), ["z", "a", "m"])
    }
}
