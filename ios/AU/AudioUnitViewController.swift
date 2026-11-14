import CoreAudioKit
import UIKit
import UniformTypeIdentifiers

/// The plugin's window: a bar (firmware, settings, status) over the FM-1's front panel. Also the
/// extension's factory: hosts ask it for the audio unit.
public final class AudioUnitViewController: AUViewController, AUAudioUnitFactory, UIDocumentPickerDelegate {
    private var unit: FM1AudioUnit?
    private let panel = PanelView(frame: .zero)
    private let firmwareButton = UIButton(type: .system)
    private let settingsButton = UIButton(type: .system)
    private let statusLabel = UILabel()
    private var timer: Timer?
    private var lastStarved: UInt64 = 0
    private let amber = UIColor(red: 1.0, green: 0.71, blue: 0.28, alpha: 1)

    public func createAudioUnit(with componentDescription: AudioComponentDescription) throws -> AUAudioUnit {
        let au = try FM1AudioUnit(componentDescription: componentDescription, options: [])
        unit = au
        DispatchQueue.main.async { [weak self] in self?.connect() }
        return au
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        preferredContentSize = CGSize(width: 1100, height: 780)

        for b in [firmwareButton, settingsButton] {
            var c = UIButton.Configuration.filled()
            c.baseBackgroundColor = b === firmwareButton ? amber : UIColor(white: 0.2, alpha: 1)
            c.baseForegroundColor = b === firmwareButton ? .black : .white
            c.cornerStyle = .medium
            c.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { a in
                var a = a
                a.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
                return a
            }
            b.configuration = c
            b.showsMenuAsPrimaryAction = true
        }
        firmwareButton.setTitle("Firmware", for: .normal)
        settingsButton.setTitle("Settings", for: .normal)
        statusLabel.textColor = .white
        statusLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 15, weight: .medium)
        statusLabel.adjustsFontSizeToFitWidth = true
        statusLabel.minimumScaleFactor = 0.7
        statusLabel.text = "Starting…"

        let bar = UIStackView(arrangedSubviews: [firmwareButton, settingsButton, statusLabel])
        bar.axis = .horizontal
        bar.spacing = 12
        bar.alignment = .center
        let stack = UIStackView(arrangedSubviews: [bar, panel])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -8),
            stack.topAnchor.constraint(equalTo: g.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -8),
            bar.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
        connect()
    }

    private func connect() {
        guard isViewLoaded, let unit else { return }
        panel.engine = unit.engine
        panel.currentPot = { [weak unit] in Int(unit?.status().pot ?? 900) }
        panel.onPot = { [weak unit] v in unit?.setParameter(.master, Float(v) / 1023) }
        unit.onChange = { [weak self] in self?.refreshMenus() }
        refreshMenus()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refreshStatus() }
    }

    public override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        timer?.invalidate()
        timer = nil
    }

    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if timer == nil, unit != nil { connect() }
    }

    // ---------------------------------------------------------------- the bar

    private func refreshStatus() {
        guard let unit else { return }
        let s = unit.status()
        let late = s.starved > lastStarved && lastStarved > 0
        lastStarved = s.starved
        var parts = [unit.firmwareName.isEmpty ? "No firmware" : unit.firmwareName, "\(s.mhz) MHz"]
        if let err = unit.lastError { parts.append(err) }
        else if s.halted { parts.append("the emulated CPU halted") }
        else if s.speed > 0 { parts.append(String(format: "%.1f× real time", s.speed)) }
        if late { parts.append("falling behind: lower the clock") }
        if unit.value(.layout) >= 0.5 {
            parts.append("octave \(s.octave >= 0 ? "+" : "")\(s.octave)\(s.panel_keys ? " · FM-1 keys" : "")")
        }
        statusLabel.text = parts.joined(separator: " · ")
        statusLabel.textColor = late || s.halted || unit.lastError != nil ? amber : .white
    }

    private func refreshMenus() {
        guard let unit else { return }
        // firmware: the packages shared with the app, the bundled FM-1 SID, a file
        var items: [UIMenuElement] = RomFolder.list().map { url in
            UIAction(title: url.deletingPathExtension().lastPathComponent,
                     state: url.deletingPathExtension().lastPathComponent == unit.firmwareName ? .on : .off) { [weak self] _ in
                self?.load(url)
            }
        }
        if let sid = Bundle(for: FM1AudioUnit.self).url(forResource: "sidplayer", withExtension: "fwsc") {
            items.append(UIAction(title: "FM-1 SID (built in)", state: unit.firmwareName == "FM-1 SID" ? .on : .off) { [weak self] _ in
                guard let data = try? Data(contentsOf: sid) else { return }
                self?.unit?.boot(package: data, name: "FM-1 SID")
            })
        }
        let library = UIMenu(title: "", options: .displayInline, children: items)
        let open = UIAction(title: "Open a .fwsc file…", image: UIImage(systemName: "folder")) { [weak self] _ in self?.pick() }
        let hint = UIAction(title: "More firmwares: download them in the FM-1 app", attributes: .disabled) { _ in }
        firmwareButton.menu = UIMenu(title: "Firmware", children: [library, open, hint])
        firmwareButton.setTitle(unit.firmwareName.isEmpty ? "Firmware" : unit.firmwareName, for: .normal)

        func choice(_ title: String, _ p: FM1AudioUnit.Param, _ labels: [String]) -> UIMenu {
            let now = Int(unit.value(p).rounded())
            return UIMenu(title: title, children: labels.enumerated().map { i, label in
                UIAction(title: label, state: i == now ? .on : .off) { [weak self] _ in
                    self?.unit?.setParameter(p, Float(i))
                    self?.refreshMenus()
                }
            })
        }
        let keysOn = unit.value(.panelKeys) >= 0.5
        settingsButton.menu = UIMenu(title: "Settings", children: [
            choice("CPU clock", .clock, FM1AudioUnit.clocks.map { "\($0) MHz" }),
            choice("Controller layout", .layout, FM1AudioUnit.layouts),
            UIAction(title: "Notes play the FM-1's own keys (F3–G5)", state: keysOn ? .on : .off) { [weak self] _ in
                self?.unit?.setParameter(.panelKeys, keysOn ? 0 : 1)
                self?.refreshMenus()
            },
            choice("MIDI channel", .channel, ["As sent"] + (1...16).map { "Channel \($0)" }),
            choice("Latency (reload the plugin to apply)", .latency, ["Low (6 ms)", "Medium (12 ms)", "Safe (23 ms)"]),
            UIAction(title: "Send the Launchpad its layout again", image: UIImage(systemName: "square.grid.3x3")) { [weak self] _ in
                self?.unit?.resendLayout()
            },
        ])
        refreshStatus()
    }

    private func load(_ url: URL) {
        guard let data = try? Data(contentsOf: url) else { return }
        unit?.boot(package: data, name: url.deletingPathExtension().lastPathComponent)
    }

    // ---------------------------------------------------------------- a file from Files

    private func pick() {
        let types = [UTType(filenameExtension: "fwsc"), .data].compactMap { $0 }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
        picker.delegate = self
        present(picker, animated: true)
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first, let data = try? Data(contentsOf: url) else { return }
        let name = url.deletingPathExtension().lastPathComponent
        RomFolder.save(name: name, data: data)            // (kept for next time, beside the app's)
        unit?.boot(package: data, name: name) { [weak self] err in
            if err != nil { self?.statusLabel.text = "\(name): not a firmware package (\(err!))" }
            self?.refreshMenus()
        }
    }
}
