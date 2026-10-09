import CryptoKit
import Foundation
import Security
import FormaCore

struct PCConnection: Codable, Sendable {
    let host: String
    let port: Int
    let pin: String
    var token: String
    static func parse(_ code: String) throws -> (PCConnection, String) {
        guard let url = URLComponents(string: code.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme == "forma", url.host == "pair", url.user == nil, url.password == nil else { throw SyncError.invalidCode }
        func value(_ key: String) -> String? { url.queryItems?.first { $0.name == key }?.value }
        guard let host = value("host"), let portText = value("port"), let port = Int(portText), (1...65535).contains(port),
              let pin = value("pin"), pin.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let secret = value("code"), secret.range(of: "^[0-9]{6}$", options: .regularExpression) != nil else { throw SyncError.invalidCode }
        guard host.range(of: #"^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$"#, options: .regularExpression) != nil else { throw SyncError.invalidCode }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false).compactMap { Int($0) }
        var allowedLoopback = false
#if DEBUG
        allowedLoopback = ProcessInfo.processInfo.arguments.contains("--forma-smoke") && host == "127.0.0.1"
#endif
        guard host.split(separator: ".", omittingEmptySubsequences: false).count == 4, parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }),
              allowedLoopback || parts[0] == 10 || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 172 && (16...31).contains(parts[1])) else { throw SyncError.invalidCode }
        return (PCConnection(host: parts.map(String.init).joined(separator: "."), port: port, pin: pin, token: ""), secret)
    }
    func url(_ path: String) -> URL { URL(string: "https://\(host):\(port)\(path)")! }
}
enum SyncError: LocalizedError {
    case invalidCode, rejected(String), tooLarge
    var errorDescription: String? {
        switch self {
        case .invalidCode: return "Скопируй полный код подключения из настроек Forma на ПК."
        case .rejected(let message): return message
        case .tooLarge: return "Библиотека слишком большая для синхронизации."
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
    private struct Failure: Decodable { let error: String }
    private(set) var connection: PCConnection?
    private let account = "music.forma.pc-connection"
    private let restoration: Task<PCConnection?, Never>
    private var restored = false
    private var pendingSessions: [UUID: URLSession] = [:]
    private var pairingGeneration = UUID()
    init() {
        // Security services can take time to start; never block the first UI frame.
        restoration = Task.detached(priority: .utility) {
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: "music.forma.pc-connection", kSecReturnData as String: true]
            var result: CFTypeRef?
            if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data { return try? JSONDecoder().decode(PCConnection.self, from: data) }
            return nil
        }
    }
    func restore() async -> PCConnection? {
        if restored { return connection }
        let saved = await restoration.value
        if !restored { connection = saved; restored = true }
        return connection
    }
    func pair(_ code: String) async throws {
        var (next, secret) = try PCConnection.parse(code)
        let generation = UUID(); pairingGeneration = generation
        struct Request: Encodable { let code: String; let name: String }
        struct Reply: Decodable { let token: String }
        let reply: Reply = try await request(next, path: "/pair", body: Request(code: secret, name: "iPhone · Forma"))
        try Task.checkCancellation()
        guard pairingGeneration == generation, !reply.token.isEmpty, reply.token.count <= 512 else { throw CancellationError() }
        next.token = reply.token
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
    func cancelPendingRequests() { pairingGeneration = UUID(); pendingSessions.values.forEach { $0.invalidateAndCancel() }; pendingSessions.removeAll() }
    func disconnect() { cancelPendingRequests(); restored = true; SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account] as CFDictionary); connection = nil }
    func synchronize(library: Library, base: Library?) async throws -> Library {
        guard let connection else { throw SyncError.rejected("Сначала подключи ПК.") }
        struct Request: Encodable { let library: Library; let base: Library? }
        struct Reply: Decodable { let library: Library }
        let reply: Reply = try await request(connection, path: "/sync", body: Request(library: library, base: base))
        guard reply.library.version == 1, reply.library.tracks.count <= 6000, reply.library.tracks.allSatisfy({ VideoID.isValid($0.key) && $0.key == $0.value.id }) else { throw SyncError.rejected("ПК прислал несовместимую библиотеку.") }
        return LibraryValidation.normalized(reply.library)
    }
    private func request<Body: Encodable, Reply: Decodable>(_ connection: PCConnection, path: String, body: Body) async throws -> Reply {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .millisecondsSince1970
        let data = try encoder.encode(body); guard data.count <= 8 * 1024 * 1024 else { throw SyncError.tooLarge }
        let delegate = PinnedPCSession(connection), config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 12; config.timeoutIntervalForResource = 20; config.allowsCellularAccess = false; config.waitsForConnectivity = false; config.networkServiceType = .background; config.httpShouldSetCookies = false
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
            throw SyncError.rejected((try? JSONDecoder().decode(Failure.self, from: bytes).error) ?? "ПК недоступен. Проверь сеть и разрешение брандмауэра.")
        }
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .millisecondsSince1970
        return try decoder.decode(Reply.self, from: bytes)
    }
}
