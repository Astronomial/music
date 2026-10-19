import CryptoKit
import Foundation
import Security
import FormaCore

struct PCConnection: Codable, Sendable {
    var host: String
    var hosts: [String]? = nil
    let port: Int
    let pin: String
    var token: String
    var baselineVersion: Int? = nil
    static func parse(_ code: String) throws -> (PCConnection, String) {
        var loopback = false
#if DEBUG
        loopback = ProcessInfo.processInfo.arguments.contains("--forma-smoke")
#endif
        guard let code = PCPairingCode(code, allowLoopback: loopback), let host = code.hosts.first else { throw SyncError.invalidCode }
        var connection = PCConnection(host: host, port: code.port, pin: code.pin, token: "")
        connection.hosts = code.hosts
        return (connection, code.secret)
    }
    var endpoints: [String] { var seen = Set<String>(); return ([host] + (hosts ?? [])).filter { seen.insert($0).inserted } }

    func url(_ path: String) -> URL { URL(string: "https://\(host):\(port)\(path)")! }
    func validated() -> PCConnection? {
        guard !token.isEmpty, token.count <= 512 else { return nil }
        var code = URLComponents(); code.scheme = "forma"; code.host = "pair"
        code.queryItems = [URLQueryItem(name: "host", value: host), URLQueryItem(name: "port", value: String(port)), URLQueryItem(name: "pin", value: pin), URLQueryItem(name: "code", value: "000000")]
        if let hosts { code.queryItems?.append(URLQueryItem(name: "hosts", value: hosts.joined(separator: ","))) }
        guard let text = code.string, var checked = try? Self.parse(text).0 else { return nil }
        checked.token = token; checked.baselineVersion = baselineVersion; return checked
    }
}
enum SyncError: LocalizedError {
    case invalidCode, rejected(String), response(Int, String), tooLarge, proposalMissing
    var errorDescription: String? {
        switch self {
        case .invalidCode: return "Скопируй полный код подключения из настроек Forma на ПК."
        case .rejected(let message), .response(_, let message): return message
        case .tooLarge: return "Библиотека слишком большая для синхронизации."
        case .proposalMissing: return "Пакет больше не хранится на ПК. Подготовь новый обмен и подтверди его."
        }
    }
}
private final class PinnedPCSession: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    let connection: PCConnection
    private let lock = NSLock()
    private var issue: String?
    var validationIssue: String? { lock.lock(); defer { lock.unlock() }; return issue }
    init(_ connection: PCConnection) { self.connection = connection }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        func reject(_ message: String) { lock.lock(); issue = message; lock.unlock(); completionHandler(.cancelAuthenticationChallenge, nil) }
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == connection.host, let trust = challenge.protectionSpace.serverTrust else { reject("Не удалось проверить адрес ПК."); return }
        // Populate the chain even when the OS initially distrusts our self-signed leaf.
        SecTrustSetNetworkFetchAllowed(trust, false)
        _ = SecTrustEvaluateWithError(trust, nil)
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let certificate = chain.first else { reject("ПК не предоставил сертификат."); return }
        let fingerprint = SHA256.hash(data: SecCertificateCopyData(certificate) as Data).map { String(format: "%02x", $0) }.joined()
        guard fingerprint == connection.pin else { reject("Сертификат ПК изменился. Подключи ПК новым кодом."); return }
        // This is a paired local identity, not a public web-PKI certificate.
        // Exact DER pin + challenge host authenticate the peer; BasicX509 checks its
        // certificate while avoiding public SSL issuance/lifetime rules for our leaf.
        SecTrustSetPolicies(trust, SecPolicyCreateBasicX509())
        // Only this already-pinned leaf becomes an anchor, in this request's trust object.
        SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        var trustError: CFError?
        guard SecTrustEvaluateWithError(trust, &trustError) else { reject("Не удалось проверить сертификат ПК: \(trustError.map { CFErrorCopyDescription($0) as String } ?? "ошибка доверия")."); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
actor SyncClient {
    struct ConnectionRead: Sendable { let connection: PCConnection?; let retry: Bool }
    private struct Failure: Decodable { let error: String; let code: String? }
    private(set) var connection: PCConnection?
    private let account = "music.forma.pc-connection"
    private let readConnection: @Sendable () -> ConnectionRead
    private var restoration: (id: UUID, task: Task<ConnectionRead, Never>)?
    private var restored = false
    private var pendingSessions: [UUID: URLSession] = [:]
    private var pairingGeneration = UUID()
    private var healthyEndpoint: (pin: String, host: String, at: Date)?
    private struct Health: Decodable, Sendable { let protocolVersion: Int }
    private struct Empty: Encodable, Sendable {}
    init(readConnection: @escaping @Sendable () -> ConnectionRead = SyncClient.readSavedConnection) {
        self.readConnection = readConnection
    }
    nonisolated static func readSavedConnection() -> ConnectionRead {
        // Security services can take time to start; never block the first UI frame.
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: "music.forma.pc-connection", kSecReturnData as String: true]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data { return ConnectionRead(connection: try? JSONDecoder().decode(PCConnection.self, from: data), retry: false) }
        return ConnectionRead(connection: nil, retry: status != errSecItemNotFound)
    }
    func restore() async -> PCConnection? {
        if restored { return connection }
        let read = readConnection
        let work = restoration ?? (id: UUID(), task: Task.detached(priority: .utility) { read() })
        restoration = work
        let saved = await work.task.value
        if restoration?.id == work.id { restoration = nil }
        if !restored, !saved.retry { connection = saved.connection?.validated(); restored = true }
        return connection
    }
    func pair(_ code: String) async throws {
        var (next, secret) = try PCConnection.parse(code)
        let generation = UUID(); pairingGeneration = generation
        let previous = await restore()
        guard pairingGeneration == generation else { throw CancellationError() }
        if let previous, previous.pin == next.pin {
            next.token = previous.token; next.baselineVersion = previous.baselineVersion
            do {
                let _: Health = try await request(next, path: "/sync/ping", body: Empty())
                try Task.checkCancellation()
                guard pairingGeneration == generation else { throw CancellationError() }
                next.host = healthyEndpoint?.host ?? next.host
                try saveConnection(next); return
            } catch SyncError.response(let status, _) where status == 401 || status == 404 {
                // Revoked token/older PC: use the fresh code, preserving the PC pin.
            }
        }
        guard pairingGeneration == generation else { throw CancellationError() }
        struct Request: Encodable { let code: String; let name: String; let requestID: String }
        struct Reply: Decodable { let token: String; let protocolVersion: Int? }
        let reply: Reply = try await request(next, path: "/pair", body: Request(code: secret, name: "iPhone · Forma", requestID: UUID().uuidString))
        try Task.checkCancellation()
        guard reply.protocolVersion == 2 else { throw SyncError.rejected("Обнови Forma на ПК: нужен обмен с подтверждением.") }
        guard pairingGeneration == generation, !reply.token.isEmpty, reply.token.count <= 512 else { throw CancellationError() }
        next.token = reply.token
        next.baselineVersion = 3
        next.host = healthyEndpoint?.host ?? next.host
        try saveConnection(next)
    }
    private func saveConnection(_ next: PCConnection) throws {
        let data = try JSONEncoder().encode(next)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account]
        let changes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            var attributes = query; changes.forEach { attributes[$0.key] = $0.value }
            status = SecItemAdd(attributes as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw SyncError.rejected("Не удалось сохранить подключение в защищённом хранилище.") }
        restored = true; connection = next
    }
    func retireGoogleCredentials() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "music.forma.google", kSecAttrAccount as String: "oauth"] as CFDictionary)
    }
    func cancelPendingRequests() { pairingGeneration = UUID(); healthyEndpoint = nil; pendingSessions.values.forEach { $0.invalidateAndCancel() }; pendingSessions.removeAll() }
    func disconnect() { cancelPendingRequests(); restored = true; SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account] as CFDictionary); connection = nil }
    func prepare(_ checkpoint: WiFiCheckpoint) async throws -> WiFiProposal {
        guard let connection, connection.pin == checkpoint.peerID else { throw SyncError.rejected("Сначала подключи ПК.") }
        struct Request: Encodable { let id: String; let library: Library; let base: Library? }
        let reply: WiFiProposal = try await request(connection, path: "/sync/prepare", body: Request(id: checkpoint.id, library: checkpoint.sent, base: checkpoint.base))
        return try reply.validated(expectedID: checkpoint.id)
    }
    func review(_ id: String) async throws -> WiFiProposal { try await proposalRequest(id, path: "/sync/status") }
    func approve(_ id: String) async throws -> WiFiProposal { try await proposalRequest(id, path: "/sync/approve") }
    func reject(_ id: String) async throws -> WiFiProposal { try await proposalRequest(id, path: "/sync/reject") }
    private func proposalRequest(_ id: String, path: String) async throws -> WiFiProposal {
        guard let connection else { throw SyncError.rejected("Сначала подключи ПК.") }
        struct Request: Encodable { let id: String }
        let reply: WiFiProposal = try await request(connection, path: path, body: Request(id: id))
        return try reply.validated(expectedID: id)
    }
    func acknowledge(_ id: String) async throws {
        guard let connection else { throw SyncError.rejected("Сначала подключи ПК.") }
        struct Request: Encodable { let id: String }; struct Reply: Decodable { let protocolVersion: Int }
        let reply: Reply = try await request(connection, path: "/sync/ack", body: Request(id: id))
        guard reply.protocolVersion == 2 else { throw WiFiExchangeError.invalidProposal }
    }
    func checkConnection(_ code: String? = nil) async throws -> String {
        let candidate: PCConnection
        if let code { candidate = try PCConnection.parse(code).0 }
        else if let saved = await restore() { candidate = saved }
        else { throw SyncError.invalidCode }
        let found = try await resolveEndpoint(candidate, force: true)
        if var current = connection, current.pin == found.pin {
            current.host = found.host; current.hosts = found.endpoints; try saveConnection(current)
        }
        return found.host
    }
    private struct Probe: Sendable { let connection: PCConnection?; let issue: String }
    private func resolveEndpoint(_ connection: PCConnection, force: Bool = false) async throws -> PCConnection {
        if !force, let healthyEndpoint, healthyEndpoint.pin == connection.pin, connection.endpoints.contains(healthyEndpoint.host), Date().timeIntervalSince(healthyEndpoint.at) < 30 {
            var result = connection; result.host = healthyEndpoint.host; return result
        }
        let generation = pairingGeneration
        return try await withThrowingTaskGroup(of: Probe.self) { group in
            for host in connection.endpoints {
                var candidate = connection; candidate.host = host
                group.addTask { [candidate] in
                    do {
                        let reply: Health = try await self.requestOnce(candidate, path: "/health", body: Empty(), probe: true)
                        guard reply.protocolVersion == 2 else { return Probe(connection: nil, issue: "Обнови Forma на ПК.") }
                        return Probe(connection: candidate, issue: "")
                    } catch SyncError.response(404, _) {
                        // A successfully pinned older PC may not expose /health.
                        return Probe(connection: candidate, issue: "")
                    } catch { return Probe(connection: nil, issue: error.localizedDescription) }
                }
            }
            var issue = ""
            for try await result in group {
                try Task.checkCancellation()
                guard generation == pairingGeneration else { throw CancellationError() }
                if let found = result.connection {
                    healthyEndpoint = (found.pin, found.host, Date()); group.cancelAll(); return found
                }
                issue = result.issue
            }
            throw SyncError.rejected("ПК недоступен. Разреши Forma доступ к локальной сети iPhone и частной сети Windows. VPN должен разрешать локальную сеть. USB сам по себе не заменяет Wi-Fi. " + issue)
        }
    }
    private func request<Body: Encodable, Reply: Decodable>(_ connection: PCConnection, path: String, body: Body) async throws -> Reply {
        let generation = pairingGeneration
        var endpoint = try await resolveEndpoint(connection)
        guard generation == pairingGeneration else { throw CancellationError() }
        let reply: Reply
        do { reply = try await requestOnce(endpoint, path: path, body: body) }
        catch where error is URLError && (error as? URLError)?.code != .cancelled && !Task.isCancelled {
            guard generation == pairingGeneration else { throw CancellationError() }
            endpoint = try await resolveEndpoint(connection, force: true)
            reply = try await requestOnce(endpoint, path: path, body: body)
        }
        guard generation == pairingGeneration else { throw CancellationError() }
        if var current = self.connection, current.pin == endpoint.pin, current.host != endpoint.host {
            current.host = endpoint.host; try? saveConnection(current)
        }
        return reply
    }
    private func requestOnce<Body: Encodable, Reply: Decodable>(_ connection: PCConnection, path: String, body: Body, probe: Bool = false) async throws -> Reply {

        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .millisecondsSince1970
        let data = try encoder.encode(body); guard data.count <= 8 * 1024 * 1024 else { throw SyncError.tooLarge }
        let delegate = PinnedPCSession(connection), config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = probe ? 2 : 12; config.timeoutIntervalForResource = probe ? 3 : 30; config.allowsCellularAccess = false; config.waitsForConnectivity = false; config.networkServiceType = .default; config.allowsExpensiveNetworkAccess = true; config.allowsConstrainedNetworkAccess = true; config.connectionProxyDictionary = [:]; config.httpShouldSetCookies = false
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        let requestID = UUID(); pendingSessions[requestID] = session
        defer { session.invalidateAndCancel(); pendingSessions[requestID] = nil }
        var req = URLRequest(url: connection.url(path)); req.httpMethod = "POST"; req.httpBody = data
        req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        let bytes: Data, response: URLResponse
        do { (bytes, response) = try await session.data(for: req) }
        catch { if let issue = delegate.validationIssue { throw SyncError.rejected(issue) }; throw error }
        guard bytes.count <= 8 * 1024 * 1024 else { throw SyncError.tooLarge }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            let failure = try? JSONDecoder().decode(Failure.self, from: bytes)
            if (response as? HTTPURLResponse)?.statusCode == 409, failure?.code == "proposal_missing" { throw SyncError.proposalMissing }
            throw SyncError.response((response as? HTTPURLResponse)?.statusCode ?? 0, failure?.error ?? "ПК недоступен. Проверь сеть и разрешение брандмауэра.")
        }
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .millisecondsSince1970
        return try decoder.decode(Reply.self, from: bytes)
    }
}
