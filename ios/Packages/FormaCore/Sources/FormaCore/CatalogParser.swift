import Foundation

public enum CatalogParser {
    /// Tolerates new wrappers, but accepts only known song/panel renderer shapes.
    public static func tracks(from data: Data, recentFirst: Bool = false) throws -> [Track] {
        guard data.count <= 8 * 1024 * 1024 else { throw ParseError.tooLarge }
        let json = try JSONSerialization.jsonObject(with: data)
        var found: [Track] = [], seen = Set<String>(), ages: [String: Double] = [:]
        func visit(_ value: Any, depth: Int) {
            guard depth < 80, found.count < 200 else { return }
            if let object = value as? [String: Any] {
                if let renderer = object["musicResponsiveListItemRenderer"] as? [String: Any], let track = song(renderer), seen.insert(track.id).inserted { found.append(track) }
                if let renderer = object["videoRenderer"] as? [String: Any], let track = video(renderer), seen.insert(track.id).inserted { found.append(track); ages[track.id] = publicationAgeDays(text(renderer["publishedTimeText"])) }
                if let renderer = object["playlistPanelVideoRenderer"] as? [String: Any], let track = panel(renderer), seen.insert(track.id).inserted { found.append(track) }
                for key in object.keys.sorted() { visit(object[key]!, depth: depth + 1) }
            } else if let array = value as? [Any] { for item in array { visit(item, depth: depth + 1) } }
        }
        visit(json, depth: 0)
        return recentFirst ? found.enumerated().sorted { let a = ages[$0.element.id] ?? .infinity, b = ages[$1.element.id] ?? .infinity; return a == b ? $0.offset < $1.offset : a < b }.map(\.element) : found
    }
    public static func publicationAgeDays(_ text: String) -> Double {
        let text = text.lowercased().replacingOccurrences(of: "ё", with: "е")
        if text.contains("yesterday") || text.contains("вчера") { return 1 }
        if text.contains("just now") || text.contains("только что") { return 0 }
        guard let regex = try? NSRegularExpression(pattern: #"(\d+(?:[.,]\d+)?)\s*(minute|минут|hour|час|day|дн|день|дня|week|недел|month|месяц|year|год|лет)"#), let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)), let nr = Range(match.range(at: 1), in: text), let ur = Range(match.range(at: 2), in: text), let n = Double(text[nr].replacingOccurrences(of: ",", with: ".")) else { return .infinity }
        let unit = String(text[ur])
        if unit.hasPrefix("minute") || unit.hasPrefix("минут") { return n / 1440 }
        if unit.hasPrefix("hour") || unit.hasPrefix("час") { return n / 24 }
        if unit.hasPrefix("week") || unit.hasPrefix("недел") { return n * 7 }
        if unit.hasPrefix("month") || unit.hasPrefix("месяц") { return n * 30 }
        if unit.hasPrefix("year") || unit.hasPrefix("год") || unit.hasPrefix("лет") { return n * 365 }
        return n
    }
    public enum ParseError: Error { case tooLarge }
    static func text(_ object: Any?) -> String {
        guard let object = object as? [String: Any] else { return "" }
        if let simple = object["simpleText"] as? String { return simple }
        return (object["runs"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined()
    }
    static func thumb(_ renderer: [String: Any]) -> URL? {
        var thumbs = (renderer["thumbnail"] as? [String: Any])?["thumbnails"] as? [[String: Any]]
        if thumbs == nil {
            let outer = renderer["thumbnail"] as? [String: Any]
            let inner = outer?["musicThumbnailRenderer"] as? [String: Any]
            thumbs = (inner?["thumbnail"] as? [String: Any])?["thumbnails"] as? [[String: Any]]
        }
        func area(_ image: [String: Any]) -> Double { max(0, (image["width"] as? NSNumber)?.doubleValue ?? 0) * max(0, (image["height"] as? NSNumber)?.doubleValue ?? 0) }
        let best = thumbs?.max { area($0) < area($1) }
        guard let value = best?["url"] as? String, let url = URL(string: value), url.scheme == "https" else { return nil }
        return url
    }
    static func seconds(_ value: String) -> Double {
        let fields = value.split(separator: ":", omittingEmptySubsequences: false)
        let parts = fields.compactMap { Double($0) }
        guard (2...3).contains(fields.count), parts.count == fields.count,
              parts.allSatisfy({ $0.isFinite && $0 >= 0 }), parts.dropFirst().allSatisfy({ $0 < 60 }) else { return 0 }
        return min(86400, parts.reduce(0) { $0 * 60 + $1 })
    }
    static func song(_ renderer: [String: Any]) -> Track? {
        let columns = renderer["flexColumns"] as? [[String: Any]] ?? []
        let texts = columns.map { ($0["musicResponsiveListItemFlexColumnRenderer"] as? [String: Any])?["text"] as? [String: Any] ?? [:] }
        let title = text(texts.first)
        let runs = texts.first?["runs"] as? [[String: Any]] ?? []
        let endpoint = ((runs.first?["navigationEndpoint"] as? [String: Any])?["watchEndpoint"] as? [String: Any])
        let item = renderer["playlistItemData"] as? [String: Any]
        guard let id = (item?["videoId"] ?? endpoint?["videoId"]) as? String, VideoID.isValid(id), !title.isEmpty else { return nil }
        let metadata = texts.dropFirst().flatMap { $0["runs"] as? [[String: Any]] ?? [] }
        let artistID = metadata.compactMap { (($0["navigationEndpoint"] as? [String: Any])?["browseEndpoint"] as? [String: Any])?["browseId"] as? String }.first { $0.hasPrefix("UC") }
        let artists = metadata.filter { run in
            let browse = (run["navigationEndpoint"] as? [String: Any])?["browseEndpoint"] as? [String: Any]
            return (browse?["browseId"] as? String)?.hasPrefix("UC") == true
        }.compactMap { $0["text"] as? String }
        let fallback = metadata.compactMap { $0["text"] as? String }.first { !$0.trimmingCharacters(in: .whitespaces).isEmpty && $0 != " • " && seconds($0) == 0 }
        let fixed = renderer["fixedColumns"] as? [[String: Any]] ?? []
        let durationTexts = fixed.map { text(($0["musicResponsiveListItemFixedColumnRenderer"] as? [String: Any])?["text"]) } + metadata.compactMap { $0["text"] as? String }
        return Track(videoID: id, title: title, artist: artists.isEmpty ? fallback ?? "Исполнитель не указан" : artists.joined(separator: ", "), duration: durationTexts.map(seconds).first(where: { $0 > 0 }) ?? 0, artworkURL: thumb(renderer), artistID: artistID)
    }
    static func video(_ renderer: [String: Any]) -> Track? {
        guard let id = renderer["videoId"] as? String, VideoID.isValid(id) else { return nil }
        let duration = seconds(text(renderer["lengthText"]))
        guard duration > 0, duration <= 1200 else { return nil }
        let byline = renderer["ownerText"] ?? renderer["longBylineText"]
        let runs = (byline as? [String: Any])?["runs"] as? [[String: Any]] ?? []
        let artistID = runs.compactMap { (($0["navigationEndpoint"] as? [String: Any])?["browseEndpoint"] as? [String: Any])?["browseId"] as? String }.first
        let title = text(renderer["title"])
        guard !title.isEmpty else { return nil }
        return Track(videoID: id, title: title, artist: text(byline), duration: duration, artworkURL: thumb(renderer), artistID: artistID)
    }
    static func panel(_ renderer: [String: Any]) -> Track? {
        guard let id = renderer["videoId"] as? String, VideoID.isValid(id), renderer["unplayableText"] == nil else { return nil }
        let title = text(renderer["title"])
        guard !title.isEmpty else { return nil }
        let byline = renderer["longBylineText"] ?? renderer["shortBylineText"]
        let artist = text(byline)
        let artistID = (((byline as? [String: Any])?["runs"] as? [[String: Any]])?.first?["navigationEndpoint"] as? [String: Any]).flatMap { ($0["browseEndpoint"] as? [String: Any])?["browseId"] as? String }
        return Track(videoID: id, title: title, artist: artist.isEmpty ? "Исполнитель не указан" : artist, duration: seconds(text(renderer["lengthText"])), artworkURL: thumb(renderer), artistID: artistID)
    }
}
