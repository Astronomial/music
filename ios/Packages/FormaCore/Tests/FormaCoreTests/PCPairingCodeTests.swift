import XCTest
@testable import FormaCore

final class PCPairingCodeTests: XCTestCase {
    private let pin = String(repeating: "a", count: 64)
    private func code(_ extra: String = "") -> String { "forma://pair?host=192.168.1.8&port=30377&pin=\(pin)&code=123456\(extra)" }
    func testOldCodesAndMultipleLocalAdapters() throws {
        XCTAssertEqual(try XCTUnwrap(PCPairingCode(code())).hosts, ["192.168.1.8"])
        let parsed = try XCTUnwrap(PCPairingCode(code("&hosts=10.8.0.2,192.168.1.8,169.254.1.3")))
        XCTAssertEqual(parsed.hosts, ["192.168.1.8", "10.8.0.2", "169.254.1.3"])
        XCTAssertEqual(parsed.port, 30377); XCTAssertEqual(parsed.secret, "123456")
    }
    func testRejectsExternalHostsAmbiguityAndUnboundedProbing() {
        for value in ["&host=10.0.0.2", "&hosts=8.8.8.8", "&hosts=192.168.1.999", "&hosts=localhost", "&hosts=127.0.0.1", "&hosts=100.64.0.1", "#fragment", "&hosts=" + (1...9).map { "10.0.0.\($0)" }.joined(separator: ",")] {
            XCTAssertNil(PCPairingCode(code(value)), value)
        }
        XCTAssertNil(PCPairingCode(code().replacingOccurrences(of: "pair?", with: "pair/path?")))
    }
    func testLoopbackIsExplicitlyLimitedToNativeSmoke() {
        let local = code().replacingOccurrences(of: "192.168.1.8", with: "127.0.0.1")
        XCTAssertNil(PCPairingCode(local)); XCTAssertNotNil(PCPairingCode(local, allowLoopback: true))
    }
}
