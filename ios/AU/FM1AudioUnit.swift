import AVFoundation
import AudioToolbox
import CoreAudioKit

/// What the render block needs, reachable without touching the Swift object graph on the audio
/// thread: the engine and buffers made before rendering starts.
final class RenderState {
    let engine: OpaquePointer
    var midiOut: AUMIDIOutputEventBlock?
    let scratchL: UnsafeMutablePointer<Float>
    let scratchR: UnsafeMutablePointer<Float>
    let outBuf: UnsafeMutablePointer<UInt8>
    static let maxFrames = 8192
    static let outCap = 4096

    init(engine: OpaquePointer) {
        self.engine = engine
        scratchL = .allocate(capacity: Self.maxFrames)
        scratchR = .allocate(capacity: Self.maxFrames)
        outBuf = .allocate(capacity: Self.outCap)
        scratchL.initialize(repeating: 0, count: Self.maxFrames)
        scratchR.initialize(repeating: 0, count: Self.maxFrames)
    }

    deinit {
        scratchL.deallocate()
        scratchR.deallocate()
        outBuf.deallocate()
    }
}

/// The FM-1 as an AUv3 instrument: MIDI from the host plays it (or drives a controller layout),
/// the emulated machine runs on its own thread (crates/fm1-ios), and the firmware with its saved
/// patches goes into the host's project.
public final class FM1AudioUnit: AUAudioUnit {
    let engine: OpaquePointer
    private let state: RenderState
    private var outputBus: AUAudioUnitBus!
    private var busArray: AUAudioUnitBusArray!
    private let lock = NSLock()
    private var _package: Data?
    private var _name = ""
    private var values: [AUParameterAddress: AUValue] = [:]
    private let bootQueue = DispatchQueue(label: "fm1.boot", qos: .userInitiated)
    /// The window's refresh, on the main thread
    var onChange: (() -> Void)?
    private(set) var lastError: String?

    static let clocks: [Int] = [60, 80, 100, 120, 160, 200, 240]
    static let leads: [Int] = [256, 512, 1024]
    static let layouts = ["None", "Launchpad X", "Akai MPK"]

    enum Param: AUParameterAddress {
        case master = 0, clock, channel, layout, panelKeys, latency
    }

    var firmwareName: String { lock.lock(); defer { lock.unlock() }; return _name }
    var package: Data? { lock.lock(); defer { lock.unlock() }; return _package }

    public override init(componentDescription: AudioComponentDescription, options: AudioComponentInstantiationOptions = []) throws {
        guard let e = fm1_new() else { throw NSError(domain: "FM1", code: -1) }
        engine = e
        state = RenderState(engine: e)
        try super.init(componentDescription: componentDescription, options: options)
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
        outputBus = try AUAudioUnitBus(format: format)
        outputBus.maximumChannelCount = 2
        busArray = AUAudioUnitBusArray(audioUnit: self, busType: .output, busses: [outputBus])
        maximumFramesToRender = 4096
        makeParameters()
        bootBundled()
    }

    deinit { fm1_free(engine) }

    // ---------------------------------------------------------------- parameters

    private func makeParameters() {
        let rw: AudioUnitParameterOptions = [.flag_IsReadable, .flag_IsWritable]
        func indexed(_ id: String, _ name: String, _ address: Param, _ strings: [String]) -> AUParameter {
            AUParameterTree.createParameter(withIdentifier: id, name: name, address: address.rawValue, min: 0,
                                            max: AUValue(strings.count - 1), unit: .indexed, unitName: nil,
                                            flags: rw, valueStrings: strings, dependentParameters: nil)
        }
        let master = AUParameterTree.createParameter(withIdentifier: "master", name: "Master", address: Param.master.rawValue,
                                                     min: 0, max: 1, unit: .generic, unitName: nil, flags: rw,
                                                     valueStrings: nil, dependentParameters: nil)
        let clock = indexed("clock", "CPU clock", .clock, Self.clocks.map { "\($0) MHz" })
        let channel = indexed("channel", "MIDI channel", .channel, ["As sent"] + (1...16).map { "Channel \($0)" })
        let layout = indexed("layout", "Controller layout", .layout, Self.layouts)
        let keys = AUParameterTree.createParameter(withIdentifier: "panelKeys", name: "Notes play the FM-1's keys",
                                                   address: Param.panelKeys.rawValue, min: 0, max: 1, unit: .boolean,
                                                   unitName: nil, flags: rw, valueStrings: nil, dependentParameters: nil)
        let latency = indexed("latency", "Latency", .latency, ["Low (6 ms)", "Medium (12 ms)", "Safe (23 ms)"])
        let defaults: [Param: AUValue] = [.master: 0.88, .clock: 2, .channel: 0, .layout: 0, .panelKeys: 0, .latency: 2]
        let tree = AUParameterTree.createTree(withChildren: [master, clock, channel, layout, keys, latency])
        tree.implementorValueObserver = { [weak self] param, value in self?.apply(param.address, value) }
        tree.implementorValueProvider = { [weak self] param in self?.current(param.address) ?? 0 }
        parameterTree = tree
        for (p, v) in defaults { apply(p.rawValue, v) }
    }

    private func apply(_ address: AUParameterAddress, _ value: AUValue) {
        lock.lock(); values[address] = value; lock.unlock()
        let i = Int(value.rounded())
        guard let param = Param(rawValue: address) else { return }
        switch param {
        case .master: fm1_set(engine, 1, Int32((value * 1023).rounded()))
        case .clock: fm1_set(engine, 0, Int32(Self.clocks[max(0, min(Self.clocks.count - 1, i))]))
        case .channel: fm1_set(engine, 2, Int32(max(0, min(16, i))))
        case .layout: fm1_set(engine, 4, Int32(max(0, min(2, i))))
        case .panelKeys: fm1_set(engine, 5, value >= 0.5 ? 1 : 0)
        case .latency: fm1_set(engine, 3, Int32(Self.leads[max(0, min(Self.leads.count - 1, i))]))
        }
    }

    private func current(_ address: AUParameterAddress) -> AUValue {
        // MASTER and the notes mode also move from the controllers: read them back
        if address == Param.master.rawValue || address == Param.panelKeys.rawValue {
            var s = Fm1Status()
            fm1_status(engine, &s)
            return address == Param.master.rawValue ? AUValue(s.pot) / 1023 : (s.panel_keys ? 1 : 0)
        }
        lock.lock(); defer { lock.unlock() }
        return values[address] ?? 0
    }

    func setParameter(_ p: Param, _ value: AUValue) {
        parameterTree?.parameter(withAddress: p.rawValue)?.value = value
    }

    func value(_ p: Param) -> AUValue { current(p.rawValue) }

    func status() -> Fm1Status {
        var s = Fm1Status()
        fm1_status(engine, &s)
        return s
    }

    /// Send the Launchpad its programmer mode and every light again (after routing it in the host)
    func resendLayout() {
        fm1_set(engine, 4, Int32(value(.layout).rounded()))
    }

    // ---------------------------------------------------------------- firmware

    func boot(package: Data, name: String, sectors: Data = Data(), completion: ((String?) -> Void)? = nil) {
        bootQueue.async { [weak self] in
            guard let self else { return }
            var err = [UInt8](repeating: 0, count: 256)
            let errCount = err.count
            let result: Int32 = package.withUnsafeBytes { p in
                sectors.withUnsafeBytes { s in
                    err.withUnsafeMutableBufferPointer { e in
                        fm1_boot(self.engine, p.bindMemory(to: UInt8.self).baseAddress, package.count,
                                 s.bindMemory(to: UInt8.self).baseAddress, sectors.count, e.baseAddress, errCount)
                    }
                }
            }
            let message: String? = result == 0 ? nil : String(decoding: err.prefix { $0 != 0 }, as: UTF8.self)
            if result == 0 {
                self.lock.lock(); self._package = package; self._name = name; self.lock.unlock()
            }
            DispatchQueue.main.async {
                self.lastError = message
                completion?(message)
                self.onChange?()
            }
        }
    }

    /// FM-1 SID (MIT, the emulator's own firmware) in the plugin's bundle: something plays at once
    private func bootBundled() {
        guard let url = Bundle(for: FM1AudioUnit.self).url(forResource: "sidplayer", withExtension: "fwsc"),
              let data = try? Data(contentsOf: url) else { return }
        boot(package: data, name: "FM-1 SID")
    }

    // ---------------------------------------------------------------- the host's project

    public override var fullState: [String: Any]? {
        get {
            var s = super.fullState ?? [:]
            if let pkg = package {
                s["fm1.package"] = pkg
                s["fm1.name"] = firmwareName
                let n = fm1_sectors_snapshot(engine)
                var d = Data(count: n)
                if n > 0 {
                    d.withUnsafeMutableBytes { raw in
                        _ = fm1_sectors_copy(engine, raw.bindMemory(to: UInt8.self).baseAddress, n)
                    }
                }
                s["fm1.sectors"] = d
            }
            return s
        }
        set {
            super.fullState = newValue
            guard let s = newValue, let pkg = s["fm1.package"] as? Data else { return }
            boot(package: pkg, name: s["fm1.name"] as? String ?? "Firmware", sectors: s["fm1.sectors"] as? Data ?? Data())
        }
    }

    public override var supportsUserPresets: Bool { true }

    // ---------------------------------------------------------------- rendering

    public override var outputBusses: AUAudioUnitBusArray { busArray }
    public override var midiOutputNames: [String] { ["Launchpad lights"] }
    public override var latency: TimeInterval { Double(fm1_latency(engine)) / max(1, outputBus.format.sampleRate) }
    public override var tailTime: TimeInterval { 0.5 }

    public override func allocateRenderResources() throws {
        if maximumFramesToRender > AUAudioFrameCount(RenderState.maxFrames) {
            maximumFramesToRender = AUAudioFrameCount(RenderState.maxFrames)
        }
        try super.allocateRenderResources()
        fm1_prepare(engine, outputBus.format.sampleRate, maximumFramesToRender)
        state.midiOut = midiOutputEventBlock
    }

    public override func deallocateRenderResources() {
        state.midiOut = nil
        super.deallocateRenderResources()
    }

    public override var internalRenderBlock: AUInternalRenderBlock {
        let st = state
        return { _, timestamp, frameCount, _, outputData, realtimeEventListHead, _ in
            let e = st.engine
            let now = AUEventSampleTime(timestamp.pointee.mSampleTime)
            var event = realtimeEventListHead
            while let ev = event {
                let type = ev.pointee.head.eventType
                if type == .MIDI || type == .midiSysEx {
                    let m = ev.pointee.MIDI
                    let offset = UInt32(max(0, min(AUEventSampleTime(frameCount), m.eventSampleTime - now)))
                    var data = m.data
                    withUnsafeBytes(of: &data) { raw in
                        fm1_midi(e, raw.bindMemory(to: UInt8.self).baseAddress, UInt32(m.length), offset)
                    }
                }
                event = UnsafePointer(ev.pointee.head.next)
            }
            let frames = min(frameCount, AUAudioFrameCount(RenderState.maxFrames))
            let abl = UnsafeMutableAudioBufferListPointer(outputData)
            if abl.count >= 1 {
                if abl[0].mData == nil { abl[0].mData = UnsafeMutableRawPointer(st.scratchL) }
                var right = st.scratchR
                if abl.count >= 2 {
                    if abl[1].mData == nil { abl[1].mData = UnsafeMutableRawPointer(st.scratchR) }
                    right = abl[1].mData!.assumingMemoryBound(to: Float.self)
                }
                fm1_render(e, abl[0].mData!.assumingMemoryBound(to: Float.self), right, frames)
                for i in 0..<abl.count { abl[i].mDataByteSize = frames * UInt32(MemoryLayout<Float>.size) }
            }
            // the Launchpad's lights (dropped when the host takes no MIDI out)
            while true {
                let n = fm1_midi_out(e, st.outBuf, UInt32(RenderState.outCap))
                if n == 0 { break }
                if let out = st.midiOut { _ = out(now, 0, Int(n), st.outBuf) }
            }
            return noErr
        }
    }
}
