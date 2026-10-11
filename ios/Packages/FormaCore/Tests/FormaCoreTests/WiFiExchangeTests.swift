import Foundation
import XCTest
@testable import FormaCore
final class WiFiExchangeTests: XCTestCase {
    struct Fixture: Decodable { let pending: WiFiProposal, approved: WiFiProposal; let sent: Library, base: Library }
    func fixture() throws -> Fixture { let u = try XCTUnwrap(Bundle.module.url(forResource: "wifi-proposal", withExtension: "json")); let d = JSONDecoder(); d.dateDecodingStrategy = .millisecondsSince1970; return try d.decode(Fixture.self, from: Data(contentsOf: u)) }
    func checkpoint(_ f: Fixture) throws -> WiFiCheckpoint {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .millisecondsSince1970
        let initial = WiFiCheckpoint(peerID: "paired-PC", sent: f.sent, base: f.base)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(initial)) as? [String: Any]); json["id"] = f.pending.id
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .millisecondsSince1970
        return try decoder.decode(WiFiCheckpoint.self, from: JSONSerialization.data(withJSONObject: json))
    }
    func testPreviewFromPCDescribesBothDirectionsAndCannotApply() throws {
        let f = try fixture(), c = try checkpoint(f)
        XCTAssertEqual(f.pending.protocolVersion, 2); XCTAssertEqual(f.pending.status, .pending)
        XCTAssertEqual(f.pending.summary.toPC.dislikesAdded, 1); XCTAssertEqual(f.pending.summary.toPC.likesRemoved, 1)
        XCTAssertEqual(f.pending.summary.toPhone.likesAdded, 1); XCTAssertNil(f.pending.library)
        XCTAssertThrowsError(try c.mergingApproved(f.pending, into: f.sent))
        XCTAssertNoThrow(try f.pending.validated(expectedID: c.id))
    }
    func testApprovedExchangePreservesPhoneEditsMadeAfterPreview() throws {
        let f = try fixture(), c = try checkpoint(f); var current = f.sent
        current.merge([Track(videoID: "12345678901", title: "Later", artist: "New")]); current.likedIDs.append("12345678901")
        current.settings.mood = "focus"
        let result = try c.mergingApproved(f.approved, into: current)
        XCTAssertEqual(result.dislikedIDs, ["abcdefghijk"]); XCTAssertTrue(result.likedIDs.contains("lmnopqrstuv")); XCTAssertTrue(result.likedIDs.contains("12345678901")); XCTAssertFalse(result.likedIDs.contains("abcdefghijk"))
        XCTAssertEqual(result.settings.mood, "focus"); XCTAssertEqual(result.playlists.first?.name, "Музыка 🎵")
    }
    func testCheckpointSurvivesRestartAndRejectsAnotherProposal() throws {
        let f = try fixture(); var c = try checkpoint(f); c.applied = true
        let saved = try JSONEncoder().encode(c), restored = try JSONDecoder().decode(WiFiCheckpoint.self, from: saved)
        XCTAssertTrue(restored.applied); XCTAssertEqual(restored.id, f.pending.id); XCTAssertEqual(restored.peerID, "paired-PC")
        XCTAssertThrowsError(try f.approved.validated(expectedID: UUID().uuidString))
    }
}
