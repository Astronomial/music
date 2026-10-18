import Foundation
import XCTest
@testable import FormaCore

final class TasteDiscoveryTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func song(_ i: Int, artist: String? = nil, genre: String = "Rock") -> Track {
        Track(videoID: String(format: "%011d", i), title: "Песня \(i)", artist: artist ?? "Артист \(i)", duration: 200, genre: genre)
    }
    func testEqualSourcesAndAutomaticHundredLikeThreshold() throws {
        let tracks = (0..<700).map { song($0) }
        var library = Library(); library.merge(tracks)
        library.likedIDs = tracks.prefix(99).map(\.id)
        library.playlists = [.init(name: "Из Яндекса", trackIDs: tracks[200..<700].map(\.id))]
        var profile = TasteProfile(library: library, now: now)
        func total(_ ids: [String], _ profile: TasteProfile) -> Double { ids.reduce(0) { $0 + (profile.weights[$1] ?? 0) } }
        XCTAssertFalse(profile.likesLead)
        XCTAssertEqual(total(library.likedIDs, profile), total(library.playlists[0].trackIDs, profile), accuracy: 0.001)
        library.likedIDs.append(tracks[99].id)
        profile = TasteProfile(library: library, now: now)
        XCTAssertTrue(profile.likesLead)
        XCTAssertEqual(total(library.likedIDs, profile) / total(library.playlists[0].trackIDs, profile), 7.0 / 3, accuracy: 0.001)
        let before = profile.weights
        library.playlists.append(library.playlists[0])
        XCTAssertEqual(TasteProfile(library: library, now: now).weights, before, "Duplicated playlist membership is not another preference vote")
    }
    func testPriorityActuallyChangesCandidateScoresNotJustTheLabel() throws {
        let likes = (0..<100).map { song($0, genre: "Rock") }
        let imported = (200..<300).map { song($0, genre: "Jazz") }
        var library = Library(); library.merge(likes + imported)
        library.likedIDs = likes.prefix(99).map(\.id)
        library.playlists = [.init(name: "Импорт", trackIDs: imported.prefix(99).map(\.id))]
        library.settings.artistDiversity = 0; library.settings.languagePreference = "any"
        let rock = song(1000, artist: likes[0].artist), jazz = song(1001, artist: imported[0].artist, genre: "Jazz")
        var result = PulseEngine.rank([rock, jazz], library: library, now: now)
        XCTAssertEqual(try XCTUnwrap(result.first { $0.id == rock.id }?.score), try XCTUnwrap(result.first { $0.id == jazz.id }?.score), accuracy: 0.001)
        library.likedIDs = likes.map(\.id)
        result = PulseEngine.rank([rock, jazz], library: library, now: now)
        XCTAssertGreaterThan(try XCTUnwrap(result.first { $0.id == rock.id }?.score), try XCTUnwrap(result.first { $0.id == jazz.id }?.score))
    }
    func testWholeImportedLibraryAndMinorityArtistsParticipate() {
        let tracks = (0..<170).map { song($0, genre: $0 == 169 ? "Jazz" : "Rock") }
        var library = Library(); library.merge(tracks)
        library.playlists = [.init(name: "Яндекс", trackIDs: tracks.map(\.id))]
        let profile = TasteProfile(library: library, now: now)
        XCTAssertEqual(profile.seeds.count, 170); XCTAssertEqual(profile.artists.count, 170)
        XCTAssertGreaterThan(profile.genres["Jazz"] ?? 0, 0)
        let candidate = song(1000, artist: tracks[169].artist, genre: "Jazz")
        XCTAssertEqual(PulseEngine.rank([candidate], library: library, now: now).first?.id, candidate.id)
        var planner = DiscoveryPlanner(), visited = Set<String>()
        for i in 0..<60 {
            for request in planner.plan(library: library, limit: 8, now: now.addingTimeInterval(Double(i) * 10)) {
                if request.kind == .related { visited.insert(request.seed.id) }
                planner.complete(request, page: .init(tracks: []), now: now.addingTimeInterval(Double(i) * 10))
            }
        }
        XCTAssertEqual(visited, Set(tracks.map(\.id)), "Retrieval must rotate beyond the first 12 favourite tracks")
    }
    func testPaginationPersistenceExhaustionAndFailureBackoff() throws {
        var library = Library(); let seed = song(1); library.merge([seed]); library.likedIDs = [seed.id]
        var planner = DiscoveryPlanner()
        let first = try XCTUnwrap(planner.plan(library: library, limit: 1, now: now).first)
        planner.complete(first, page: .init(tracks: [song(2)], continuation: "page-2"), now: now)
        planner = try JSONDecoder().decode(DiscoveryPlanner.self, from: JSONEncoder().encode(planner))
        let batch = planner.plan(library: library, limit: 6, now: now.addingTimeInterval(3))
        let next = try XCTUnwrap(batch.first { $0.key == first.key })
        XCTAssertEqual(next.continuation, "page-2")
        planner.complete(next, page: .init(tracks: [song(3)], continuation: "page-2"), now: now.addingTimeInterval(3))
        XCTAssertFalse(planner.plan(library: library, now: now.addingTimeInterval(40)).contains { $0.key == first.key }, "A repeated cursor must not loop forever")
        let retry = try XCTUnwrap(planner.plan(library: library, limit: 6, now: now.addingTimeInterval(1900)).first { $0.key == first.key })
        XCTAssertNil(retry.continuation)
        planner.complete(retry, page: nil, now: now.addingTimeInterval(1900))
        XCTAssertFalse(planner.plan(library: library, now: now.addingTimeInterval(1901)).contains { $0.key == first.key })
        XCTAssertEqual(planner.successfulPages, 2)
    }
    func testOnlyRecognizedContinuationCommandsAreUsed() throws {
        let fixture = #"{"trackingParams":"not-a-cursor","menu":{"continuationCommand":{"token":"ignore"}},"contents":[{"continuationItemRenderer":{"continuationEndpoint":{"continuationCommand":{"token":"actual-page"}}}}]}"#
        XCTAssertEqual(try CatalogContinuation.token(from: Data(fixture.utf8)), "actual-page")
        XCTAssertNil(try CatalogContinuation.token(from: Data(#"{"unknown":{"token":"invented"}}"#.utf8)))
        XCTAssertEqual(try CatalogContinuation.token(from: Data(#"{"continuations":[{"nextContinuationData":{"continuation":"music-page"}}]}"#.utf8)), "music-page")
    }
    func testCachePreservesSavedAndFreshDiscoveriesOverAlphabeticIDs() {
        let tracks = (0..<20).map { song($0) }; var library = Library(); library.merge(tracks)
        library.likedIDs = [tracks[0].id]; library.playlists = [.init(name: "Import", trackIDs: [tracks[1].id])]
        let seen = Dictionary(uniqueKeysWithValues: tracks.map { ($0.id, now.addingTimeInterval(-Double(Int($0.id)!))) })
        DiscoveryCache.trim(&library, seen: seen, protected: [tracks[19].id], limit: 6)
        XCTAssertEqual(Set(library.tracks.keys), Set([0,1,2,3,4,19].map { tracks[$0].id }))
    }
    func testLongPulseContinuesThroughNewRemotePagesWithoutRepeatingRecordings() throws {
        let saved = (0..<80).map { song($0) }
        var library = Library(); library.merge(saved); library.likedIDs = saved.map(\.id)
        library.settings.repeatHours = 24; library.settings.artistDiversity = 0.8
        var planner = DiscoveryPlanner(), heard = Set<String>(), nextID = 1000, pages = 0, discoveries = 0
        for step in 0..<180 {
            let time = now.addingTimeInterval(Double(step) * 210)
            if step % 6 == 0 {
                for request in planner.plan(library: library, limit: 2, now: time) {
                    let fresh = (nextID..<(nextID + 10)).map { i -> Track in
                        var track = song(i); track.relatedTo = [request.seed.id]; track.directRelatedTo = [request.seed.id]; return track
                    }
                    nextID += 10; pages += 1; library.merge(fresh)
                    planner.complete(request, page: .init(tracks: fresh, continuation: "\(pages)"), now: time)
                }
            }
            let ranked = PulseEngine.rank(Array(library.tracks.values), library: library, limit: 12, exclude: heard, now: time)
            let choice = try XCTUnwrap(ranked.first, "Pulse stopped after \(step) choices despite available discovery pages")
            XCTAssertTrue(heard.insert(choice.id).inserted)
            if !choice.known { discoveries += 1 }
            library.record(.init(trackID: choice.id, kind: .play, at: time, seconds: 0, ratio: 0, newArtist: choice.newArtist))
            // Repeated playback is not the same as an explicit save or a completion.
            DiscoveryCache.trim(&library, seen: [:], protected: heard, limit: 400)
        }
        XCTAssertGreaterThan(pages, 20); XCTAssertGreaterThanOrEqual(discoveries, 120)
    }
}
