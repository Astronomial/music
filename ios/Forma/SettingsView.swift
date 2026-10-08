import SwiftUI

@MainActor
struct SettingsView: View {
    @ObservedObject var model: AppModel
    @AppStorage("forma.palette") private var palette = "iris"
    @State private var code = ""
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                GlassPanel {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Синхронизация с ПК").font(.title2.bold())
                        Text("Подключи iPhone и ПК к одной Wi-Fi сети. Открой в Forma на ПК «Настройки → Подключить iPhone».").foregroundStyle(.secondary)
                        TextField("Вставь код подключения", text: $code, axis: .vertical).textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                        Button { Task { await model.pairPC(code) } } label: { Label("Подключить", systemImage: "laptopcomputer.and.iphone") }.buttonStyle(.borderedProminent).disabled(model.isSyncing || code.isEmpty)
                        if model.pcHost != nil {
                            Button("Синхронизировать сейчас") { Task { await model.synchronize(showErrors: true) } }.buttonStyle(.bordered).disabled(model.isSyncing)
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
                NavigationLink { PulseSettingsView(model: model) } label: { Label("Настроить Пульс", systemImage: "slider.horizontal.3").font(.headline) }
                Text("Forma · iOS 17+\nВоспроизведение работает через нативный плеер. YouTube должен быть доступен в твоей сети.").font(.footnote).foregroundStyle(.secondary)
            }.padding(20)
        }.background(FormaTheme.background).navigationTitle("Настройки")
    }
}
