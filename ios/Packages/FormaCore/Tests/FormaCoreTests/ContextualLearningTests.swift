import Foundation
import XCTest
@testable import FormaCore

final class ContextualLearningTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func track(_ number: Int, artist: String? = nil, genre: String = "Pop", language: String = "ru") -> Track {
        Track(videoID: String(format: "%011d", number), title: "Песня \(number)", artist: artist ?? "Artist \(number)", duration: 200, genre: genre, language: language)
    }
    private var snapshot: RecommendationContext {
        .init(features: ContextualLearning.features(taste: 0.6, nearby: 0.7, session: 0.3, newArtist: true, known: false, language: 0.8, context: 0.25, metadata: true), lane: "nearby")
    }
    func testSameModelCoefficientsAndPredictionsAsDesktopForStrictAndSoftFeedback() throws {
        struct Expected: Decodable {
            struct Case: Decodable {
                struct Settings: Decodable { let skipSensitivity: String }
                struct Prediction: Decodable { let features: [Double]; let mean: Double; let correction: Double; let uncertainty: Double; let confidence: Double }
                let settings: Settings; let coefficients: [Double]; let covariance: [[Double]]; let samples: Int; let evidence: Double; let predictions: [Prediction]
            }
            let now: Double; let events: [ListeningEvent]; let cases: [Case]
        }
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .millisecondsSince1970
        let url = try XCTUnwrap(Bundle.module.url(forResource: "pc-context-learning", withExtension: "json"))
        let data = try decoder.decode(Expected.self, from: Data(contentsOf: url))
        for expected in data.cases {
            var library = Library(); library.events = data.events; library.settings.skipSensitivity = expected.settings.skipSensitivity
            let model = ContextualLearning.model(library, now: Date(timeIntervalSince1970: data.now / 1000))
            XCTAssertEqual(model.samples, expected.samples); XCTAssertEqual(model.evidence, expected.evidence, accuracy: 1e-10)
            for i in 0..<10 {
                XCTAssertEqual(model.coefficients[i], expected.coefficients[i], accuracy: 1e-10)
                for j in 0..<10 { XCTAssertEqual(model.covariance[i][j], expected.covariance[i][j], accuracy: 1e-10) }
            }
            for prediction in expected.predictions {
                let actual = ContextualLearning.predict(model, features: prediction.features)
                XCTAssertEqual(actual.mean, prediction.mean, accuracy: 1e-10); XCTAssertEqual(actual.correction, prediction.correction, accuracy: 1e-10)
                XCTAssertEqual(actual.uncertainty, prediction.uncertainty, accuracy: 1e-10); XCTAssertEqual(actual.confidence, prediction.confidence, accuracy: 1e-10)
            }
        }
    }
    func testImpressionsErrorsInstantSkipsAndFutureOutcomesDoNotTrainContext() {
        var library = Library()
        XCTAssertEqual(ContextualLearning.model(library, now: now).samples, 0)
        library.events = [.init(trackID: "abcdefghijk", kind: .play, at: now, seconds: 0, ratio: 0, recommendation: snapshot), .init(trackID: "abcdefghijk", kind: .error, at: now, seconds: 8, ratio: 0, recommendation: snapshot), .init(trackID: "12345678901", kind: .skip, at: now, seconds: 1, ratio: 0.01, recommendation: snapshot), .init(trackID: "abcdefghij2", kind: .like, at: now.addingTimeInterval(1), seconds: 0, ratio: 0, recommendation: snapshot)]
        XCTAssertEqual(ContextualLearning.model(library, now: now).samples, 0)
        library.events = (0..<100).map { .init(trackID: "abcdefghijk", kind: .listen, at: now.addingTimeInterval(-Double($0)), seconds: 190, ratio: 0.95, recommendation: snapshot) }
        XCTAssertEqual(ContextualLearning.model(library, now: now).samples, 1)
        XCTAssertLessThan(ContextualLearning.model(library, now: now.addingTimeInterval(30 * 86400)).confidence, ContextualLearning.model(library, now: now).confidence)
    }
    func testSeventyThirtySurvivesRepeatedSingleTrackSelections() throws {
        var library = Library(); library.settings.artistDiversity = 0; library.settings.repeatHours = 24
        let tracks = (0..<100).map { track($0) }; library.merge(tracks); library.likedIDs = Array(tracks.prefix(40).map(\.id))
        var choices: [Recommendation] = []
        for i in 0..<40 {
            let at = now.addingTimeInterval(Double(i))
            let item = try XCTUnwrap(PulseEngine.rank(tracks, library: library, limit: 1, now: at).first)
            choices.append(item); library.record(.init(trackID: item.id, kind: .play, at: at, seconds: 0, ratio: 0, recommendation: item.exposure, surface: "pulse"))
        }
        XCTAssertEqual(Set(choices.map(\.id)).count, 40)
        XCTAssertGreaterThanOrEqual(choices.filter { !$0.known }.count, 26); XCTAssertLessThanOrEqual(choices.filter { !$0.known }.count, 30)
    }
    func testCachedPlaybackSelectionAlsoMaintainsBalanceWithoutResettingExposure() throws {
        var library = Library(); library.settings.artistDiversity = 0; library.settings.repeatHours = 24
        let tracks = (0..<100).map { track($0) }; library.merge(tracks); library.likedIDs = Array(tracks.prefix(40).map(\.id))
        let cached = PulseEngine.rank(tracks, library: library, limit: 100, now: now)
        var choices: [Recommendation] = []
        for i in 0..<30 {
            let at = now.addingTimeInterval(Double(i))
            let item = try XCTUnwrap(PulseEngine.selectCached(cached, library: library, exclude: [], now: at)); choices.append(item)
            library.record(.init(trackID: item.id, kind: .play, at: at, seconds: 0, ratio: 0, recommendation: item.exposure, surface: "pulse"))
        }
        XCTAssertEqual(Set(choices.map(\.id)).count, 30); XCTAssertGreaterThanOrEqual(choices.filter { !$0.known }.count, 19); XCTAssertLessThanOrEqual(choices.filter { !$0.known }.count, 23)
    }
    func testSkipsThrottleExperimentsAndStrongForeignMatchBeatsWeakRussianSearchHint() throws {
        var library = Library(); let seed = track(1), foreign = track(2, language: "en")
        var weak = track(3, genre: "", language: ""); weak.title = "Latin"; weak.discoveryLanguages = ["ru"]; weak.genres = ["Pop"]
        library.merge([seed, foreign, weak]); library.likedIDs = [seed.id]
        XCTAssertEqual(PulseEngine.rank([weak, foreign], library: library, limit: 1, now: now).first?.id, foreign.id)
        library.events = (0..<3).map { _ in .init(trackID: seed.id, kind: .skip, at: now, seconds: 8, ratio: 0.04, surface: "pulse") }
        XCTAssertEqual(DiscoveryPolicy.history(library, now: now).surpriseRate, 0.03, accuracy: 1e-10)
        weak.language = "en"; weak.title = "Русское название"; XCTAssertEqual(DiscoveryPolicy.languageFit(weak, preference: "ru"), 0)
        weak.language = ""; weak.title = "Latin"; weak.discoveryLanguages = []; XCTAssertEqual(DiscoveryPolicy.languageFit(weak, preference: "en"), 0)
    }
    func testLegacyPCSyncDoesNotErasePhoneTrainingAndHistoryResetStillWorks() throws {
        var local = Library(); let seed = track(1); local.merge([seed]); local.settings.languagePreference = "en"
        local.events = [.init(trackID: seed.id, kind: .play, at: now, seconds: 0, ratio: 0, recommendation: snapshot, surface: "pulse"), .init(trackID: seed.id, kind: .like, at: now.addingTimeInterval(1), seconds: 0, ratio: 0, recommendation: snapshot)]
        var legacy = local; legacy.settings.recommendationVersion = 1; legacy.settings.languagePreference = "ru"
        legacy.events = [.init(trackID: seed.id, kind: .play, at: now, seconds: 0, ratio: 0)]
        let restored = LibrarySync.preservingLearning(in: legacy, from: local)
        XCTAssertEqual(restored.events.count, 2); XCTAssertEqual(restored.events[0].recommendation, snapshot); XCTAssertEqual(restored.events[0].surface, "pulse"); XCTAssertEqual(restored.settings.languagePreference, "en")
        legacy.events = []; XCTAssertTrue(LibrarySync.preservingLearning(in: legacy, from: local).events.isEmpty)
    }
    func testRichMetadataAndContextSurviveDiskEncodingAndOldTracksDecode() throws {
        var library = Library(); var seed = track(1); seed.directRelatedTo = ["abcdefghijk"]; seed.discoveryLanguages = ["ru"]
        library.merge([seed]); library.events = [.init(trackID: seed.id, kind: .playlistAdd, at: now, seconds: 0, ratio: 0, recommendation: snapshot)]
        let restored = try JSONDecoder().decode(Library.self, from: JSONEncoder().encode(library))
        XCTAssertEqual(restored.tracks[seed.id]?.directRelatedTo, seed.directRelatedTo); XCTAssertEqual(restored.events[0].recommendation, snapshot)
        let old = try JSONDecoder().decode(Track.self, from: Data(#"{"videoID":"abcdefghijk","title":"Old","artist":"Artist","genres":[],"moodHints":[],"relatedTo":[]}"#.utf8))
        XCTAssertEqual(old.directRelatedTo, []); XCTAssertEqual(old.language, "")
    }
}
