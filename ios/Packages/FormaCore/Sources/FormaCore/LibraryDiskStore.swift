import Foundation

public struct LibraryDiskStore {
    public let url: URL
    public init(url: URL) { self.url = url }
    public func load() throws -> (library: Library, notice: String?) {
        guard FileManager.default.fileExists(atPath: url.path) else { return (Library(), nil) }
        let original = try Data(contentsOf: url)
        if let library = decode(original) { return (library, nil) }
        // Preserve the original even if recovery falls back to an empty profile.
        let archived = url.appendingPathExtension("unreadable-\(UUID().uuidString)")
        try original.write(to: archived, options: .atomic)
        if let backup = try? Data(contentsOf: url.appendingPathExtension("bak")), let library = decode(backup) {
            return (library, "Библиотека восстановлена из резервной копии. Повреждённый файл сохранён отдельно.")
        }
        return (Library(), "Не удалось прочитать библиотеку. Исходный файл сохранён отдельно, создан новый профиль.")
    }
    public func save(_ library: Library) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let original = try? Data(contentsOf: url), decode(original) != nil {
            try original.write(to: url.appendingPathExtension("bak"), options: .atomic)
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(library).write(to: url, options: .atomic)
    }
    private func decode(_ data: Data) -> Library? {
        guard let library = try? JSONDecoder().decode(Library.self, from: data), library.version == 1 else { return nil }
        return library
    }
}
