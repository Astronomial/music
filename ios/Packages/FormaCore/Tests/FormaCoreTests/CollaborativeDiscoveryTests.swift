import Foundation
import XCTest
@testable import FormaCore

final class CollaborativeDiscoveryTests: XCTestCase {
    private let seedID = "3c1b6453-a4a0-4801-9e33-af590e33b875"
    private let otherID = "b2e4a44e-e105-4325-a085-75d608753f0e"
    func testIdentityLookupRejectsFuzzyAndAmbiguousResults() throws {
        let one = Data("{\"artists\":[{\"id\":\"\(seedID)\",\"name\":\"ксюшенька.\"}]}".utf8)
        XCTAssertEqual(try CollaborativeDiscovery.artistID(one, name: "ксюшенька"), seedID)
        XCTAssertNil(try CollaborativeDiscovery.artistID(one, name: "бэя"))
        let ambiguous = Data("{\"artists\":[{\"id\":\"\(seedID)\",\"name\":\"MARKUL\"},{\"id\":\"\(otherID)\",\"name\":\"MARKUL\"}]}".utf8)
        XCTAssertNil(try CollaborativeDiscovery.artistID(ambiguous, name: "markul"))
    }
    func testPublicPoolDoesNotInventRecordingGenresOrDirectEdges() throws {
        let data = Data("{\"\(otherID)\":[{\"recording_mbid\":\"401c1a5d-56e7-434d-b07e-a14d4e7eb83c\",\"similar_artist_mbid\":\"\(otherID)\",\"similar_artist_name\":\"Новый артист\",\"total_listen_count\":8}]}".utf8)
        XCTAssertEqual(try CollaborativeDiscovery.artists(data, excluding: seedID).map(\.name), ["Новый артист"])
        XCTAssertThrowsError(try CollaborativeDiscovery.artists(Data("{\"error\":\"outage\"}".utf8), excluding: seedID))
    }
    func testUnknownSearchLabelsCannotCorroborateCoListening() {
        let seed = Track(videoID: "00000000001", title: "Песня 1", artist: "Saved", genre: "Alternative")
        var other = Track(videoID: "00000000002", title: "Песня 2", artist: "New", genre: "Alternative")
        XCTAssertTrue(CollaborativeDiscovery.matches(other, seed: seed))
        other.genre = ""; other.genres = ["Alternative"]
        XCTAssertFalse(CollaborativeDiscovery.matches(other, seed: seed))
        other.genre = "Jazz"; XCTAssertFalse(CollaborativeDiscovery.matches(other, seed: seed))
    }
    func testVerifiedNeighboursEnterPulseAndUnknownOrBannedOnesCannot() {
        let seed = Track(videoID: "00000000001", title: "Песня 1", artist: "Saved", genre: "Alternative")
        var candidate = Track(videoID: "00000000002", title: "Песня 2", artist: "New", genre: "Alternative")
        candidate.relatedTo = [seed.id]; candidate.retrievalSources = ["listenbrainz-neighbour"]
        var library = Library(); library.merge([seed]); library.likedIDs = [seed.id]
        let ranked = PulseEngine.rank([candidate], library: library)
        XCTAssertEqual(ranked.map(\.id), [candidate.id]); XCTAssertEqual(ranked.first?.exposure?.lane, "nearby")
        let stale = ranked
        candidate.genre = ""; library.merge([candidate]); XCTAssertTrue(PulseEngine.rank([candidate], library: library).isEmpty)
        XCTAssertNil(PulseEngine.selectCached(stale, library: library, exclude: []))
        candidate.genre = "Russian Chanson"; library.merge([candidate]); library.likedIDs += [candidate.id]
        XCTAssertTrue(PulseEngine.rank([candidate], library: library).isEmpty)
    }
}
