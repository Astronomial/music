import Foundation

public enum DiscoveryPolicy {
    public struct History: Sendable {
        public var exposureCount: Int = 0
        public var classifiedCount: Int = 0
        public var newTracks: Int = 0
        public var surprises: Int = 0
        public var preferredLanguage: Int = 0
        public var surpriseRate: Double = 0.12
        public var earlySkips: Int = 0
    }
    public static func languageFit(_ track: Track, preference: String) -> Double {
        if preference == "any" { return 0 }
        let code = track.language.lowercased().components(separatedBy: CharacterSet(charactersIn: "-_")).first ?? ""
        if code.count == 2 || ["rus", "eng"].contains(code) { return code == preference || code == (preference == "ru" ? "rus" : "eng") ? 1 : 0 }
        if track.title.range(of: "[іїєґў]", options: [.regularExpression, .caseInsensitive]) != nil { return 0 }
        if track.title.range(of: "[а-яё]", options: [.regularExpression, .caseInsensitive]) != nil { return preference == "ru" ? 0.8 : 0 }
        if track.discoveryLanguages.contains(preference) || (preference == "ru" && track.moodHints.contains("discovery:ru")) { return 0.3 }
        if preference == "ru", track.artist.range(of: "[а-яё]", options: [.regularExpression, .caseInsensitive]) != nil { return 0.2 }
        return 0
    }
    public static func history(_ library: Library, now: Date = Date()) -> History {
        let recent = library.events.filter { now.timeIntervalSince($0.at) >= 0 && now.timeIntervalSince($0.at) < 5400 && ["pulse", "mood"].contains($0.surface ?? "") }
        var result = History()
        for event in recent.filter({ $0.reward != nil }).suffix(6).reversed() {
            if event.kind != .skip || event.seconds >= 30 || event.ratio >= 0.25 { break }
            result.earlySkips += 1
        }
        let base = library.settings.explorationStyle == "adventurous" ? 0.45 : library.settings.explorationStyle == "balanced" ? 0.25 : 0.12
        result.surpriseRate = base / Double(1 + result.earlySkips)
        let plays = recent.filter { $0.kind == .play }.suffix(12)
        result.exposureCount = plays.count
        for event in plays {
            if let snapshot = event.recommendation, snapshot.isValid {
                result.classifiedCount += 1
                if snapshot.lane != "familiar" { result.newTracks += 1 }
                if snapshot.lane == "stretch" { result.surprises += 1 }
            }
            if let track = library.tracks[event.trackID], languageFit(track, preference: library.settings.languagePreference) >= 0.6 { result.preferredLanguage += 1 }
        }
        return result
    }
}

/// Independent artist/genre/seed Beta signals complement the shared context learner.
enum ConsumptionFeedback {
    struct Arm: Sendable { var positive = 0.0; var negative = 0.0 }
    struct Model: Sendable { var global: [String: Arm] = [:]; var moods: [String: Arm] = [:] }
    static func arms(_ track: Track) -> [(String, Double)] {
        [("artist:" + PulseEngine.fold(track.artist), 1.5)] + (track.genre.isEmpty ? track.genres : [track.genre]).map { ("genre:" + PulseEngine.fold($0), 0.6) } + track.relatedTo.prefix(5).map { ("seed:" + $0, 0.8) }
    }
    static func model(_ library: Library, now: Date) -> Model {
        var result = Model(), seen = Set<String>()
        for event in library.events.sorted(by: { $0.at > $1.at }) {
            let age = now.timeIntervalSince(event.at)
            guard age >= 0, age.isFinite, let reward = event.reward, let track = library.tracks[event.trackID] else { continue }
            let key = event.trackID + ":" + String(floor(event.at.timeIntervalSince1970 / 86400))
            guard seen.insert(key).inserted else { continue }
            let weight = pow(0.5, age / (30 * 86400)) * (event.kind == .skip && library.settings.skipSensitivity == "soft" ? 0.35 : 1)
            for (key, _) in arms(track) {
                var arm = result.global[key] ?? Arm(); arm.positive += reward * weight; arm.negative += (1 - reward) * weight; result.global[key] = arm
                if let mood = event.mood, !mood.isEmpty {
                    let contextualKey = mood + ":" + key
                    var contextual = result.moods[contextualKey] ?? Arm(); contextual.positive += reward * weight; contextual.negative += (1 - reward) * weight; result.moods[contextualKey] = contextual
                }
            }
        }
        return result
    }
    static func predict(_ track: Track, model: Model, mood: String?) -> (mean: Double, uncertainty: Double) {
        var mean = 0.0, evidence = 0.0, total = 0.0
        for (key, importance) in arms(track) {
            let g = model.global[key] ?? Arm(), c = model.moods[(mood ?? "") + ":" + key] ?? Arm()
            let positive = g.positive + c.positive, negative = g.negative + c.negative
            mean += importance * (2 + positive) / (4 + positive + negative)
            evidence += importance * (positive + negative); total += importance
        }
        return (total > 0 ? mean / total : 0.5, 1 / sqrt(4 + (total > 0 ? evidence / total : 0)))
    }
}
