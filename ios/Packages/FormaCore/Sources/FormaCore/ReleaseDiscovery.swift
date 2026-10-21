import Foundation

public enum ReleaseDiscovery {
    public static func songPublication(_ track: Track, artist: String) -> Bool {
        let title = " " + PulseEngine.fold(track.title) + " "
        let noise = #"(?:^| )(?:teaser|trailer|snippet|shorts|interview|reaction|podcast|preview|vlog|тизер|трейлер|интервью|превью|подкаст|отрывок|бэкстейдж|сниппет|закулисье)(?: |$)"#
        return GenreClassifier.artistIdentity(track.artist) == GenreClassifier.artistIdentity(artist) && track.duration >= 60 && track.duration <= 1200 && !RecordingQuality.utility(track) && title.range(of: noise, options: .regularExpression) == nil
    }
    public struct Freshness: Sendable { public let score: Double; public let recent: Bool; public let verified: Bool }
    public static func timestamp(_ value: String?) -> Double? {
        guard let value, let date = ISO8601DateFormatter().date(from: value), date.timeIntervalSince1970 > 0 else { return nil }
        return date.timeIntervalSince1970 * 1000
    }
    public static func freshness(_ track: Track, now: Date = Date()) -> Freshness {
        let released = track.genreEvidence?.isValid == true ? track.genreEvidence?.releasedAt : nil
        guard let at = released ?? track.publishedAt, at.isFinite, at > 0, at <= (now.timeIntervalSince1970 + 86400) * 1000 else { return .init(score: 0, recent: false, verified: false) }
        let age = max(0, (now.timeIntervalSince1970 * 1000 - at) / 86400000), recent = age <= 120
        return .init(score: recent ? exp(-age / 60) * (released == nil ? 0.35 : 1) : 0, recent: recent, verified: released != nil)
    }
    public static func recent(_ rows: [GenreClassifier.Recording], artist: String, now: Date = Date(), limit: Int = 3) -> [GenreClassifier.Recording] {
        var groups: [String: (Double, GenreClassifier.Recording)] = [:]
        let name = GenreClassifier.artistIdentity(artist), end = (now.timeIntervalSince1970 + 86400) * 1000
        for row in rows where row.kind == "song" && GenreClassifier.artistIdentity(row.artistName ?? "") == name {
            let key = GenreClassifier.recordingIdentity(row.trackName ?? "")
            guard !key.isEmpty, let at = timestamp(row.releaseDate), at <= end else { continue }
            if at < (groups[key]?.0 ?? .infinity) { groups[key] = (at, row) }
        }
        return Array(groups.values.filter { now.timeIntervalSince1970 * 1000 - $0.0 <= 120 * 86400000 }.sorted { $0.0 == $1.0 ? ($0.1.trackName ?? "") < ($1.1.trackName ?? "") : $0.0 > $1.0 }.prefix(limit)).map(\.1)
    }
    public static func target(_ library: Library, now: Date = Date()) -> Double {
        var positive = 3.0, negative = 2.0, samples = 0, seen = Set<String>()
        for event in library.events.suffix(160).reversed() {
            let age = now.timeIntervalSince(event.at), key = event.trackID + ":" + String(Int(event.at.timeIntervalSince1970 / 86400))
            guard age >= 0, age <= 90 * 86400, ["pulse", "mood"].contains(event.surface ?? ""), let reward = event.reward, let track = library.tracks[event.trackID], !seen.contains(key) else { continue }
            let fresh = freshness(track, now: event.at); guard fresh.recent, fresh.verified else { continue }
            seen.insert(key); samples += 1; let weight = pow(0.5, age / (30 * 86400)); positive += reward * weight; negative += (1 - reward) * weight
        }
        return samples < 3 ? 0.6 : max(0.25, min(0.8, positive / (positive + negative)))
    }
}
