import SwiftUI

@MainActor
struct SettingsView: View {
    @ObservedObject var model: AppModel
    @AppStorage("forma.palette") private var palette = "iris"
    @AppStorage("forma.showArtwork") private var showArtwork = true
    @State private var code = ""
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                GlassPanel {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Синхронизация с ПК").font(.title2.bold())
                        Text("Подключи iPhone и ПК к одной Wi-Fi сети. Открой в Forma на ПК «Настройки → Подключить iPhone».").foregroundStyle(.secondary)
                        TextField("Вставь код подключения", text: $code, axis: .vertical).textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                        Button { Task { await model.pairPC(code) } } label: { Label("Подключить", systemImage: "laptopcomputer.and.iphone") }.buttonStyle(.borderedProminent).disabled(model.isSyncing || code.isEmpty || !model.canSynchronizePC)
                        if model.pcHost != nil {
                            Button("Синхронизировать сейчас") { Task { await model.synchronize(showErrors: true) } }.buttonStyle(.bordered).disabled(model.isSyncing || !model.canSynchronizePC)
                            Button("Отключить ПК", role: .destructive) { Task { await model.disconnectPC() } }
                        }
                        if model.isSyncing { ProgressView("Переносим библиотеку…") }
                        Text(model.syncStatus).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Text("Избранное, плейлисты, история и основные настройки Пульса общие. Изменения без подключения сохраняются и отправятся при следующем соединении. Локальные файлы с ПК не переносятся.").font(.footnote).foregroundStyle(.secondary)
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
                GlassPanel { DisclosureGroup("Скорость воспроизведения") { PlaybackPerformanceView(player: model.player) } }
                NavigationLink { PulseSettingsView(model: model) } label: { Label("Настроить Пульс", systemImage: "slider.horizontal.3").font(.headline) }
                Text("Forma 1.1.1 · iOS 17+\nВоспроизведение работает через нативный плеер. YouTube должен быть доступен в твоей сети.").font(.footnote).foregroundStyle(.secondary)
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
