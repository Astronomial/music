import Foundation
import XCTest
@testable import FormaCore

final class ArtworkTests: XCTestCase {
    func testMusicCoverUpsizesBeforeOriginalWithoutChangingIdentity() {
        let track = Track(videoID: "abcdefghijk", title: "Track", artist: "Artist", artworkURL: URL(string: "https://lh3.googleusercontent.com/album=w60-h60-l90-rj"))
        let urls = ArtworkPolicy.candidates(for: track, pixels: 1024)
        XCTAssertEqual(urls.first?.absoluteString, "https://lh3.googleusercontent.com/album=w1024-h1024-l90-rj")
        XCTAssertEqual(urls.last, track.artworkURL)
        XCTAssertFalse(urls.contains { $0.host == "i.ytimg.com" })
    }
    func testLargeVideoCoverHasFallbacksAndRowsAvoidMaxres() {
        let track = Track(videoID: "abcdefghijk", title: "Track", artist: "Artist", artworkURL: URL(string: "https://i.ytimg.com/vi/abcdefghijk/default.jpg"))
        XCTAssertEqual(ArtworkPolicy.candidates(for: track, pixels: 1024).prefix(3).map(\.lastPathComponent), ["maxresdefault.jpg", "sddefault.jpg", "hqdefault.jpg"])
        XCTAssertEqual(ArtworkPolicy.candidates(for: track, pixels: 320).first?.lastPathComponent, "hqdefault.jpg")
    }
    func testOtherHostsAndSignedMusicURLsStayIntact() {
        for address in ["https://example.com/art=w60-h60", "https://lh3.googleusercontent.com/art=w60-h60?signature=abc"] {
            let track = Track(videoID: "abcdefghijk", title: "Track", artist: "Artist", artworkURL: URL(string: address))
            XCTAssertEqual(ArtworkPolicy.candidates(for: track, pixels: 1024), [track.artworkURL!])
        }
    }
    func testCatalogSelectsLargestCoverEvenWhenOrderChanges() throws {
        let object: [String: Any] = ["playlistPanelVideoRenderer": ["videoId": "abcdefghijk", "title": ["simpleText": "Track"], "thumbnail": ["thumbnails": [["url": "https://example.com/large.jpg", "width": 640, "height": 640], ["url": "https://example.com/tiny.jpg", "width": 60, "height": 60]]]]]
        let tracks = try CatalogParser.tracks(from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(tracks.first?.artworkURL?.lastPathComponent, "large.jpg")
    }
}
