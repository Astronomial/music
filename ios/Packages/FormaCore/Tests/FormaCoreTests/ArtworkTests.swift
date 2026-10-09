import Foundation
import XCTest
@testable import FormaCore

final class ArtworkTests: XCTestCase {
    func testMusicCoverUpsizesBeforeOriginalWithoutChangingIdentity() {
        let track = Track(videoID: "abcdefghijk", title: "Track", artist: "Artist", artworkURL: URL(string: "https://lh3.googleusercontent.com/album=w60-h60-l90-rj"))
        let urls = ArtworkPolicy.candidates(for: track, pixels: 1024)
        XCTAssertEqual(urls.first?.absoluteString, "https://lh3.googleusercontent.com/album=w1024-h1024-l90-rj")
        XCTAssertEqual(urls[1], track.artworkURL)
        XCTAssertTrue(urls.contains { $0.lastPathComponent == "maxresdefault.jpg" })
    }
    func testLargeVideoCoverHasFallbacksAndRowsAvoidMaxres() {
        let track = Track(videoID: "abcdefghijk", title: "Track", artist: "Artist", artworkURL: URL(string: "https://i.ytimg.com/vi/abcdefghijk/default.jpg"))
        XCTAssertEqual(ArtworkPolicy.candidates(for: track, pixels: 1024).prefix(4).map(\.lastPathComponent), ["maxresdefault.jpg", "hq720.jpg", "sddefault.jpg", "hqdefault.jpg"])
        XCTAssertEqual(ArtworkPolicy.candidates(for: track, pixels: 320).first?.lastPathComponent, "hqdefault.jpg")
    }
    func testOtherHostsAndSignedMusicURLsStayIntact() {
        for address in ["https://example.com/art=w60-h60", "https://lh3.googleusercontent.com/art=w60-h60?signature=abc"] {
            let track = Track(videoID: "abcdefghijk", title: "Track", artist: "Artist", artworkURL: URL(string: address))
            let urls = ArtworkPolicy.candidates(for: track, pixels: 1024)
            XCTAssertEqual(urls.first, track.artworkURL)
            XCTAssertFalse(urls.contains { $0.absoluteString.contains("signature=abc") && $0 != track.artworkURL })
        }
    }
    func testTinyThumbnailsAreNeverStretchedIntoTheLargePlayer() {
        XCTAssertFalse(ArtworkPolicy.accepts(width: 120, height: 90, requestedPixels: 1024))
        XCTAssertFalse(ArtworkPolicy.accepts(width: 480, height: 360, requestedPixels: 1024))
        XCTAssertTrue(ArtworkPolicy.accepts(width: 1280, height: 720, requestedPixels: 1024))
        XCTAssertTrue(ArtworkPolicy.accepts(width: 640, height: 480, requestedPixels: 1024))
        XCTAssertFalse(ArtworkPolicy.accepts(width: 60, height: 60, requestedPixels: 320))
    }
    func testCatalogSelectsLargestCoverEvenWhenOrderChanges() throws {
        let object: [String: Any] = ["playlistPanelVideoRenderer": ["videoId": "abcdefghijk", "title": ["simpleText": "Track"], "thumbnail": ["thumbnails": [["url": "https://example.com/large.jpg", "width": 640, "height": 640], ["url": "https://example.com/tiny.jpg", "width": 60, "height": 60]]]]]
        let tracks = try CatalogParser.tracks(from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(tracks.first?.artworkURL?.lastPathComponent, "large.jpg")
    }
}
