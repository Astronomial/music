import SwiftUI
import FormaCore

@MainActor
struct PulseSettingsView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var export: URL?
    @State private var showLicenses = false
    private let genres = ["Electronic", "Rock", "Pop", "Hip-Hop", "House", "Jazz", "Ambient", "R&B", "Metal", "Indie", "Classical"]
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Твой Пульс. Твой выбор.").font(.largeTitle.bold())
                Text("Сохраняй любимое. Прослушивания и пропуски уточняют направление.").foregroundStyle(.secondary)
                GlassPanel {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Музыкальные направления").font(.headline)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 100))], spacing: 10) {
                            ForEach(genres, id: \.self) { genre in
                                Button {
                                    model.configure({ settings in
                                        if settings.genres.contains(genre) { settings.genres.removeAll { $0 == genre } }
                                        else { settings.genres.append(genre) }
                                    }, refreshCatalog: true)
                                } label: {
                                    Text(genre).font(.subheadline).frame(maxWidth: .infinity).padding(.vertical, 10)
                                        .background(model.library.settings.genres.contains(genre) ? FormaTheme.accent.opacity(0.22) : .white.opacity(0.04), in: Capsule())
                                }.buttonStyle(.plain).accessibilityAddTraits(model.library.settings.genres.contains(genre) ? .isSelected : [])
                            }
                        }
                    }
                }
                GlassPanel {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Место для открытий").font(.headline)
                        Slider(value: Binding(get: { model.library.settings.discovery }, set: { value in model.configure { $0.discovery = value } }), in: 0...1)
                        HStack { Text("Знакомое"); Spacer(); Text("Новое") }.font(.caption).foregroundStyle(.secondary)
                        Picker("Не повторять треки", selection: Binding(get: { model.library.settings.repeatHours }, set: { value in model.configure { $0.repeatHours = value } })) {
                            Text("Без интервала").tag(0.0); Text("30 минут").tag(0.5); Text("2 часа").tag(2.0); Text("6 часов").tag(6.0); Text("Сутки").tag(24.0)
                        }
                        Picker("Настроение Пульса", selection: Binding(get: { model.library.settings.mood }, set: { value in model.configure { $0.mood = value } })) {
                            Text("Любое").tag("any"); ForEach(MoodMix.all) { mix in Text(mix.title).tag(mix.id) }
                        }
                    }
                }
                Text("Все подборки используют общий вкус. Настроение определяется по направлению поиска, поэтому соответствие может быть неточным.").font(.footnote).foregroundStyle(.secondary)
                Button("Экспортировать библиотеку") { do { export = try model.exportLibrary() } catch { model.message = error.localizedDescription } }.buttonStyle(.bordered)
                if let export { ShareLink(item: export) { Label("Поделиться файлом", systemImage: "square.and.arrow.up") } }
                Button("Авторы и лицензии") { showLicenses = true }.font(.subheadline)
            }.padding(20)
        }.background(FormaTheme.background).navigationTitle("Настройка Пульса").navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Готово") { dismiss() } }
            .sheet(isPresented: $showLicenses) { NavigationStack { ScrollView { Text(licenses).font(.footnote.monospaced()).textSelection(.enabled).padding(20) }.navigationTitle("Открытый код").toolbar { Button("Закрыть") { showLicenses = false } } } }
    }
    private var licenses: String {
        guard let url = Bundle.main.url(forResource: "ThirdPartyNotices", withExtension: "txt"), let text = try? String(contentsOf: url, encoding: .utf8) else { return "YouTubeKit — Alexander Eichhorn, MIT. Полные лицензии находятся в исходниках Forma." }
        return text
    }
}
