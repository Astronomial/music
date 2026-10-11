import Foundation

public struct SyncChangeSummary: Codable, Sendable {
    public let likesAdded: Int, likesRemoved: Int, dislikesAdded: Int, dislikesRemoved: Int
    public let hiddenAdded: Int, hiddenRemoved: Int, playlistsAdded: Int, playlistsRemoved: Int, playlistsChanged: Int
    public let tracksAdded: Int, settingsChanged: Int, soundProfilesChanged: Int, historyAdded: Int, historyRemoved: Int
    public let details: [String]
    private var allRows: [(String, Int)] {
        [("Новые лайки", likesAdded), ("Снять лайки", likesRemoved), ("Новые дизлайки", dislikesAdded), ("Снять дизлайки", dislikesRemoved), ("Скрыть треки", hiddenAdded), ("Вернуть скрытые треки", hiddenRemoved), ("Новые плейлисты", playlistsAdded), ("Удалить плейлисты", playlistsRemoved), ("Изменить плейлисты", playlistsChanged), ("Новые треки", tracksAdded), ("Настройки Пульса", settingsChanged), ("Профили звучания", soundProfilesChanged), ("Добавить события истории", historyAdded), ("Удалить события истории", historyRemoved)]
    }
    public var rows: [(String, Int)] { allRows.filter { $0.1 > 0 } }
    var isValid: Bool { allRows.allSatisfy { (0...30000).contains($0.1) } && details.count <= 10 && details.allSatisfy { $0.count <= 1000 } }
}
public struct WiFiProposal: Codable, Sendable, Identifiable {
    public enum Status: String, Codable, Sendable { case pending, committing, approved, rejected, stale }
    public struct Summary: Codable, Sendable { public let toPC: SyncChangeSummary, toPhone: SyncChangeSummary }
    public let protocolVersion: Int
    public let id: String
    public let status: Status
    public let createdAt: Double, expiresAt: Double
    public let summary: Summary
    public let library: Library?
    public func validated(expectedID: String) throws -> WiFiProposal {
        guard protocolVersion == 2, id == expectedID, UUID(uuidString: id) != nil,
              [summary.toPC, summary.toPhone].allSatisfy({ $0.isValid }),
              status != .approved || library != nil,
              library.map({ $0.version == 1 && $0.tracks.count <= 6000 && $0.tracks.allSatisfy { VideoID.isValid($0.key) && $0.key == $0.value.id } }) ?? true else { throw WiFiExchangeError.invalidProposal }
        return self
    }
}
public struct WiFiCheckpoint: Codable, Sendable {
    public let id: String, peerID: String
    public let sent: Library
    public let base: Library?
    public var applied: Bool
    public init(peerID: String, sent: Library, base: Library?) { id = UUID().uuidString.lowercased(); self.peerID = peerID; self.sent = sent; self.base = base; applied = false }
    public func mergingApproved(_ proposal: WiFiProposal, into current: Library) throws -> Library {
        let checked = try proposal.validated(expectedID: id)
        guard checked.status == .approved, let incoming = checked.library else { throw WiFiExchangeError.notApproved }
        return LibrarySync.merge(current: LibrarySync.preservingLearning(in: LibraryValidation.normalized(incoming), from: sent), base: sent, incoming: current)
    }
}
public enum WiFiExchangeError: LocalizedError, Equatable {
    case invalidProposal, notApproved
    public var errorDescription: String? { self == .notApproved ? "Пакет ещё не подтверждён. Библиотека не изменена." : "ПК прислал несовместимый пакет. Обнови Forma на обоих устройствах." }
}
