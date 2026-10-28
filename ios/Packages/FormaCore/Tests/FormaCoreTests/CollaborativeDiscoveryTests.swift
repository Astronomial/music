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
    func testNeighbourWindowRotatesAcrossEveryArtist() {
        let artists = (0..<6).map { CollaborativeDiscovery.Artist(mbid: String($0), name: "Artist \($0)") }
        let selected = (0..<3).flatMap { CollaborativeDiscovery.window(artists, offset: $0 * 2) }
        XCTAssertEqual(Set(selected.map(\.mbid)).count, 6)
        XCTAssertTrue(CollaborativeDiscovery.window([], offset: 0).isEmpty)
    }
    func testVerifiedNeighboursEnterPulseAndUnknownOrBannedOnesCannot() {
        let seed = Track(videoID: "00000000001", title: "Песня 1", artist: "Saved", genre: "Alternative")
        var candidate = Track(videoID: "00000000002", title: "Песня 2", artist: "New", genre: "Alternative")
        candidate.relatedTo = [seed.id]; candidate.retrievalSources = ["listenbrainz-neighbour", "lb-root:" + seed.id]
        var library = Library(); library.merge([seed]); library.likedIDs = [seed.id]
        let ranked = PulseEngine.rank([candidate], library: library)
        XCTAssertEqual(ranked.map(\.id), [candidate.id]); XCTAssertEqual(ranked.first?.exposure?.lane, "nearby")
        XCTAssertTrue(CollaborativeDiscovery.linked(candidate, seed: seed))
        let stale = ranked
        candidate.genre = ""; library.merge([candidate]); XCTAssertTrue(PulseEngine.rank([candidate], library: library).isEmpty)
        XCTAssertNil(PulseEngine.selectCached(stale, library: library, exclude: []))
        candidate.genre = "Russian Chanson"; library.merge([candidate]); library.likedIDs += [candidate.id]
        XCTAssertTrue(PulseEngine.rank([candidate], library: library).isEmpty)
    }
    private actor Transport {
        var urls: [URL] = []
        var isOpen = false
        var waiter: CheckedContinuation<Void, Never>?
        func open() { isOpen = true; waiter?.resume(); waiter = nil }
        func count() -> Int { urls.count }
        func get(_ url: URL) async -> Data {
            urls.append(url)
            if !isOpen { await withCheckedContinuation { waiter = $0 } }
            if url.host == "musicbrainz.org" { return Data("{\"artists\":[{\"id\":\"3c1b6453-a4a0-4801-9e33-af590e33b875\",\"name\":\"Три дня дождя\"}]}".utf8) }
            return Data("{\"b2e4a44e-e105-4325-a085-75d608753f0e\":[{\"recording_mbid\":\"401c1a5d-56e7-434d-b07e-a14d4e7eb83c\",\"similar_artist_mbid\":\"b2e4a44e-e105-4325-a085-75d608753f0e\",\"similar_artist_name\":\"New artist\",\"total_listen_count\":1}]}".utf8)
        }
    }
    func testColdCacheReturnsBeforeOptionalNetworkAndCoalescesArtistRequests() async {
        let transport = Transport()
        let store = SimilarArtistStore(fetch: { url in await transport.get(url) })
        let cold = await store.cached("Три дня дождя")
        XCTAssertTrue(cold.isEmpty, "This call must finish while the network gate is still closed")
        await transport.open()
        let names = await store.prefetch("Три дня дождя")
        let hit = await store.cached("Три дня дождя")
        let count = await transport.count()
        XCTAssertEqual(names.map(\.name), ["New artist"]); XCTAssertEqual(hit, names); XCTAssertEqual(count, 2)
    }
    private actor Failures {
        var calls = 0
        func get(_ url: URL) throws -> Data { calls += 1; throw URLError(.notConnectedToInternet) }
        func count() -> Int { calls }
    }
    func testOutageUsesCooldownAndDoesNotRejectTheCaller() async {
        let transport = Failures()
        let store = SimilarArtistStore(fetch: { url in try await transport.get(url) })
        let first = await store.prefetch("MARKUL"), second = await store.prefetch("MARKUL")
        let count = await transport.count()
        XCTAssertTrue(first.isEmpty); XCTAssertTrue(second.isEmpty); XCTAssertEqual(count, 1)
    }
    func testMergedSourceLabelsCannotCorroborateAnotherRecordingRoot() {
        let seed = Track(videoID: "00000000001", title: "Saved", artist: "Saved", genre: "Alternative")
        var candidate = Track(videoID: "00000000002", title: "New", artist: "New", genre: "Alternative")
        candidate.relatedTo = [seed.id, "99999999999"]; candidate.retrievalSources = ["listenbrainz-neighbour", "lb-root:99999999999"]
        var library = Library(); library.merge([seed]); library.likedIDs = [seed.id]
        XCTAssertTrue(PulseEngine.rank([candidate], library: library).isEmpty)
    }
}
