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
        self.totalMilliseconds = max(0, totalMilliseconds)
        self.resolutionMilliseconds = min(self.totalMilliseconds, max(0, resolutionMilliseconds))
    }
    public static func percentile(_ measurements: [Self], source: String, fraction: Double) -> Double? {
        let values = measurements.filter { $0.source == source }.map(\.totalMilliseconds).sorted()
        guard !values.isEmpty else { return nil }
        let index = min(values.count - 1, max(0, Int(ceil(min(1, max(0, fraction)) * Double(values.count))) - 1))
        return values[index]
    }
}
