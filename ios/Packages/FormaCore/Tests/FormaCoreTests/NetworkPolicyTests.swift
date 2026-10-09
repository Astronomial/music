import XCTest
@testable import FormaCore

final class NetworkPolicyTests: XCTestCase {
    func testCellularVPNDoesNotUseLocalPCAndKeepsBoundedAudioBudgets() {
        let policy = NetworkPolicy(reachable: true, cellular: true, expensive: true)
        XCTAssertFalse(policy.canSyncPC(localWiFi: false))
        XCTAssertFalse(policy.canSyncPC(localWiFi: true), "Cellular Wi-Fi Assist must not upload to a private PC address")
        XCTAssertFalse(policy.canPrewarmExtraTracks)
        XCTAssertEqual(policy.catalogParallelism, 1)
        XCTAssertEqual(policy.extractionDeadline(base: 12), 24)
        XCTAssertEqual(policy.bufferDeadline(base: 8), 12)
    }
    func testVPNOtherInterfaceUsesCostFlagsAndPreservesLocalWiFiSync() {
        let cellularVPN = NetworkPolicy(reachable: true, expensive: true)
        XCTAssertTrue(cellularVPN.lean)
        XCTAssertFalse(cellularVPN.canPrewarmExtraTracks)
        XCTAssertFalse(cellularVPN.canSyncPC(localWiFi: false))
        let wifiVPN = NetworkPolicy(reachable: true)
        XCTAssertTrue(wifiVPN.canSyncPC(localWiFi: true))
        XCTAssertTrue(wifiVPN.canPrewarmExtraTracks)
        XCTAssertEqual(wifiVPN.extractionDeadline(base: 12), 12)
    }
    func testLowDataAndUnknownPathsDoNotStartOptionalPrewarming() {
        XCTAssertFalse(NetworkPolicy.unknown.canPrewarmExtraTracks)
        XCTAssertTrue(NetworkPolicy(reachable: true, constrained: true).lean)
        XCTAssertFalse(NetworkPolicy(reachable: false).canPrewarmExtraTracks)
        XCTAssertEqual(NetworkPolicy(reachable: true, constrained: true).automaticRefreshInterval, 120)
    }
    func testUnreachablePCBackoffIsBoundedAndManualRetryIsAvailable() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var retry = SyncBackoff()
        XCTAssertTrue(retry.allows(at: now))
        for delay in [15.0, 30, 60, 120, 120] {
            retry.failed(at: now)
            XCTAssertFalse(retry.allows(at: now))
            XCTAssertFalse(retry.allows(at: now.addingTimeInterval(delay - 1)))
            XCTAssertTrue(retry.allows(at: now.addingTimeInterval(delay)))
            XCTAssertTrue(retry.allows(at: now, manual: true))
        }
        retry.reset(); XCTAssertTrue(retry.allows(at: now)); XCTAssertEqual(retry.failures, 0)
    }
}
