import Foundation

/// An explicit library is the durable taste signal. It is never truncated to the
/// first N recordings/artists, and a duplicated playlist membership is not a vote.
public struct TasteProfile: Sendable {
    public struct Artist: Sendable { public let name: String; public var weight: Double; public var recordings: Int }
    public let explicitIDs: Set<String>
    public let likedIDs: Set<String>
    public let weights: [String: Double]
    public let artists: [String: Artist]
    public let genres: [String: Double]
    public let positiveIDs: Set<String>
    public let negativeArtists: [String: Double]
    public let negativeGenres: [String: Double]
    public let missingIDs: Set<String>
    public let confirmedGenreCount: Int
    public let likesLead: Bool
    public let allowsUtility: Bool
    let utilityIDs: Set<String>
    let artistStrength: [String: Double]
    let genreStrength: [String: Double]
    let maxSeedWeight: Double
    public let soundSeeds: [Track]
    public let seeds: [Track]
    public var artistNames: [String] {
        var seen = Set<String>()
        return artists.values.sorted { $0.weight == $1.weight ? $0.name < $1.name : $0.weight > $1.weight }.map(\.name).filter { seen.insert($0).inserted }
    }

    public init(library: Library, now: Date = Date()) {
        let playlists = library.playlists.filter { library.settings.playlistSource != "selected" || library.settings.seedPlaylistIDs.contains($0.id) }
        let likes = Set(library.likedIDs), playlistIDs = Set(playlists.flatMap(\.trackIDs))
        let explicit = likes.union(playlistIDs)
        explicitIDs = explicit; likedIDs = likes; likesLead = likes.count >= 100
        missingIDs = explicit.filter { library.tracks[$0] == nil }
        var values: [String: Double] = [:], implicit: [String: Double] = [:]
        // Equal source budgets until 100 likes; then 70% likes / 30% playlists.
        // A large imported playlist must not drown out a smaller liked collection.
        let likeShare = playlistIDs.isEmpty ? 1.0 : likes.isEmpty ? 0 : likesLead ? 0.7 : 0.5
        let playlistShare = likes.isEmpty ? 1.0 : playlistIDs.isEmpty ? 0 : 1 - likeShare
        let scale = Double(max(1, explicit.count)) * 5
        for id in explicit {
            values[id] = (likes.contains(id) ? likeShare / Double(max(1, likes.count)) : 0) * scale
                + (playlistIDs.contains(id) ? playlistShare / Double(max(1, playlistIDs.count)) : 0) * scale
        }
        let rejected = Set(library.dislikedIDs + library.hiddenIDs)
        let activeExplicit = explicit.filter { id in
            !rejected.contains(id) && library.tracks[id].map { !PulseDiversity.blocked($0, settings: library.settings) } == true
        }
        let savedGenres = Array(Set(activeExplicit.compactMap { library.tracks[$0] }.flatMap(GenreClassifier.genres)))
        for event in library.events where event.at <= now {
            guard let track = library.tracks[event.trackID] else { continue }
            let age = now.timeIntervalSince(event.at), decay = pow(0.5, age / (30 * 86400))
            if event.kind == .listen, let reward = event.reward, reward >= 0.7, !RecordingQuality.utility(track) || explicit.contains(track.id) {
                let actual = GenreClassifier.genres(track)
                // A stray autoplay completion cannot introduce an unrelated genre
                // over an established explicit library. A new save can do that.
                if !explicit.contains(track.id), !savedGenres.isEmpty, !actual.isEmpty, GenreClassifier.relation(actual, savedGenres) == 0 { continue }
                implicit[event.trackID, default: 0] += (reward == 1 ? 1.5 : 0.5) * decay
            } else if event.kind == .skip, let reward = event.reward {
                implicit[event.trackID, default: 0] -= (reward == 0 ? 2.5 : 0.8) * decay * (library.settings.skipSensitivity == "soft" ? 0.35 : 1)
            }
        }
        for (id, weight) in implicit { values[id, default: 0] += min(3, max(-7, weight)) }
        if !explicit.isEmpty {
            let learned = values.filter { !explicit.contains($0.key) && $0.value > 0 }
            let mass = learned.values.reduce(0, +)
            let budget = values.filter { activeExplicit.contains($0.key) && $0.value > 0 }.values.reduce(0, +) * 0.15
            if mass > budget { for (id, weight) in learned { values[id] = weight * budget / max(1, mass) } }
        }
        for id in library.dislikedIDs + library.hiddenIDs { values[id] = -10 }
        weights = values
        let valid = values.filter { id, w in w > 0 && library.tracks[id].map { !PulseDiversity.blocked($0, settings: library.settings) } == true }
        positiveIDs = Set(valid.keys)
        var artistWeights: [String: Artist] = [:], genreWeights: [String: Double] = [:], negativeArtists: [String: Double] = [:], negativeGenres: [String: Double] = [:]
        var groups: [String: [Track]] = [:]
        for id in valid.keys.sorted() {
            guard let track = library.tracks[id] else { continue }
            let names = PulseDiversity.artists(track).filter { !$0.hasPrefix("unknown:") }
            for name in names {
                let old = artistWeights[name] ?? Artist(name: track.artist, weight: 0, recordings: 0)
                artistWeights[name] = Artist(name: old.name, weight: old.weight + (valid[id] ?? 0), recordings: old.recordings + 1)
            }
            let group = names.sorted().first ?? "unknown:\(id)"
            groups[group, default: []].append(track)
        }
        // Balance artists WITHIN each source, then restore that source's mass.
        // Otherwise 100 likes of one artist lose 90% of their genre vote while
        // an imported playlist of different artists keeps its entire vote.
        // Unknown genres stay in the denominator: one labelled song must not
        // imply that every unclassified recording has the same genre.
        var sourceGenres = Array(repeating: [String: Double](), count: 3)
        var balancedMass = Array(repeating: 0.0, count: 3), sourceMass = balancedMass
        for (id, weight) in valid {
            guard let track = library.tracks[id] else { continue }
            let denominator = max(1, PulseDiversity.artists(track).compactMap { artistWeights[$0]?.recordings }.max() ?? 1)
            let balance = 1 / sqrt(Double(denominator)), genres = GenreClassifier.genres(track)
            let liked = likes.contains(id) ? likeShare / Double(max(1, likes.count)) : 0
            let imported = playlistIDs.contains(id) ? playlistShare / Double(max(1, playlistIDs.count)) : 0
            let total = liked + imported
            let portions = total > 0 ? [liked / total, imported / total, 0] : [0, 0, 1]
            for source in 0..<3 where portions[source] > 0 {
                let mass = weight * portions[source]
                sourceMass[source] += mass; balancedMass[source] += mass * balance
                for genre in genres { sourceGenres[source][genre, default: 0] += mass * balance / Double(genres.count) }
            }
        }
        for source in 0..<3 where balancedMass[source] > 0 {
            for (genre, mass) in sourceGenres[source] {
                genreWeights[genre, default: 0] += mass * sourceMass[source] / balancedMass[source]
            }
        }
        for (id, weight) in values where weight < 0 {
            guard let track = library.tracks[id] else { continue }
            for name in PulseDiversity.artists(track) { negativeArtists[name, default: 0] += min(5, -weight) }
            for genre in GenreClassifier.genres(track) { negativeGenres[genre, default: 0] += min(3, -weight) }
        }
        artists = artistWeights; genres = genreWeights
        let average = artistWeights.mapValues { $0.weight / Double(max(1, $0.recordings)) }
        let topArtist = max(1, average.values.max() ?? 1), topGenre = max(1, genreWeights.values.max() ?? 1)
        artistStrength = average.mapValues { $0 / topArtist }
        genreStrength = genreWeights.mapValues { sqrt($0 / topGenre) }
        maxSeedWeight = max(1, values.values.max() ?? 5)
        self.negativeArtists = negativeArtists; self.negativeGenres = negativeGenres
        confirmedGenreCount = activeExplicit.compactMap { library.tracks[$0] }.filter { !GenreClassifier.genres($0).isEmpty }.count
        utilityIDs = Set(activeExplicit.intersection(positiveIDs).filter { library.tracks[$0].map(RecordingQuality.utility) == true })
        allowsUtility = !utilityIDs.isEmpty
        var ordered: [Track] = []
        let order = groups.keys.sorted { a, b in
            let x = artistWeights[a]?.weight ?? 0, y = artistWeights[b]?.weight ?? 0
            return x == y ? a < b : x > y
        }
        let maxCount = groups.values.map(\.count).max() ?? 0
        for round in 0..<maxCount { for key in order { if let group = groups[key], round < group.count { ordered.append(group[round]) } } }
        seeds = ordered
        // Actual audio descriptors are optional. Bound comparison work while
        // covering artists/styles, rather than the first twelve dictionary entries.
        soundSeeds = Array(ordered.filter { $0.soundProfile?.isValid == true }.prefix(24))
    }
}
