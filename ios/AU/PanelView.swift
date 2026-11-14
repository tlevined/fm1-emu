import UIKit

/// The FM-1's front panel, drawn by the emulator (crates/fm1-ios: fm1_panel_draw) and played by
/// touch: several fingers at once, keys with glissando, knobs dragged up and down, MASTER as a pot.
final class PanelView: UIView {
    var engine: OpaquePointer?
    /// MASTER dragged: the new value, 0..1023 (the view controller sets the host parameter)
    var onPot: ((Int) -> Void)?
    var currentPot: () -> Int = { 900 }

    private let panelW = Int(fm1_panel_width())
    private let panelH = Int(fm1_panel_height())
    private let space = CGColorSpaceCreateDeviceRGB()
    private var link: CADisplayLink?
    private struct Grab { var target: Int32; var lastY: CGFloat; var acc: CGFloat; var held: Int32 }
    private var grabs: [ObjectIdentifier: Grab] = [:]
    private var holds = [Int](repeating: 0, count: 64)
    private var clicks = [Int32](repeating: 0, count: 8)

    override init(frame: CGRect) {
        super.init(frame: frame)
        isMultipleTouchEnabled = true
        backgroundColor = .black
        layer.contentsGravity = .resizeAspect
        layer.magnificationFilter = .linear
        layer.minificationFilter = .trilinear
        isAccessibilityElement = true
        accessibilityLabel = "FM-1 front panel"
    }

    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        link?.invalidate()
        link = nil
        guard window != nil else { return }
        let l = CADisplayLink(target: self, selector: #selector(tick))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 20, maximum: 30, preferred: 30)
        l.add(to: .main, forMode: .common)
        link = l
    }

    @objc private func tick() {
        guard let e = engine, let px = fm1_panel_draw(e) else { return }
        let data = Data(bytes: px, count: panelW * panelH * 4)
        guard let provider = CGDataProvider(data: data as CFData),
              let image = CGImage(width: panelW, height: panelH, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: panelW * 4,
                                  space: space, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                                  provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.contents = image
        CATransaction.commit()
    }

    // ---------------------------------------------------------------- touch

    /// A touch in panel pixels (the image is fitted to the view, centred)
    private func panelPoint(_ t: UITouch) -> CGPoint {
        let p = t.location(in: self)
        let scale = min(bounds.width / CGFloat(panelW), bounds.height / CGFloat(panelH))
        guard scale > 0 else { return .zero }
        let ox = (bounds.width - CGFloat(panelW) * scale) / 2
        let oy = (bounds.height - CGFloat(panelH) * scale) / 2
        return CGPoint(x: (p.x - ox) / scale, y: (p.y - oy) / scale)
    }

    private func press(_ id: Int32) {
        guard let e = engine, id >= 0, id < 64 else { return }
        holds[Int(id)] += 1
        if holds[Int(id)] == 1 {
            fm1_key(e, UInt32(id), true)
            fm1_panel_set(e, 0, UInt32(id), 1)
        }
    }

    private func release(_ id: Int32) {
        guard let e = engine, id >= 0, id < 64, holds[Int(id)] > 0 else { return }
        holds[Int(id)] -= 1
        if holds[Int(id)] == 0 {
            fm1_key(e, UInt32(id), false)
            fm1_panel_set(e, 0, UInt32(id), 0)
        }
    }

    private func turn(_ enc: Int32, _ n: Int32) {
        guard let e = engine, enc >= 0, enc < 7 else { return }
        clicks[Int(enc)] += n
        fm1_enc(e, UInt32(enc), n)
        fm1_panel_set(e, 1, UInt32(enc), clicks[Int(enc)])
        fm1_panel_set(e, 3, UInt32(enc), 10)
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches {
            let p = panelPoint(t)
            let hit = fm1_panel_hit(Float(p.x), Float(p.y))
            var g = Grab(target: hit, lastY: p.y, acc: 0, held: -1)
            if hit >= 100 {
                g.held = hit - 100
                press(g.held)
            }
            grabs[ObjectIdentifier(t)] = g
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches {
            guard var g = grabs[ObjectIdentifier(t)], g.target >= 0 else { continue }
            let p = panelPoint(t)
            if g.held >= 14 && g.held <= 40 {
                // glissando over the note keys
                let h = fm1_panel_hit(Float(p.x), Float(p.y)) - 100
                if h >= 14 && h <= 40 && h != g.held {
                    release(g.held)
                    g.held = h
                    press(h)
                }
            } else if g.target >= 0 && g.target < 7 {
                g.acc += g.lastY - p.y
                while g.acc >= 12 { g.acc -= 12; turn(g.target, 1) }
                while g.acc <= -12 { g.acc += 12; turn(g.target, -1) }
            } else if g.target == 7 {
                let v = max(0, min(1023, currentPot() + Int(((g.lastY - p.y) * 4).rounded())))
                onPot?(v)
                if let e = engine { fm1_panel_set(e, 3, 7, 10) }
            }
            g.lastY = p.y
            grabs[ObjectIdentifier(t)] = g
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { end(touches) }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { end(touches) }

    private func end(_ touches: Set<UITouch>) {
        for t in touches {
            if let g = grabs.removeValue(forKey: ObjectIdentifier(t)), g.held >= 0 { release(g.held) }
        }
    }
}
