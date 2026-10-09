import SwiftUI
import FormaCore

@MainActor
struct PulseSettingsView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var export: URL?
    @State private var showLicenses = false
    @State private var preferredArtistText = ""
    @State private var excludedArtistText = ""
    private let genres = ["Electronic", "House", "Techno", "Hip-Hop/Rap", "Alternative", "Pop", "Ambient", "Jazz", "Rock", "R&B/Soul", "Lo-Fi", "Drum & Bass"]
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Твой Пульс. Твой выбор.").font(.largeTitle.bold())
                Text("Сохраняй любимое. Прослушивания и пропуски уточняют направление.").foregroundStyle(.secondary)
                Button("Больше новых имён") { model.configure { $0.discovery = 0.85; $0.explorationStyle = "nearby"; $0.artistDiversity = 1; $0.repeatHours = 24 } }.buttonStyle(.bordered)
                Button("На каждый день · 70/30") { model.configure({ $0.discovery = 0.7; $0.explorationStyle = "nearby"; $0.languagePreference = "ru"; $0.skipSensitivity = "strict"; $0.artistDiversity = 0.6 }, refreshCatalog: true) }.buttonStyle(.bordered)
                GlassPanel {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Новые имена, близкие тебе").font(.headline)
                        Picker("Насколько далеко искать", selection: Binding(get: { model.library.settings.explorationStyle }, set: { value in model.configure({ $0.explorationStyle = value }, refreshCatalog: true) })) {
                            Text("Рядом со вкусом").tag("nearby"); Text("Постепенно шире").tag("balanced"); Text("Смелее").tag("adventurous")
                        }
                        Picker("Язык музыки", selection: Binding(get: { model.library.settings.languagePreference }, set: { value in model.configure({ $0.languagePreference = value }, refreshCatalog: true) })) {
                            Text("Больше русской").tag("ru"); Text("Любой").tag("any"); Text("Больше английской").tag("en")
                        }
                        Picker("Ранние пропуски", selection: Binding(get: { model.library.settings.skipSensitivity }, set: { value in model.configure { $0.skipSensitivity = value } })) {
                            Text("Предлагать похожее реже").tag("strict"); Text("Не подходит сейчас").tag("soft")
                        }
                        Text("Влияние текущей сессии · \(Int(model.library.settings.sessionInfluence * 100))%").font(.subheadline)
                        Slider(value: Binding(get: { model.library.settings.sessionInfluence }, set: { value in model.configure { $0.sessionInfluence = value } }), in: 0...1, step: 0.05)
                        Text("Модель учится на дослушиваниях, сохранениях и пропусках. Доля открытий и расстояние от вкуса задаются отдельно; серии пропусков уменьшают эксперименты. Язык по названиям определяется приблизительно.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                GlassPanel {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Музыкальные направления").font(.headline)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 100))], spacing: 10) {
                            ForEach(genres, id: \.self) { genre in
                                Button {
                                    model.configure({ settings in
                                        if settings.genres.contains(genre) { settings.genres.removeAll { $0 == genre } }
                                        else { settings.genres.append(genre); settings.excludedGenres.removeAll { $0 == genre } }
                                    }, refreshCatalog: true)
                                } label: {
                                    Text(genre).font(.subheadline).frame(maxWidth: .infinity).padding(.vertical, 10)
                                        .background(model.library.settings.genres.contains(genre) ? FormaTheme.accent.opacity(0.22) : .white.opacity(0.04), in: Capsule())
                                }.buttonStyle(.plain).accessibilityAddTraits(model.library.settings.genres.contains(genre) ? .isSelected : [])
                            }
                        }
                        Toggle("Только выбранные жанры", isOn: Binding(get: { model.library.settings.genreMode == "strict" }, set: { value in model.configure { $0.genreMode = value ? "strict" : "prefer" } })).disabled(model.library.settings.genres.isEmpty)
                        DisclosureGroup("Исключить жанры") {
                            VStack(alignment: .leading) {
                                ForEach(genres, id: \.self) { genre in
                                    Toggle(genre, isOn: Binding(get: { model.library.settings.excludedGenres.contains(genre) }, set: { value in
                                        model.configure({ settings in
                                            settings.excludedGenres.removeAll { $0 == genre }
                                            if value { settings.excludedGenres.append(genre); settings.genres.removeAll { $0 == genre } }
                                        }, refreshCatalog: true)
                                    }))
                                }
                            }.padding(.top, 12)
                        }
                    }
                }
                GlassPanel {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Доля открытий · \(Int(model.library.settings.discovery * 100))%").font(.headline)
                        Slider(value: Binding(get: { model.library.settings.discovery }, set: { value in model.configure { $0.discovery = value } }), in: 0...1)
                        HStack { Text("Знакомое"); Spacer(); Text("Новое") }.font(.caption).foregroundStyle(.secondary)
                        Text("Разнообразие исполнителей").font(.headline)
                        Slider(value: Binding(get: { model.library.settings.artistDiversity }, set: { value in model.configure { $0.artistDiversity = value } }), in: 0...1)
                        Text("Больше расстояние между повторами артистов и больше новых имён. В маленьком каталоге повторы всё же возможны.").font(.footnote).foregroundStyle(.secondary)
                        Toggle("Включать сохранённые треки", isOn: Binding(get: { model.library.settings.includeLibrary }, set: { value in model.configure { $0.includeLibrary = value } }))
                        Picker("Не повторять треки", selection: Binding(get: { model.library.settings.repeatHours }, set: { value in model.configure { $0.repeatHours = value } })) {
                            Text("Без интервала").tag(0.0); Text("30 минут").tag(0.5); Text("2 часа").tag(2.0); Text("6 часов").tag(6.0); Text("Сутки").tag(24.0)
                        }
                        Picker("Настроение Пульса", selection: Binding(get: { model.library.settings.mood }, set: { value in model.configure { $0.mood = value } })) {
                            Text("Любое").tag("any"); ForEach(MoodMix.all.filter { $0.id != "night" }) { mix in Text(mix.title).tag(mix.id) }
                        }
                        Picker("Энергия", selection: Binding(get: { model.library.settings.energy }, set: { value in model.configure({ $0.energy = value }, refreshCatalog: true) })) {
                            Text("Любая").tag("any"); Text("Мягче").tag("low"); Text("Умеренно").tag("medium"); Text("Бодрее").tag("high")
                        }
                        Picker("Вокал", selection: Binding(get: { model.library.settings.vocals }, set: { value in model.configure({ $0.vocals = value }, refreshCatalog: true) })) {
                            Text("Любой").tag("any"); Text("Без вокала").tag("instrumental"); Text("С вокалом").tag("vocal")
                        }
                    }
                }
                GlassPanel {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Исполнители и библиотека").font(.headline)
                        TextField("Предпочитать артистов, через запятую", text: artistBinding(preferred: true), axis: .vertical).textFieldStyle(.roundedBorder).autocorrectionDisabled()
                        TextField("Исключить артистов, через запятую", text: artistBinding(preferred: false), axis: .vertical).textFieldStyle(.roundedBorder).autocorrectionDisabled()
                        Toggle("Учиться только по выбранным плейлистам", isOn: Binding(get: { model.library.settings.playlistSource == "selected" }, set: { value in model.configure({ $0.playlistSource = value ? "selected" : "all" }, refreshCatalog: true) }))
                        if model.library.settings.playlistSource == "selected" {
                            ForEach(model.library.playlists) { playlist in
                                Toggle(playlist.name, isOn: Binding(get: { model.library.settings.seedPlaylistIDs.contains(playlist.id) }, set: { value in
                                    model.configure({ settings in settings.seedPlaylistIDs.removeAll { $0 == playlist.id }; if value { settings.seedPlaylistIDs.append(playlist.id) } }, refreshCatalog: true)
                                }))
                            }
                            Text("Любимое и история тоже учитываются.").font(.footnote).foregroundStyle(.secondary)
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
            .onAppear { preferredArtistText = model.library.settings.preferredArtists.joined(separator: ", "); excludedArtistText = model.library.settings.excludedArtists.joined(separator: ", ") }
            .onChange(of: model.library.settings.preferredArtists) { _, names in if artistNames(preferredArtistText) != names { preferredArtistText = names.joined(separator: ", ") } }
            .onChange(of: model.library.settings.excludedArtists) { _, names in if artistNames(excludedArtistText) != names { excludedArtistText = names.joined(separator: ", ") } }
            .sheet(isPresented: $showLicenses) { NavigationStack { ScrollView { Text(licenses).font(.footnote.monospaced()).textSelection(.enabled).padding(20) }.navigationTitle("Открытый код").toolbar { Button("Закрыть") { showLicenses = false } } } }
    }
    private func artistBinding(preferred: Bool) -> Binding<String> {
        Binding(get: { preferred ? preferredArtistText : excludedArtistText }, set: { text in
            if preferred { preferredArtistText = text } else { excludedArtistText = text }
            let names = artistNames(text)
            model.configure({ settings in if preferred { settings.preferredArtists = Array(names.prefix(30)) } else { settings.excludedArtists = Array(names.prefix(30)) } }, refreshCatalog: preferred)
        })
    }
    private func artistNames(_ text: String) -> [String] {
        Array(text.components(separatedBy: ",").map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(100)) }.filter { !$0.isEmpty }.prefix(30))
    }
    private var licenses: String {
        guard let url = Bundle.main.url(forResource: "ThirdPartyNotices", withExtension: "txt"), let text = try? String(contentsOf: url, encoding: .utf8) else { return "YouTubeKit — Alexander Eichhorn, MIT. Полные лицензии находятся в исходниках Forma." }
        return text
    }
}
