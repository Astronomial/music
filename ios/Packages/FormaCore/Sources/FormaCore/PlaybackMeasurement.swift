import Foundation

/// Measured from the playback request to AVPlayer reporting playing, using a monotonic clock.
public struct PlaybackMeasurement: Codable, Sendable {
    public let title: String
    public let source: String
    public let totalMilliseconds: Double
    public let resolutionMilliseconds: Double
    public var bufferMilliseconds: Double { max(0, totalMilliseconds - resolutionMilliseconds) }
    public init(title: String, source: String, totalMilliseconds: Double, resolutionMilliseconds: Double) {
        self.title = title; self.source = source
        self.totalMilliseconds = totalMilliseconds.isFinite ? max(0, totalMilliseconds) : 0
        self.resolutionMilliseconds = resolutionMilliseconds.isFinite ? min(self.totalMilliseconds, max(0, resolutionMilliseconds)) : 0
    }
    public static func percentile(_ measurements: [Self], source: String, fraction: Double) -> Double? {
        let values = measurements.filter { $0.source == source }.map(\.totalMilliseconds).sorted()
        guard !values.isEmpty else { return nil }
        let fraction = fraction.isFinite ? min(1, max(0, fraction)) : 0.5
        let index = min(values.count - 1, max(0, Int(ceil(fraction * Double(values.count))) - 1))
        return values[index]
    }
}
