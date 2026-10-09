import Foundation

public struct LibraryDiskStore {
    public let url: URL
    public init(url: URL) { self.url = url }
    public func load() throws -> (library: Library, notice: String?) {
        guard FileManager.default.fileExists(atPath: url.path) else {
            let backup = url.appendingPathExtension("bak")
            if FileManager.default.fileExists(atPath: backup.path) {
                // Access failure is not an empty library. Preserve undecodable
                // backup bytes before a later save replaces the backup file.
                let bytes = try Data(contentsOf: backup)
                if let library = decode(bytes) { return (library, "Библиотека восстановлена из резервной копии.") }
                try bytes.write(to: backup.appendingPathExtension("unreadable-\(UUID().uuidString)"), options: writeOptions)
                return (Library(), "Резервная копия повреждена и сохранена отдельно, создан новый профиль.")
            }
            return (Library(), nil)
        }
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
            try original.write(to: url.appendingPathExtension("bak"), options: writeOptions)
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(library).write(to: url, options: writeOptions)
    }
    private func decode(_ data: Data) -> Library? {
        guard let library = try? JSONDecoder().decode(Library.self, from: data), library.version == 1 else { return nil }
        return LibraryValidation.normalized(library)
    }
    private var writeOptions: Data.WritingOptions {
#if os(iOS)
        return [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
#else
        return .atomic
#endif
    }
}
