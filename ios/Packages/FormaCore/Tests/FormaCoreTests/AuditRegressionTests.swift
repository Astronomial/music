import Foundation
import XCTest
@testable import FormaCore

final class AuditRegressionTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func song(_ n: Int, artist: String? = nil, genre: String = "House", title: String? = nil) -> Track {
        Track(videoID: String(format: "%011d", n), title: title ?? "Песня \(n)", artist: artist ?? "Артист \(n)", duration: 200, genre: genre)
    }
    func testGenreProfileKeepsSourceBudgetsWhenLikesComeFromOneArtist() throws {
        let likes = (0..<100).map { song($0, artist: "Любимый", genre: "Rock") }
        let imported = (200..<700).map { song($0, genre: "Jazz") }
        var library = Library(); library.merge(likes + imported)
        library.likedIDs = likes.prefix(99).map(\.id)
        library.playlists = [.init(name: "Из Яндекса", trackIDs: imported.map(\.id))]
        var profile = TasteProfile(library: library, now: now)
        XCTAssertEqual(try XCTUnwrap(profile.genres["Rock"]) / (profile.genres["Jazz"] ?? 1), 1, accuracy: 0.001)
        library.likedIDs.append(likes[99].id)
        profile = TasteProfile(library: library, now: now)
        XCTAssertEqual(try XCTUnwrap(profile.genres["Rock"]) / (profile.genres["Jazz"] ?? 1), 7.0 / 3, accuracy: 0.001)
    }
    func testOneBackgroundSaveDoesNotAuthorizeEveryGenericUpload() {
        let seed = song(1), background = song(2, genre: "Ambient", title: "Музыка для сна")
        var generic = song(3, title: "Energetic Music"); generic.directRelatedTo = [seed.id]
        var nearBackground = song(4, genre: "Ambient", title: "Relaxing Music"); nearBackground.directRelatedTo = [background.id]
        var library = Library(); library.merge([seed, background]); library.likedIDs = [seed.id]
        library.playlists = [.init(name: "Фон", trackIDs: [background.id])]
        let result = PulseEngine.rank([generic, nearBackground, background], library: library, now: now)
        XCTAssertFalse(result.contains { $0.id == generic.id })
        XCTAssertTrue(result.contains { $0.id == background.id })
        XCTAssertTrue(result.contains { $0.id == nearBackground.id })
    }
    func testDislikedOnlyGenreCannotSeedPositiveLearningFromAutoplay() {
        let seed = song(1, genre: "Rock"), rejected = song(2, genre: "Jazz"), accidental = song(3, genre: "Jazz"), candidate = song(4, genre: "Jazz")
        var library = Library(); library.merge([seed, rejected, accidental, candidate])
        library.likedIDs = [seed.id]; library.playlists = [.init(name: "Импорт", trackIDs: [rejected.id])]
        library.dislikedIDs = [rejected.id]
        library.events = [.init(trackID: accidental.id, kind: .listen, at: now, seconds: 190, ratio: 0.95)]
        XCTAssertFalse(TasteProfile(library: library, now: now).positiveIDs.contains(accidental.id))
        XCTAssertTrue(PulseEngine.rank([candidate], library: library, now: now).isEmpty)
    }
    func testUnknownGenresDoNotInheritTheOnlyClassifiedLike() throws {
        let likes = (0..<100).map { song($0, genre: $0 == 0 ? "Rock" : "") }
        let imported = (200..<300).map { song($0, genre: "Jazz") }
        var library = Library(); library.merge(likes + imported); library.likedIDs = likes.map(\.id)
        library.playlists = [.init(name: "Импорт", trackIDs: imported.map(\.id))]
        let profile = TasteProfile(library: library, now: now)
        XCTAssertEqual(try XCTUnwrap(profile.genres["Rock"]) / (profile.genres["Jazz"] ?? 1), 0.01 * 7 / 3, accuracy: 0.0001)
    }
    func testCachedUtilityNeighbourRechecksChangedSourceGenre() {
        var background = song(1, genre: "Ambient", title: "Музыка для сна")
        let normal = song(2, genre: "Ambient")
        var neighbour = song(3, genre: "Ambient", title: "Relaxing Music"); neighbour.directRelatedTo = [background.id]
        var library = Library(); library.merge([background, normal, neighbour]); library.likedIDs = [background.id, normal.id]
        let index = PulseEngine.makeIndex([neighbour], library: library)
        let cached = PulseEngine.rank([neighbour], library: library, now: now, index: index)
        XCTAssertEqual(cached.count, 1)
        background.genre = "Rock"; library.tracks[background.id] = background
        XCTAssertNil(PulseEngine.selectCached(cached, library: library, exclude: [], now: now, index: index))
    }
    func testRejectedSavesDoNotIncreaseAutoplayLearningBudget() {
        let saved = (0..<21).map { song($0) }, autoplay = (100..<120).map { song($0) }
        var library = Library(); library.merge(saved + autoplay); library.likedIDs = saved.map(\.id)
        library.dislikedIDs = saved.dropFirst().map(\.id)
        library.events = autoplay.map { .init(trackID: $0.id, kind: .listen, at: now, seconds: 190, ratio: 0.95) }
        let profile = TasteProfile(library: library, now: now)
        let learned = autoplay.reduce(0.0) { $0 + (profile.weights[$1.id] ?? 0) }
        XCTAssertGreaterThan(learned, 0)
        XCTAssertLessThanOrEqual(learned, (profile.weights[saved[0].id] ?? 0) * 0.15 + 0.0001)
    }
}
