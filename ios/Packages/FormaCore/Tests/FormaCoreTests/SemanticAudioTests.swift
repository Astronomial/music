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
        struct Reference: Decodable { let firstMelFrame: [Double] }
        let url = try XCTUnwrap(Bundle.module.url(forResource: "semantic-golden", withExtension: "json"))
        let reference = try JSONDecoder().decode(Reference.self, from: Data(contentsOf: url))
        for i in 0..<96 { XCTAssertEqual(Double(input.data[i]), reference.firstMelFrame[i], accuracy: 0.0001) }
    }
    func testStyleScoresAbstainWhenConflictingAndDoNotTreatRapAsBlatnaya() throws {
        let vector = (0..<1280).map { sin(Double($0)) }
        func profile(_ name: String, second: String? = nil) throws -> SemanticAudioProfile {
            var scores = Array(repeating: 0.01, count: 400)
            scores[try XCTUnwrap(SemanticAudioProfile.styleNames.firstIndex(of: name))] = 0.9
            if let second { scores[try XCTUnwrap(SemanticAudioProfile.styleNames.firstIndex(of: second))] = 0.85 }
            return try XCTUnwrap(SemanticAudioProfile.pack(vector, scores: scores, seconds: 12))
        }
        XCTAssertEqual(try profile("Children's---Nursery Rhymes").inferredGenres, ["Children's Music"])
        XCTAssertEqual(try profile("Pop---Chanson").inferredGenres, ["Chanson"])
        XCTAssertEqual(try profile("Hip Hop---Gangsta").inferredGenres, ["Hip-Hop/Rap"])
        XCTAssertTrue(try profile("Pop---Chanson", second: "Rock---Alternative Rock").inferredGenres.isEmpty)
    }
    func testSparseOldRecordingCannotEraseSemanticAnalysis() throws {
        let pcm = (0..<(16000 * 9)).map { Float(0.15 * sin(2 * Double.pi * 440 * Double($0) / 16000)) }
        var profile = try XCTUnwrap(SoundProfile.analyze(pcm))
        profile.semantic = try XCTUnwrap(SemanticAudioProfile.pack((0..<1280).map { sin(Double($0)) }, scores: Array(repeating: 0.01, count: 400), seconds: 9))
        var track = Track(videoID: "00000000001", title: "Audio", artist: "Artist"); track.soundProfile = profile
        var library = Library(); library.merge([track]); track.soundProfile?.semantic = nil; library.merge([track])
        XCTAssertEqual(library.tracks[track.id]?.soundProfile?.semantic, profile.semantic)
    }
    func testNeuralContradictionCannotHideBehindPopMetadataAndRelatedVideo() throws {
        let pcm = (0..<(16000 * 9)).map { Float(0.15 * sin(2 * Double.pi * 440 * Double($0) / 16000)) }
        var first = try XCTUnwrap(SoundProfile.analyze(pcm)), other = first
        let vector = (0..<1280).map { sin(Double($0)) }
        first.semantic = try XCTUnwrap(SemanticAudioProfile.pack(vector, scores: Array(repeating: 0.01, count: 400), seconds: 9))
        other.semantic = try XCTUnwrap(SemanticAudioProfile.pack(vector.map { -$0 }, scores: Array(repeating: 0.01, count: 400), seconds: 9))
        var seed = Track(videoID: "00000000001", title: "Saved", artist: "Saved", genre: "Pop"); seed.soundProfile = first
        var candidate = Track(videoID: "00000000002", title: "Other", artist: "Other", relatedTo: [seed.id], directRelatedTo: [seed.id], genre: "Pop"); candidate.soundProfile = other
        var library = Library(); library.merge([seed]); library.likedIDs = [seed.id]
        XCTAssertTrue(PulseEngine.rank([candidate], library: library, now: Date(timeIntervalSince1970: 1_800_000_000)).isEmpty)
    }
    func testLegacySyncRoundTripPreservesCompletedNeuralAnalysisAndPolicyVersion() throws {
        let pcm = (0..<(16000 * 9)).map { Float(0.15 * sin(2 * Double.pi * 440 * Double($0) / 16000)) }
        var profile = try XCTUnwrap(SoundProfile.analyze(pcm))
        profile.semantic = try XCTUnwrap(SemanticAudioProfile.pack((0..<1280).map { sin(Double($0)) }, scores: Array(repeating: 0.01, count: 400), seconds: 9))
        var track = Track(videoID: "00000000001", title: "Audio", artist: "Artist"); track.soundProfile = profile
        var local = Library(); local.merge([track]); local.settings.tastePolicyVersion = 1
        var legacy = local; legacy.tracks[track.id]?.soundProfile?.semantic = nil; legacy.settings.tastePolicyVersion = 0
        let restored = LibrarySync.preservingLearning(in: legacy, from: local)
        XCTAssertEqual(restored.tracks[track.id]?.soundProfile?.semantic, profile.semantic)
        XCTAssertEqual(restored.settings.tastePolicyVersion, 1)
    }

}
