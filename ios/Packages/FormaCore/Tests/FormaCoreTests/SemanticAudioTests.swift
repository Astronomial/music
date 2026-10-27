import Foundation
import XCTest
@testable import FormaCore

final class SemanticAudioTests: XCTestCase {
    func testVersionedQuantizedVectorsKeepNeighboursAndRejectInvalidModels() throws {
        let a = (0..<1280).map { sin(Double($0) * 0.17) }
        let b = a.enumerated().map { $0.element * 0.9 + cos(Double($0.offset) * 0.43) * 0.1 }
        let first = try XCTUnwrap(SemanticAudioProfile.pack(a, scores: Array(repeating: 0.01, count: 400), seconds: 12))
        let near = try XCTUnwrap(SemanticAudioProfile.pack(b, scores: Array(repeating: 0.01, count: 400), seconds: 12))
        let far = try XCTUnwrap(SemanticAudioProfile.pack(a.map { -$0 }, scores: Array(repeating: 0.01, count: 400), seconds: 12))
        XCTAssertTrue(first.isValid); XCTAssertLessThan(first.vector.count, 1800)
        XCTAssertGreaterThan(try XCTUnwrap(SemanticAudioProfile.similarity(first, near)), 0.98)
        XCTAssertLessThan(try XCTUnwrap(SemanticAudioProfile.similarity(first, far)), 0.01)
        var invalid = first; invalid.model = "other-model"; XCTAssertFalse(invalid.isValid)
        XCTAssertNil(SemanticAudioProfile.pack(Array(repeating: 0, count: 1280), scores: Array(repeating: 0, count: 400), seconds: 12))
    }
    func testBoundedEffnetPatchesUseRealPCM() throws {
        let pcm = (0..<(16000 * 9)).map { Float(0.15 * sin(2 * Double.pi * 440 * Double($0) / 16000)) }
        let input = try XCTUnwrap(EffnetMel.patches(pcm))
        XCTAssertEqual(input.count, 3); XCTAssertEqual(input.data.count, 3 * 128 * 96)
        XCTAssertTrue(input.data.allSatisfy(\.isFinite)); XCTAssertTrue(input.data.contains { $0 > 0 })
        XCTAssertNil(EffnetMel.patches(pcm, sampleRate: 8000))
        XCTAssertNil(EffnetMel.patches(Array(pcm.prefix(1000))))
    }
}
