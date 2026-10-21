import Foundation

public struct DiscoveryRequest: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable { case related, artist, search }
    public var kind: Kind
    public var seed: Track
    public var query: String
    public var continuation: String?
    public var roots: [String]
    public var mood: String?
    public var key: String { kind.rawValue + ":" + (kind == .search ? query : seed.id) }
    public init(kind: Kind, seed: Track, query: String = "", continuation: String? = nil, roots: [String] = [], mood: String? = nil) {
        self.kind = kind; self.seed = seed; self.query = query; self.continuation = continuation; self.roots = roots; self.mood = mood
    }
}
public struct DiscoveryPage: Sendable {
    public let tracks: [Track]
    public let continuation: String?
    public init(tracks: [Track], continuation: String? = nil) { self.tracks = tracks; self.continuation = continuation }
}

/// Finite per-device cache, unbounded *remote* discovery: rotate every positive
/// recording, page each source, and revisit exhausted sources after a cooldown.
public struct DiscoveryPlanner: Codable, Sendable {
    private struct Progress: Codable, Sendable {
        var cursor: String?; var pages = 0; var attempted = Date.distantPast
        var retryAt = Date.distantPast; var failures = 0
    }
    private var progress: [String: Progress] = [:]
    public private(set) var successfulPages = 0
    public private(set) var receivedRecordings = 0
    public init() {}
    public mutating func plan(library: Library, discoveries: [Track] = [], limit: Int = 8, now: Date = Date(), mood: String? = nil, underfilledMoods: [String] = []) -> [DiscoveryRequest] {
        let profile = TasteProfile(library: library, now: now)
        var jobs: [DiscoveryRequest] = profile.seeds.map { DiscoveryRequest(kind: .related, seed: $0, roots: [$0.id]) }
        var artists = Set<String>()
        for seed in profile.seeds where artists.insert(GenreClassifier.artistIdentity(seed.artist)).inserted && !seed.artist.isEmpty && seed.artist != "Исполнитель не указан" {
            jobs.append(DiscoveryRequest(kind: .artist, seed: seed, roots: [seed.id]))
        }
        let explicit = profile.explicitIDs
        var bridgeArtists = Set<String>()
        for track in discoveries where !explicit.contains(track.id) && bridgeArtists.insert(GenreClassifier.artistIdentity(track.artist)).inserted && !Set(track.directRelatedTo).isDisjoint(with: explicit) && !RecordingQuality.utility(track) {
            jobs.append(DiscoveryRequest(kind: .related, seed: track, roots: Array(Set(track.directRelatedTo).intersection(explicit))))
        }
        // Searches stay tied to an artist/recording, never "energetic music".
        // This also recovers radios with no usable continuation response.
        for seed in profile.seeds.prefix(80) where !seed.artist.isEmpty && seed.artist != "Исполнитель не указан" {
            jobs.append(DiscoveryRequest(kind: .search, seed: seed, query: seed.artist, roots: [seed.id]))
        }
        var moodJobs: [DiscoveryRequest] = []
        let moodIDs = mood.map({ [$0] }) ?? underfilledMoods
        let scores = moodIDs.isEmpty ? [:] : library.tracks.mapValues(MoodFitness.scores)
        for id in moodIDs {
            let matching = library.tracks.values.filter { (scores[$0.id]?[id] ?? 0) > 0 && !PulseDiversity.blocked($0, settings: library.settings) && !library.dislikedIDs.contains($0.id) && !library.hiddenIDs.contains($0.id) && (!RecordingQuality.utility($0) || profile.explicitIDs.contains($0.id)) }.sorted { $0.id < $1.id }
            for seed in matching { moodJobs.append(DiscoveryRequest(kind: .related, seed: seed, roots: [seed.id], mood: id)) }
            let names = Set(profile.seeds.map { PulseEngine.fold($0.artist) })
            // These exact-recording queries recover sparse shelves without
            // turning a phrase such as "happy music" into training evidence.
            for query in MoodFitness.seedQueries(id, artists: names, genres: Array(profile.genres.keys), offset: 0, limit: 200) {
                if let seed = profile.seeds.first ?? matching.first { moodJobs.append(DiscoveryRequest(kind: .search, seed: seed, query: query, mood: id)) }
            }
        }
        let validMoods = Set(moodJobs.map(\.key))
        jobs += moodJobs
        jobs = jobs.filter { (progress[$0.key]?.retryAt ?? .distantPast) <= now }
        jobs.sort { a, b in
            let x = progress[a.key] ?? Progress(), y = progress[b.key] ?? Progress()
            // Fairness across the entire explicit library, including tracks beyond
            // the old 12-seed window. Continuations compete with unvisited seeds.
            if x.attempted != y.attempted { return x.attempted < y.attempted }
            let ap = explicit.contains(a.seed.id) ? 0 : 1, bp = explicit.contains(b.seed.id) ? 0 : 1
            if ap != bp { return ap < bp }
            if a.kind != b.kind { return a.kind == .related || (a.kind == .artist && b.kind == .search) }
            let aw = profile.weights[a.seed.id] ?? 0, bw = profile.weights[b.seed.id] ?? 0
            return aw == bw ? a.key < b.key : aw > bw
        }
        if limit >= 4 {
            // Reserve room for deeper pages and an alternate retrieval route;
            // otherwise 500 unvisited seeds could starve every continuation.
            let continuing = Array(jobs.filter { progress[$0.key]?.cursor != nil }.prefix(max(1, limit / 5)))
            let alternate = Array(jobs.filter { $0.kind == .artist }.prefix(1))
            let recent = Set(library.events.reversed().filter { $0.at <= now && now.timeIntervalSince($0.at) < 7 * 86400 && ($0.reward ?? 0) >= 0.7 }.prefix(4).map(\.trackID))
            let heard = Array(jobs.filter { $0.kind == .artist && recent.contains($0.seed.id) }.prefix(2))
            let moodCount = mood == nil ? min(limit - 2, max(3, limit * 2 / 3)) : max(2, limit / 2)
            var shelves: [DiscoveryRequest] = [], seenMoods = Set<String>()
            for job in jobs where validMoods.contains(job.key) {
                if let id = job.mood, seenMoods.insert(id).inserted { shelves.append(job) }
                if shelves.count >= moodCount { break }
            }
            if shelves.count < moodCount { let keys = Set(shelves.map(\.key)); shelves += jobs.filter { validMoods.contains($0.key) && !keys.contains($0.key) }.prefix(moodCount - shelves.count) }
            jobs = shelves + heard + continuing + alternate + jobs
        }
        var chosen: [DiscoveryRequest] = [], pickedArtists: [String: Int] = [:], pickedKeys = Set<String>()
        func fromLikes(_ job: DiscoveryRequest) -> Bool { profile.likedIDs.contains(job.seed.id) || !Set(job.roots).isDisjoint(with: profile.likedIDs) }
        let likeKeys = Set(jobs.filter(fromLikes).map(\.key))
        var unpickedLikes = likeKeys.count, unpickedOthers = Set(jobs.map(\.key)).subtracting(likeKeys).count
        let likeTarget = Int((Double(limit) * (profile.likesLead ? 0.7 : 0.5)).rounded())
        var likedPicked = 0
        for cap in 1...max(1, limit) {
            for var job in jobs where chosen.count < limit && !pickedKeys.contains(job.key) {
                let liked = likeKeys.contains(job.key)
                if liked && likedPicked >= likeTarget && unpickedOthers > 0 { continue }
                if !liked && chosen.count - likedPicked >= limit - likeTarget && unpickedLikes > 0 { continue }
                let artist = GenreClassifier.artistIdentity(job.seed.artist)
                guard (pickedArtists[artist] ?? 0) < cap else { continue }
                var state = progress[job.key] ?? Progress(); job.continuation = state.cursor; state.attempted = now
                // A short lease prevents concurrent callers planning the same page.
                state.retryAt = now.addingTimeInterval(30); progress[job.key] = state
                chosen.append(job); pickedKeys.insert(job.key); pickedArtists[artist, default: 0] += 1
                if liked { likedPicked += 1; unpickedLikes -= 1 } else { unpickedOthers -= 1 }
            }
            if chosen.count >= limit { break }
        }
        if progress.count > 12000 { let keep = Set(jobs.map(\.key)); progress = progress.filter { keep.contains($0.key) } }
        return chosen
    }
    public mutating func complete(_ request: DiscoveryRequest, page: DiscoveryPage?, now: Date = Date()) {
        var state = progress[request.key] ?? Progress(); state.attempted = now
        if let page {
            successfulPages += 1; receivedRecordings += page.tracks.count; state.failures = 0; state.pages += 1
            let cursor = page.continuation.flatMap { $0.isEmpty || $0.count > 20000 || $0 == request.continuation ? nil : $0 }
            state.cursor = cursor
            state.retryAt = now.addingTimeInterval(cursor == nil ? 1800 : 2)
        } else {
            state.failures = min(7, state.failures + 1)
            state.retryAt = now.addingTimeInterval(min(300, 3 * pow(2, Double(state.failures))))
        }
        progress[request.key] = state
    }
}

public enum CatalogContinuation {
    public static func token(from data: Data) throws -> String? {
        let root = try JSONSerialization.jsonObject(with: data)
        func find(_ value: Any, depth: Int) -> String? {
            guard depth < 40 else { return nil }
            if let object = value as? [String: Any] {
                if let command = object["continuationCommand"] as? [String: Any], let token = command["token"] as? String, !token.isEmpty, token.count <= 20000 { return token }
                if let command = object["nextContinuationData"] as? [String: Any], let token = command["continuation"] as? String, !token.isEmpty, token.count <= 20000 { return token }
                for key in object.keys.sorted() where !["trackingParams", "responseContext", "menu"].contains(key) { if let token = find(object[key]!, depth: depth + 1) { return token } }
            } else if let array = value as? [Any] { for item in array { if let token = find(item, depth: depth + 1) { return token } } }
            return nil
        }
        return find(root, depth: 0)
    }
}
