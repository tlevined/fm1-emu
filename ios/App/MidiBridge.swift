import CoreMIDI
import Foundation

/// Web MIDI for the page, from CoreMIDI: every source and destination of the iPad (USB, Bluetooth,
/// other apps' virtual ports) as the page's MIDI inputs and outputs (App/midi-shim.js is the page's
/// side). Messages come in on CoreMIDI's thread, are split into whole MIDI messages per source, and
/// reach the page in batches on the main thread.
final class MidiBridge {
    /// Runs JavaScript in the page
    var evaluate: ((String) -> Void)?

    private var client = MIDIClientRef()
    private var inPort = MIDIPortRef()
    private var outPort = MIDIPortRef()
    private var opened = false
    private var pending: [(Int32, [UInt8])] = []
    private var flushQueued = false

    private struct Parser {
        var status: UInt8 = 0
        var need = 0
        var msg: [UInt8] = []
        var sysex: [UInt8]?
    }
    private var parsers: [Int32: Parser] = [:]

    func open() {
        if opened { publish(); return }
        opened = true
        MIDIClientCreateWithBlock("FM-1" as CFString, &client) { [weak self] _ in
            DispatchQueue.main.async { self?.connectAll(); self?.publish() }
        }
        let dataOffset = MemoryLayout<MIDIPacket>.offset(of: \MIDIPacket.data) ?? 10
        MIDIInputPortCreateWithBlock(client, "FM-1 in" as CFString, &inPort) { [weak self] list, refCon in
            let id = Int32(truncatingIfNeeded: Int(bitPattern: refCon))
            var bytes: [UInt8] = []
            for packet in list.unsafeSequence() {
                let n = Int(packet.pointee.length)
                let base = UnsafeRawPointer(packet).advanced(by: dataOffset)
                bytes.append(contentsOf: UnsafeRawBufferPointer(start: base, count: n))
            }
            DispatchQueue.main.async { self?.received(id, bytes) }
        }
        MIDIOutputPortCreate(client, "FM-1 out" as CFString, &outPort)
        connectAll()
        publish()
    }

    // ---------------------------------------------------------------- ports

    private static func uniqueID(_ obj: MIDIObjectRef) -> Int32 {
        var v: Int32 = 0
        MIDIObjectGetIntegerProperty(obj, kMIDIPropertyUniqueID, &v)
        return v
    }

    private static func name(_ obj: MIDIObjectRef) -> String {
        var s: Unmanaged<CFString>?
        if MIDIObjectGetStringProperty(obj, kMIDIPropertyDisplayName, &s) == noErr, let v = s?.takeRetainedValue() {
            return v as String
        }
        if MIDIObjectGetStringProperty(obj, kMIDIPropertyName, &s) == noErr, let v = s?.takeRetainedValue() {
            return v as String
        }
        return "MIDI port"
    }

    private func connectAll() {
        for i in 0..<MIDIGetNumberOfSources() {
            let src = MIDIGetSource(i)
            let id = Self.uniqueID(src)
            MIDIPortDisconnectSource(inPort, src)
            MIDIPortConnectSource(inPort, src, UnsafeMutableRawPointer(bitPattern: Int(id)))
        }
    }

    /// The page's port list: { inputs: [{id, name}], outputs: [...] }
    private func publish() {
        func ports(_ count: Int, _ get: (Int) -> MIDIEndpointRef) -> [[String: String]] {
            (0..<count).map { i in
                let e = get(i)
                return ["id": String(Self.uniqueID(e)), "name": Self.name(e)]
            }
        }
        let list: [String: Any] = [
            "inputs": ports(MIDIGetNumberOfSources()) { MIDIGetSource($0) },
            "outputs": ports(MIDIGetNumberOfDestinations()) { MIDIGetDestination($0) },
        ]
        guard let json = try? JSONSerialization.data(withJSONObject: list),
              let text = String(data: json, encoding: .utf8) else { return }
        evaluate?("window.__fm1midi && __fm1midi.ports(\(text))")
    }

    // ---------------------------------------------------------------- in

    private static func dataLength(_ s: UInt8) -> Int {
        switch s & 0xF0 {
        case 0xC0, 0xD0: return 1
        case 0xF0:
            switch s {
            case 0xF1, 0xF3: return 1
            case 0xF2: return 2
            default: return 0
            }
        default: return 2
        }
    }

    /// Bytes from a source into whole messages (running status, SysEx across packets, real time)
    private func received(_ id: Int32, _ bytes: [UInt8]) {
        var p = parsers[id] ?? Parser()
        for b in bytes {
            if b >= 0xF8 { emit(id, [b]); continue }
            if b == 0xF0 { p.sysex = [b]; continue }
            if var s = p.sysex {
                if b == 0xF7 { s.append(b); emit(id, s); p.sysex = nil; continue }
                if b < 0x80 { s.append(b); p.sysex = s.count > 65_536 ? nil : s; continue }
                p.sysex = nil
            }
            if b >= 0x80 {
                p.status = b
                p.need = Self.dataLength(b)
                p.msg = [b]
                if p.need == 0 { emit(id, p.msg); p.msg = []; p.status = 0 }
                continue
            }
            guard p.status != 0 else { continue }
            if p.msg.isEmpty { p.msg = [p.status] }
            p.msg.append(b)
            if p.msg.count == p.need + 1 {
                emit(id, p.msg)
                p.msg = []
                if p.status >= 0xF0 { p.status = 0 }
            }
        }
        parsers[id] = p
    }

    private func emit(_ id: Int32, _ msg: [UInt8]) {
        pending.append((id, msg))
        guard !flushQueued else { return }
        flushQueued = true
        DispatchQueue.main.async { [weak self] in self?.flush() }
    }

    private func flush() {
        flushQueued = false
        guard !pending.isEmpty else { return }
        let batch = pending.map { "[\"\($0.0)\",[\($0.1.map { String($0) }.joined(separator: ","))]]" }.joined(separator: ",")
        pending.removeAll(keepingCapacity: true)
        evaluate?("window.__fm1midi && __fm1midi.recv([\(batch)])")
    }

    // ---------------------------------------------------------------- out

    func send(to id: String, _ bytes: [UInt8]) {
        guard opened, let uid = Int32(id), !bytes.isEmpty else { return }
        for i in 0..<MIDIGetNumberOfDestinations() {
            let dest = MIDIGetDestination(i)
            guard Self.uniqueID(dest) == uid else { continue }
            let size = bytes.count + 256
            let raw = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 8)
            defer { raw.deallocate() }
            let list = raw.bindMemory(to: MIDIPacketList.self, capacity: 1)
            var packet: UnsafeMutablePointer<MIDIPacket>? = MIDIPacketListInit(list)
            bytes.withUnsafeBufferPointer { b in
                packet = MIDIPacketListAdd(list, size, packet!, 0, b.count, b.baseAddress!)
            }
            if packet != nil { MIDISend(outPort, dest, list) }
        }
    }
}
