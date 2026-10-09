import Foundation

/// VPN routes may expose only an `other` interface; cost flags still identify
/// cellular/Low Data Mode. Local Wi-Fi is monitored separately for PC sync.
public struct NetworkPolicy: Sendable, Equatable {
    public var known: Bool
    public var reachable: Bool
    public var cellular: Bool
    public var expensive: Bool
    public var constrained: Bool
    public init(known: Bool = true, reachable: Bool, cellular: Bool = false, expensive: Bool = false, constrained: Bool = false) {
        self.known = known; self.reachable = reachable; self.cellular = cellular; self.expensive = expensive; self.constrained = constrained
    }
    public static let unknown = NetworkPolicy(known: false, reachable: false)
    public var lean: Bool { !known || cellular || expensive || constrained }
    public var canPrewarmExtraTracks: Bool { known && reachable && !lean }
    public var catalogParallelism: Int { lean ? 1 : 3 }
    public var automaticRefreshInterval: TimeInterval { lean ? 120 : 30 }
    public func canSyncPC(localWiFi: Bool) -> Bool { localWiFi && !cellular }
    public func extractionDeadline(base: TimeInterval) -> TimeInterval { lean ? base * 2 : base }
    public func bufferDeadline(base: TimeInterval) -> TimeInterval { lean ? base * 1.5 : base }
}

/// Unreachable PCs must not cause an upload after every listening event.
public struct SyncBackoff: Sendable {
    public private(set) var failures = 0
    public private(set) var nextAttempt = Date.distantPast
    public init() {}
    public func allows(at now: Date = Date(), manual: Bool = false) -> Bool { manual || now >= nextAttempt }
    public mutating func failed(at now: Date = Date()) {
        failures = min(4, failures + 1)
        nextAttempt = now.addingTimeInterval(min(120, 15 * pow(2, Double(failures - 1))))
    }
    public mutating func reset() { failures = 0; nextAttempt = .distantPast }
}
