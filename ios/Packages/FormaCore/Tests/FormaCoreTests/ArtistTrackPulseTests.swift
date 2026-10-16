import XCTest
@testable import FormaCore

final class ArtistTrackPulseTests: XCTestCase {
    func testFixedTrackSeedExcludesVersionsAndUnrelatedLibrary() {
        let seed = Track(videoID: "seed0000001", title: "Моя песня", artist: "Артист")
        let near = Track(videoID: "near0000001", title: "Другая песня", artist: "Новый артист", relatedTo: [seed.id], directRelatedTo: [seed.id])
        let other = Track(videoID: "diff0000001", title: "Чужая песня", artist: "Любимый артист")
        let remix = Track(videoID: "same0000001", title: "Моя песня (DJ Remix)", artist: "Кавер артист", relatedTo: [seed.id])
        var library = Library(); library.merge([seed, near, other, remix]); library.likedIDs = [other.id]; library.settings.languagePreference = "any"
        let ranked = PulseEngine.rank(Array(library.tracks.values), library: library, trackID: seed.id)
        XCTAssertEqual(ranked.map(\.id), [near.id]); XCTAssertTrue(TrackPulse.sameSong(seed, remix)); XCTAssertEqual(library.likedIDs, [other.id])
    }
    func testPublicationLabels() {
        XCTAssertEqual(CatalogParser.publicationAgeDays("3 недели назад"), 21)
        XCTAssertEqual(CatalogParser.publicationAgeDays("2 days ago"), 2)
        XCTAssertEqual(CatalogParser.publicationAgeDays("unknown"), .infinity)
    }
    func testChannelMetadataSurvivesOldProfilesAndMerges() throws {
        let old = Data(#"{"videoID":"near0000001","title":"Песня","artist":"Артист"}"#.utf8)
        var track = try JSONDecoder().decode(Track.self, from: old); XCTAssertNil(track.artistID)
        track.artistID = "UCabcdefghijklmnop"
        var library = Library(); library.merge([track]); var fresh = track; fresh.artistID = nil; library.merge([fresh])
        XCTAssertEqual(library.tracks[track.id]?.artistID, track.artistID)
        XCTAssertEqual(try JSONDecoder().decode(Track.self, from: JSONEncoder().encode(track)).artistID, track.artistID)
    }
    func testOrderedWebResultsUseKnownRendererAndSkipStreams() throws {
        let data = Data(#"{"contents":[{"videoRenderer":{"videoId":"near0000001","title":{"runs":[{"text":"Песня"}]},"ownerText":{"runs":[{"text":"Артист","navigationEndpoint":{"browseEndpoint":{"browseId":"UCabcdefghijklmnop"}}}]},"lengthText":{"simpleText":"3:00"}}},{"videoRenderer":{"videoId":"live0000001","title":{"simpleText":"Live"}}}]}"#.utf8)
        let tracks = try CatalogParser.tracks(from: data)
        XCTAssertEqual(tracks.map(\.id), ["near0000001"]); XCTAssertEqual(tracks.first?.artistID, "UCabcdefghijklmnop")
    }
}
