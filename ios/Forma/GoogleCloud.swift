import AuthenticationServices
import CryptoKit
import Foundation
import Security
import SwiftUI
import FormaCore

private final class GoogleNetworkPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
private struct GoogleCredentials: Codable, Sendable {
    var clientID: String; var sub: String; var email: String; var refreshToken: String; var accessToken: String; var expires: Date
}
private struct GoogleToken: Decodable, Sendable { let access_token: String; let expires_in: Double?; let refresh_token: String? }
struct GoogleExchange: Sendable { let library: Library; let document: CloudDocument; let files: [GoogleFile]; let sub: String; let epoch: UUID }
struct GoogleFile: Codable, Sendable { var id: String; var appProperties: [String: String]? }

actor GoogleCloudClient {
    private var credentials: GoogleCredentials?
    private var restored = false
    private var epoch = UUID()
    private var refreshing: Task<GoogleToken, Error>?
    private let policy = GoogleNetworkPolicy()
    private let session: URLSession
    private struct Saved: Codable { var document: CloudDocument; var base: Library? }
    private var saved: Saved?
    private var savedSub: String?
    private var exchanging = false
    init() {
        let config = URLSessionConfiguration.ephemeral
        config.allowsCellularAccess = true; config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 30
        config.httpMaximumConnectionsPerHost = 2
        session = URLSession(configuration: config, delegate: policy, delegateQueue: nil)
    }
    private static func keychain(_ data: Data? = nil, remove: Bool = false) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "music.forma.google", kSecAttrAccount as String: "oauth"]
        if remove { let s = SecItemDelete(query as CFDictionary); guard s == errSecSuccess || s == errSecItemNotFound else { throw GoogleError.message("Не удалось удалить подключение Google") }; return nil }
        if let data {
            let changes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
            var s = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
            if s == errSecItemNotFound { s = SecItemAdd(query.merging(changes) { _, b in b } as CFDictionary, nil) }
            guard s == errSecSuccess else { throw GoogleError.message("Не удалось сохранить вход в защищённом хранилище") }; return nil
        }
        var q = query; q[kSecReturnData as String] = true; var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw GoogleError.message("Защищённое хранилище Google пока недоступно") }; return data
    }
    func restore() async throws -> String? {
        if !restored {
            let generation = epoch
            let raw = try await Task.detached(priority: .utility) { try Self.keychain() }.value
            guard generation == epoch else { return credentials?.email }
            credentials = try raw.map { try JSONDecoder().decode(GoogleCredentials.self, from: $0) }; restored = true
        }
        return credentials?.email
    }
    func disconnect() throws { try Self.keychain(remove: true); credentials = nil; restored = true; saved = nil; savedSub = nil; epoch = UUID(); refreshing?.cancel(); refreshing = nil }
    private static func form(_ fields: [String: String]) -> Data {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return Data(fields.sorted { $0.key < $1.key }.map { ($0.key.addingPercentEncoding(withAllowedCharacters: allowed) ?? "") + "=" + ($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "") }.joined(separator: "&").utf8)
    }
    private func json(_ request: URLRequest) async throws -> Data {
        try await BoundedHTTPData(limit: 12 * 1024 * 1024).load(request)
    }
    private func token(_ fields: [String: String]) async throws -> GoogleToken {
        var req = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!); req.httpMethod = "POST"; req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type"); req.httpBody = Self.form(fields)
        return try JSONDecoder().decode(GoogleToken.self, from: await json(req))
    }
    func connect(clientID: String, code: String, verifier: String, redirect: String) async throws -> String {
        let generation = UUID(); epoch = generation
        let t = try await token(["client_id": clientID, "code": code, "code_verifier": verifier, "redirect_uri": redirect, "grant_type": "authorization_code"])
        guard let refresh = t.refresh_token, !refresh.isEmpty else { throw GoogleError.message("Google не выдал разрешение на фоновую синхронизацию") }
        var req = URLRequest(url: URL(string: "https://openidconnect.googleapis.com/v1/userinfo")!); req.setValue("Bearer " + t.access_token, forHTTPHeaderField: "Authorization")
        struct Profile: Decodable { let sub: String; let email: String? }
        let profile = try JSONDecoder().decode(Profile.self, from: await json(req))
        guard profile.sub.range(of: "^[0-9]{5,50}$", options: .regularExpression) != nil, epoch == generation else { throw CancellationError() }
        let c = GoogleCredentials(clientID: clientID, sub: profile.sub, email: profile.email ?? "Google", refreshToken: refresh, accessToken: t.access_token, expires: Date().addingTimeInterval(t.expires_in ?? 3600))
        try Self.keychain(JSONEncoder().encode(c)); credentials = c; restored = true; saved = nil; savedSub = nil; return c.email
    }
    private func request(_ url: URL, method: String = "GET", body: Data? = nil, contentType: String? = nil) async throws -> Data {
        guard url.scheme == "https", url.host == "www.googleapis.com", var c = credentials else { throw GoogleError.message("Войди в Google в настройках") }
        let generation = epoch
        if c.expires.timeIntervalSinceNow < 60 {
            let work: Task<GoogleToken, Error>
            if let task = refreshing { work = task } else { let fields = ["client_id": c.clientID, "refresh_token": c.refreshToken, "grant_type": "refresh_token"]; work = Task { try await self.token(fields) }; refreshing = work }
            do { let t = try await work.value; guard epoch == generation else { throw CancellationError() }; c.accessToken = t.access_token; c.expires = Date().addingTimeInterval(t.expires_in ?? 3600); try Self.keychain(JSONEncoder().encode(c)); credentials = c; refreshing = nil }
            catch { refreshing = nil; throw error }
        }
        guard epoch == generation else { throw CancellationError() }
        var req = URLRequest(url: url); req.networkServiceType = .background; req.httpMethod = method; req.httpBody = body; req.setValue("Bearer " + c.accessToken, forHTTPHeaderField: "Authorization"); if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }; return try await json(req)
    }
    private func url(_ path: String, query: [String: String] = [:], upload: Bool = false) -> URL {
        var u = URLComponents(string: "https://www.googleapis.com/" + (upload ? "upload/" : "") + "drive/v3/" + path)!
        u.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }; return u.url!
    }
    private func stateURL(_ sub: String) throws -> URL {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]; try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("forma-google-" + sub + ".json")
    }
    private func save(_ state: Saved, sub: String) throws {
        let e = JSONEncoder(); e.dateEncodingStrategy = .millisecondsSince1970; let data = try e.encode(state); guard data.count <= 16 * 1024 * 1024 else { throw GoogleError.message("Библиотека превышает лимит облачного обмена") }
        let file = try stateURL(sub); if FileManager.default.fileExists(atPath: file.path) { try? FileManager.default.removeItem(at: file.appendingPathExtension("bak")); try FileManager.default.copyItem(at: file, to: file.appendingPathExtension("bak")) }
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]); saved = state; savedSub = sub
    }
    func exchange(_ library: Library) async throws -> GoogleExchange {
        guard !exchanging else { throw CancellationError() }; exchanging = true; defer { exchanging = false }
        guard let c = credentials else { throw GoogleError.message("Войди в Google") }; let generation = epoch
        if savedSub != c.sub {
            let file = try stateURL(c.sub), d = JSONDecoder(); d.dateDecodingStrategy = .millisecondsSince1970
            if FileManager.default.fileExists(atPath: file.path) {
                do { saved = try d.decode(Saved.self, from: Data(contentsOf: file)) }
                catch { saved = try d.decode(Saved.self, from: Data(contentsOf: file.appendingPathExtension("bak"))) }
            } else { saved = Saved(document: CloudDocument(), base: nil) }; savedSub = c.sub
        }
        guard let local = saved else { throw GoogleError.message("Не удалось открыть состояние облака") }
        var document = try local.document.capturing(library, base: local.base)
        try save(Saved(document: document, base: library), sub: c.sub)
        struct List: Decodable { let nextPageToken: String?; let files: [GoogleFile] }
        var files: [GoogleFile] = [], page = ""
        repeat {
            var query = ["spaces": "appDataFolder", "q": "trashed = false and appProperties has { key='formaSchema' and value='2' }", "fields": "nextPageToken,files(id,appProperties)", "pageSize": "100"]
            if !page.isEmpty { query["pageToken"] = page }
            let list = try JSONDecoder().decode(List.self, from: await request(url("files", query: query))); files += list.files; page = list.nextPageToken ?? ""
            guard files.count <= 100 else { throw GoogleError.message("Слишком много устройств в облачной библиотеке") }
        } while !page.isEmpty
        for f in files {
            guard f.id.range(of: "^[A-Za-z0-9_-]{5,200}$", options: .regularExpression) != nil else { throw GoogleError.message("Некорректный файл Google") }
            let data = try await request(url("files/" + f.id, query: ["alt": "media"]))
            document = try document.merging(JSONDecoder().decode(CloudDocument.self, from: data)); try Task.checkCancellation()
        }
        guard epoch == generation else { throw CancellationError() }
        document = try document.publishing()
        return GoogleExchange(library: try document.library(), document: document, files: files, sub: c.sub, epoch: generation)
    }
    // Called only after AppModel has durably saved the received library.
    func commit(_ exchange: GoogleExchange) async throws {
        guard epoch == exchange.epoch, credentials?.sub == exchange.sub else { throw CancellationError() }
        try save(Saved(document: exchange.document, base: exchange.library), sub: exchange.sub)
        let body = try JSONEncoder().encode(exchange.document); guard body.count <= 12 * 1024 * 1024 else { throw GoogleError.message("Облачная библиотека превышает 12 МБ") }
        if let own = exchange.files.first(where: { $0.appProperties?["actor"] == exchange.document.actor }) {
            _ = try await request(url("files/" + own.id, query: ["uploadType": "media", "fields": "id"], upload: true), method: "PATCH", body: body, contentType: "application/json")
        } else {
            let actor = exchange.document.actor, boundary = "forma_" + actor.replacingOccurrences(of: "-", with: "")
            let metadata: [String: Any] = ["name": "forma-device-" + actor + ".json", "parents": ["appDataFolder"], "appProperties": ["formaSchema": "2", "actor": actor]]
            var data = Data("--\(boundary)\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".utf8); data += try JSONSerialization.data(withJSONObject: metadata)
            data += Data("\r\n--\(boundary)\r\nContent-Type: application/json\r\n\r\n".utf8); data += body; data += Data("\r\n--\(boundary)--\r\n".utf8)
            _ = try await request(url("files", query: ["uploadType": "multipart", "fields": "id"], upload: true), method: "POST", body: data, contentType: "multipart/related; boundary=" + boundary)
        }
    }
}

enum GoogleError: LocalizedError { case message(String); var errorDescription: String? { if case .message(let s) = self { return s }; return nil } }

@MainActor
final class GoogleAccount: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    @Published var email: String?
    @Published var busy = false
    @Published var error: String?
    let client = GoogleCloudClient()
    private var session: ASWebAuthenticationSession?
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
    func restore() async { do { email = try await client.restore() } catch { self.error = error.localizedDescription } }
    func login(_ input: String) async throws {
        let clientID = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard clientID.range(of: "^[0-9]+-[A-Za-z0-9_-]+\\.apps\\.googleusercontent\\.com$", options: .regularExpression) != nil else { throw GoogleError.message("Укажи iOS Client ID из того же Google Cloud проекта, что и на ПК") }
        guard !busy else { return }; busy = true; defer { busy = false; session = nil }
        let state = UUID().uuidString, verifier = UUID().uuidString + UUID().uuidString
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let scheme = "com.googleusercontent.apps." + clientID.replacingOccurrences(of: ".apps.googleusercontent.com", with: ""), redirect = scheme + ":/oauth2redirect"
        var url = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        let params = ["client_id": clientID, "redirect_uri": redirect, "response_type": "code", "scope": "openid email https://www.googleapis.com/auth/drive.appdata", "state": state, "code_challenge": challenge, "code_challenge_method": "S256", "access_type": "offline", "prompt": "consent select_account"]
        url.queryItems = params.map { URLQueryItem(name: $0.key, value: $0.value) }
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let flow = ASWebAuthenticationSession(url: url.url!, callbackURLScheme: scheme) { callback, error in
                if let error { continuation.resume(throwing: error) } else if let callback { continuation.resume(returning: callback) } else { continuation.resume(throwing: GoogleError.message("Google не вернул результат входа")) }
            }
            flow.presentationContextProvider = self; flow.prefersEphemeralWebBrowserSession = false; session = flow
            if !flow.start() { continuation.resume(throwing: GoogleError.message("Не удалось открыть вход в Google")) }
        }
        let fields = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard fields.first(where: { $0.name == "state" })?.value == state, let code = fields.first(where: { $0.name == "code" })?.value else { throw GoogleError.message("Вход отменён или ответ Google не прошёл проверку") }
        email = try await client.connect(clientID: clientID, code: code, verifier: verifier, redirect: redirect); self.error = nil
        UserDefaults.standard.set(clientID, forKey: "forma.googleClientID")
    }
    func logout() async throws { try await client.disconnect(); email = nil; error = nil }
}
