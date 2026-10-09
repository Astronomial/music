import Foundation

public enum ArtworkPolicy {
    /// Prefer album art from YouTube Music; otherwise use progressively smaller video thumbnails.
    public static func candidates(for track: Track, pixels: Int) -> [URL] {
        let pixels = min(1280, max(160, pixels))
        var result: [URL] = []
        if let original = track.artworkURL, original.scheme == "https" {
            let host = original.host?.lowercased() ?? ""
            if host == "lh3.googleusercontent.com" || host == "lh3.ggpht.com" {
                // Only known image-CDN size suffixes; don't alter signed query parameters.
                let value = original.absoluteString
                if let range = value.range(of: #"=(?:w\d+|s\d+)[^?]*$"#, options: .regularExpression),
                   let larger = URL(string: String(value[..<range.lowerBound]) + "=w\(pixels)-h\(pixels)-l90-rj") { result.append(larger) }
                if !result.contains(original) { result.append(original) }
                return result
            }
            if !(host == "i.ytimg.com" || host == "img.youtube.com") { return [original] }
        }
        if VideoID.isValid(track.id) {
            let names = pixels > 480 ? ["maxresdefault", "sddefault", "hqdefault"] : ["hqdefault"]
            result += names.compactMap { URL(string: "https://i.ytimg.com/vi/\(track.id)/\($0).jpg") }
        }
        if let original = track.artworkURL, original.scheme == "https", !result.contains(original) { result.append(original) }
        return result
    }
}
