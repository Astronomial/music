import Foundation

/// A compact representation of actual audio, produced by the pinned frozen
/// backbone. Style scores are model predictions, not verified catalogue labels.
public struct SemanticAudioProfile: Codable, Hashable, Sendable {
    public static let modelID = "discogs-effnet-bsdynamic-1:a280825b334797cf"
    public struct Style: Codable, Hashable, Sendable { public let index: Int; public let score: Double }
    public var version = 1
    public var model = modelID
    public var seconds: Double
    public var vector: String
    public var styles: [Style]
    public var isValid: Bool {
        guard version == 1, model == Self.modelID, seconds.isFinite, (8...30).contains(seconds), vector.count == 1708, let bytes = Data(base64Encoded: vector), bytes.count == 1280, bytes.contains(where: { $0 != 0 }), styles.count <= 16, Set(styles.map(\.index)).count == styles.count else { return false }
        return styles.allSatisfy { (0..<400).contains($0.index) && $0.score.isFinite && (0...1).contains($0.score) }
    }
    public static func pack(_ embedding: [Double], scores: [Double], seconds: Double) -> Self? {
        guard embedding.count == 1280, scores.count == 400, embedding.allSatisfy(\.isFinite), scores.allSatisfy({ $0.isFinite && (0...1).contains($0) }), let maximum = embedding.map({ abs($0) }).max(), maximum > 1e-10 else { return nil }
        // JS Math.round rounds ties toward +infinity; use the same convention.
        let quantized = embedding.map { UInt8(bitPattern: Int8(max(-127, min(127, floor($0 / maximum * 127 + 0.5))))) }
        let styles = scores.enumerated().sorted { $0.element == $1.element ? $0.offset < $1.offset : $0.element > $1.element }.prefix(16).map { Style(index: $0.offset, score: $0.element) }
        let value = Self(seconds: seconds, vector: Data(quantized).base64EncodedString(), styles: styles)
        return value.isValid ? value : nil
    }
    public static func similarity(_ a: Self?, _ b: Self?) -> Double? {
        guard let a, let b, a.isValid, b.isValid, a.model == b.model, let x = Data(base64Encoded: a.vector), let y = Data(base64Encoded: b.vector) else { return nil }
        var dot = 0.0, nx = 0.0, ny = 0.0
        for i in 0..<1280 { let first = Double(Int8(bitPattern: x[i])), second = Double(Int8(bitPattern: y[i])); dot += first * second; nx += first * first; ny += second * second }
        return min(1, max(0, dot / sqrt(nx * ny)))
    }
}
