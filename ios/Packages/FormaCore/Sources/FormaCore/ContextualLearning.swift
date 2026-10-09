import Foundation

/// Same ten selection-time features and regularized shared learner as PC 1.7.
/// The score is a ranking signal, not a calibrated probability or a neural model.
public struct RecommendationContext: Codable, Sendable, Equatable {
    public var version: Int = 1
    public var features: [Double]
    public var lane: String
    public init(features: [Double], lane: String) { self.features = features; self.lane = lane }
    public var isValid: Bool { version == 1 && features.count == 10 && features.first == 1 && features.allSatisfy { $0.isFinite && (0...1).contains($0) } }
}
public enum ContextualLearning {
    public struct Model: Sendable {
        public let coefficients: [Double]
        public let covariance: [[Double]]
        public let evidence: Double
        public let samples: Int
        public var confidence: Double { evidence / (12 + evidence) }
    }
    public struct Prediction: Sendable { public let mean: Double; public let correction: Double; public let uncertainty: Double; public let confidence: Double }
    private static let prior = [0.5, 0.12, 0, 0, 0, 0, 0, 0, 0, 0]
    public static func features(taste: Double, nearby: Double, session: Double, newArtist: Bool, known: Bool, language: Double, context: Double, metadata: Bool) -> [Double] {
        [1, taste, nearby, max(0, session), max(0, -session), newArtist ? 1 : 0, known ? 1 : 0, language, context, metadata ? 1 : 0].map { min(1, max(0, $0)) }
    }
    public static func model(_ library: Library, now: Date = Date()) -> Model {
        let d = 10
        var matrix = (0..<d).map { i in (0..<d).map { j in i == j ? 4.0 : 0 } }
        var target = prior.map { $0 * 4 }, seen = Set<String>(), evidence = 0.0, samples = 0
        for event in library.events.suffix(3000).sorted(by: { $0.at > $1.at }) {
            let age = now.timeIntervalSince(event.at)
            guard age.isFinite, age >= 0, let reward = event.reward, let snapshot = event.recommendation, snapshot.isValid else { continue }
            let key = event.trackID + ":" + String(floor(event.at.timeIntervalSince1970 / 86400))
            guard seen.insert(key).inserted else { continue }
            let weight = pow(0.5, age / (30 * 86400)) * (event.kind == .skip && library.settings.skipSensitivity == "soft" ? 0.35 : 1)
            let x = snapshot.features
            for i in 0..<d {
                target[i] += weight * reward * x[i]
                for j in 0..<d { matrix[i][j] += weight * x[i] * x[j] }
            }
            evidence += weight; samples += 1
        }
        var rows = matrix.enumerated().map { i, row in row + (0..<d).map { i == $0 ? 1.0 : 0 } }
        for i in 0..<d {
            let pivot = rows[i][i]
            for j in 0..<(2*d) { rows[i][j] /= pivot }
            for k in 0..<d where k != i {
                let factor = rows[k][i]
                for j in 0..<(2*d) { rows[k][j] -= factor * rows[i][j] }
            }
        }
        let covariance = rows.map { Array($0.suffix(d)) }
        let coefficients = covariance.map { row in zip(row, target).reduce(0) { $0 + $1.0 * $1.1 } }
        return Model(coefficients: coefficients, covariance: covariance, evidence: evidence, samples: samples)
    }
    public static func predict(_ model: Model, features x: [Double]) -> Prediction {
        guard x.count == 10 else { return Prediction(mean: 0.5, correction: 0, uncertainty: 0.5, confidence: 0) }
        let baseline = zip(prior, x).reduce(0) { $0 + $1.0 * $1.1 }
        guard model.samples > 0 else { return Prediction(mean: baseline, correction: 0, uncertainty: 0.5, confidence: 0) }
        let mean = min(1, max(0, zip(model.coefficients, x).reduce(0) { $0 + $1.0 * $1.1 }))
        var variance = 0.0
        for i in 0..<10 { for j in 0..<10 { variance += x[i] * model.covariance[i][j] * x[j] } }
        return Prediction(mean: mean, correction: (mean - baseline) * model.confidence, uncertainty: min(1, sqrt(max(0, variance))), confidence: model.confidence)
    }
}
