import Foundation

/// Bounded LAN endpoints, all authenticated with the same installation pin.
public struct PCPairingCode: Sendable {
    public let hosts: [String]
    public let port: Int
    public let pin: String
    public let secret: String
    public static func localIPv4(_ host: String, allowLoopback: Bool = false) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts.allSatisfy({ !$0.isEmpty && $0.count <= 3 && $0.allSatisfy({ $0.isASCII && $0.isNumber }) }),
              parts.allSatisfy({ (0...255).contains(Int($0) ?? -1) }) else { return false }
        let p = parts.map { Int($0)! }
        return (allowLoopback && p[0] == 127) || p[0] == 10 || (p[0] == 192 && p[1] == 168) || (p[0] == 172 && (16...31).contains(p[1])) || (p[0] == 169 && p[1] == 254)
    }
    public init?(_ text: String, allowLoopback: Bool = false) {
        guard text.count <= 2000, let url = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "forma", url.host == "pair", url.user == nil, url.password == nil, url.port == nil,
              url.path.isEmpty, url.fragment == nil else { return nil }
        let items = url.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count else { return nil }
        func value(_ key: String) -> String? { items.first { $0.name == key }?.value }
        guard let primary = value("host"), let port = Int(value("port") ?? ""), (1...65535).contains(port),
              let pin = value("pin"), pin.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let secret = value("code"), secret.range(of: "^[0-9]{6}$", options: .regularExpression) != nil else { return nil }
        let extras = value("hosts").map { $0.components(separatedBy: ",") } ?? []
        guard extras.count <= 8 else { return nil }
        var seen = Set<String>(), hosts: [String] = []
        for host in [primary] + extras {
            guard Self.localIPv4(host, allowLoopback: allowLoopback) else { return nil }
            let canonical = host.split(separator: ".").map { String(Int($0)!) }.joined(separator: ".")
            if seen.insert(canonical).inserted { hosts.append(canonical) }
        }
        guard hosts.count <= 8 else { return nil }
        self.hosts = hosts; self.port = port; self.pin = pin; self.secret = secret
    }
}
