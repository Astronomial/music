import Foundation

/// Search context is weak evidence, never an assertion about analysed audio.
public enum PulseDirections {
    public static func suffix(_ settings: PulseSettings) -> String {
        var words: [String] = []
        switch settings.energy {
        case "low": words.append("chill relaxing")
        case "high": words.append("energetic upbeat")
        case "medium": words.append("mid tempo")
        default: break
        }
        switch settings.vocals {
        case "instrumental": words.append("instrumental")
        case "vocal": words.append("vocal")
        default: break
        }
        return words.joined(separator: " ")
    }
    public static func hints(_ settings: PulseSettings) -> [String] {
        (settings.energy == "any" ? [] : ["energy:\(settings.energy)"]) + (settings.vocals == "any" ? [] : ["vocals:\(settings.vocals)"])
    }
    public static func score(_ track: Track, settings: PulseSettings) -> Double {
        var result = 0.0
        let text = PulseEngine.fold(track.title + " " + track.genres.joined(separator: " "))
        let low = track.moodHints.contains("calm") || track.moodHints.contains("focus") || text.contains("ambient") || text.contains("chill")
        let high = track.moodHints.contains("energetic") || text.contains("energetic")
        if settings.energy != "any" {
            if track.moodHints.contains("energy:\(settings.energy)") { result += 0.18 }
            else if (settings.energy == "low" && low) || (settings.energy == "high" && high) { result += 0.25 }
        }
        let instrumental = text.contains("instrumental") || track.moodHints.contains("focus")
        if settings.vocals != "any" {
            if track.moodHints.contains("vocals:\(settings.vocals)") { result += 0.18 }
            else if settings.vocals == "instrumental", instrumental { result += 0.25 }
            else if settings.vocals == "vocal", instrumental { result -= 0.25 }
        }
        return result
    }
}
