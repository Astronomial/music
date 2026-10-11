import SwiftUI

@MainActor
struct SettingsView: View {
    @ObservedObject var model: AppModel
    @AppStorage("forma.palette") private var palette = "iris"
    @AppStorage("forma.showArtwork") private var showArtwork = true
    @AppStorage("forma.soundAnalysis") private var soundAnalysis = true
    @AppStorage("forma.soundCellular") private var soundCellular = true
    @State private var code = ""
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                GoogleSettingsView(model: model, account: model.google)
                GlassPanel {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Твой цвет").font(.headline)
                        Picker("Палитра", selection: $palette) {
                            Text("Ирис").tag("iris"); Text("Мята").tag("mint"); Text("Закат").tag("sunset"); Text("Лёд").tag("ice")
                        }.pickerStyle(.segmented)
                    }
                }
                GlassPanel {
                    Toggle("Показывать обложки", isOn: $showArtwork)
                        .onChange(of: showArtwork) { _, _ in model.player.refreshArtworkPreference() }
                }
                GlassPanel {
                    VStack(alignment: .leading, spacing: 12) {
                        Toggle("Анализировать звучание", isOn: $soundAnalysis).onChange(of: soundAnalysis) { _, _ in model.soundPolicyChanged() }
                        Toggle("Анализ по мобильной сети", isOn: $soundCellular).disabled(!soundAnalysis).onChange(of: soundCellular) { _, _ in model.soundPolicyChanged() }
                        Text("Пульс сравнивает спектр, темп, динамику и ритм. До 6 МБ на трек, 12 треков в час; временное аудио удаляется после обработки. Проанализировано: \(model.library.tracks.values.filter { $0.soundProfile != nil }.count)").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                GlassPanel { DisclosureGroup("Скорость воспроизведения") { PlaybackPerformanceView(player: model.player) } }
                NavigationLink { PulseSettingsView(model: model) } label: { Label("Настроить Пульс", systemImage: "slider.horizontal.3").font(.headline) }
                Text("Forma 1.2.0 · iOS 17+\nВоспроизведение работает через нативный плеер. YouTube должен быть доступен в твоей сети.").font(.footnote).foregroundStyle(.secondary)
            }.padding(20)
        }.background(FormaTheme.background).navigationTitle("Настройки")
    }
}

@MainActor
private struct PlaybackPerformanceView: View {
    @ObservedObject var player: PlaybackController
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let last = player.measurements.last {
                Text(last.title).font(.subheadline).lineLimit(2)
                Text("Последний старт: \(last.totalMilliseconds / 1000, specifier: "%.2f") с").font(.headline).monospacedDigit()
                Text("Получение потока: \(last.resolutionMilliseconds / 1000, specifier: "%.2f") с · буфер: \(last.bufferMilliseconds / 1000, specifier: "%.2f") с").font(.footnote).foregroundStyle(.secondary)
                ShareLink(item: player.performanceReport) { Label("Поделиться замерами", systemImage: "square.and.arrow.up") }
            } else { Text("Выбери несколько треков, чтобы увидеть время запуска.").font(.subheadline) }
            Text("Для сравнения с ПК выбирай одинаковые треки в одной Wi-Fi сети. Загрузка нового и заранее подготовленного трека измеряется отдельно.").font(.footnote).foregroundStyle(.secondary)
        }.padding(.top, 12)
    }
}

@MainActor
private struct GoogleSettingsView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var account: GoogleAccount
    @AppStorage("forma.googleClientID") private var clientID = ""
    var body: some View {
        GlassPanel {
            VStack(alignment: .leading, spacing: 16) {
                Text("Синхронизация через Google").font(.title2.bold())
                Text("Один аккаунт на iPhone и Windows. Плейлисты, лайки, дизлайки, история, настройки Пульса и анализ звучания доступны через интернет. ПК может быть выключен.").foregroundStyle(.secondary)
                if let email = account.email {
                    Text(email).font(.headline)
                    Button("Синхронизировать сейчас") { Task { await model.synchronize(showErrors: true) } }.buttonStyle(.borderedProminent).disabled(model.isSyncing)
                    Button("Выйти из Google", role: .destructive) { Task { await model.logoutGoogle() } }.disabled(account.busy)
                } else {
                    DisclosureGroup("Настройка Google Cloud") {
                        Text("Создай OAuth-клиенты Desktop и iOS в одном проекте и включи Google Drive API. На iPhone нужен iOS Client ID.").font(.subheadline)
                        TextField("iOS Client ID", text: $clientID).textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                        Link("Открыть инструкцию", destination: URL(string: "https://github.com/Astronomial/music/blob/main/docs/GOOGLE_SYNC.md")!)
                    }
                    Button("Войти через Google") { Task { await model.loginGoogle(clientID) } }.buttonStyle(.borderedProminent).disabled(clientID.isEmpty || account.busy || model.isRestoringLibrary)
                }
                if model.isSyncing || account.busy { ProgressView("Подключаемся…") }
                if let error = account.error { Text(error).font(.footnote).foregroundStyle(.secondary) }
                Text(model.syncStatus).font(.footnote).foregroundStyle(.secondary)
                Text("Файлы музыки не загружаются в Drive. Изменения без интернета сохраняются на устройстве и отправятся позже.").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }
}
