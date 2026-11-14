//! Controller layouts for the plugin: a Novation Launchpad X and an Akai MPK (mini) as FM-1 front
//! panels. The same layouts as the page's (web/controllers.js); a host merges its MIDI inputs, so
//! the layout is chosen in the plugin rather than found by a device's name.
//!
//! MIDI bytes in, actions out. Encoders are numbered as the panel lists them (0 SELECT, 1 PRESETS,
//! 2 ALGORITHM, 3..6 KNOB1..4); the engine turns that into the matrix encoder.

use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Layout {
    /// every message to the MIDI IN jack
    #[default]
    None,
    LaunchpadX,
    Mpk,
}

impl Layout {
    pub fn from_u32(v: u32) -> Self {
        match v { 1 => Layout::LaunchpadX, 2 => Layout::Mpk, _ => Layout::None }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Act {
    /// a matrix key: buttons 0..13, note keys 14..40 (F3..G5)
    Key { id: u8, down: bool },
    /// a panel encoder by its index in the panel's list
    Turn { enc: u8, clicks: i32 },
    /// MASTER, 0..1023
    Pot(u16),
    PotStep(i32),
    /// into the MIDI IN jack
    Jack(Vec<u8>),
    /// repeat `act` while source `src` is held
    Repeat { src: u16, act: Box<Act> },
    Stop { src: u16 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum T {
    Btn(u8),
    Step(u8, i32),
    PotStep(i32),
    PNote(i32),
    Enc(u8),
    Pot,
    Octave(i32),
    Mode,
    Ignore,
}

pub const PLAY: u8 = 12;
pub const REC: u8 = 13;
const F3: i32 = 53;
const G5: i32 = 79;
const KEY0: i32 = 14;
const WHITE: [i32; 8] = [0, 2, 4, 5, 7, 9, 11, 12];

/// A binding's source: (cc?, channel 1..16 or 0 for any, number)
type Src = (bool, u8, u8);

fn launchpad() -> HashMap<Src, T> {
    let mut b = HashMap::new();
    let black = |c: u8| match c { 2 => Some(1), 3 => Some(3), 5 => Some(6), 6 => Some(8), 7 => Some(10), _ => None };
    for c in 1..=8u8 {
        for (row, oct) in [(1u8, 0), (3, 12)] { b.insert((false, 1, row * 10 + c), T::PNote(WHITE[c as usize - 1] + oct)); }
        for (row, oct) in [(2u8, 0), (4, 12)] { b.insert((false, 1, row * 10 + c), black(c).map_or(T::Ignore, |s| T::PNote(s + oct))); }
        b.insert((false, 1, 50 + c), if c < 8 { T::Step(c - 1, -1) } else { T::PotStep(-64) });
        b.insert((false, 1, 60 + c), if c < 8 { T::Step(c - 1, 1) } else { T::PotStep(64) });
    }
    // HOME SAVE ARP SEQ PLAY REC OCT- OCT+ / FX SCL ENV LFO EDIT GLO, then the notes mode
    for (i, id) in [8u8, 9, 10, 11, 12, 13, 0, 1].iter().enumerate() { b.insert((false, 1, 71 + i as u8), T::Btn(*id)); }
    for (i, id) in [2u8, 3, 4, 5, 6, 7].iter().enumerate() { b.insert((false, 1, 81 + i as u8), T::Btn(*id)); }
    b.insert((false, 1, 87), T::Mode);
    b.insert((false, 1, 88), T::Ignore);
    b.insert((true, 1, 91), T::Octave(1));
    b.insert((true, 1, 92), T::Octave(-1));
    b.insert((true, 1, 93), T::Step(0, -1));
    b.insert((true, 1, 94), T::Step(0, 1));
    for c in 95..=98 { b.insert((true, 1, c), T::Ignore); }
    for r in 1..=8 { b.insert((true, 1, r * 10 + 9), T::Ignore); }
    b
}

fn mpk() -> HashMap<Src, T> {
    let mut b = HashMap::new();
    // K1-K4 the FM-1's four knobs, K5 SELECT, K6 PRESETS, K7 ALGORITHM, K8 MASTER
    for (cc, t) in [(70, T::Enc(3)), (71, T::Enc(4)), (72, T::Enc(5)), (73, T::Enc(6)), (74, T::Enc(0)), (75, T::Enc(1)), (76, T::Enc(2)), (77, T::Pot)] {
        b.insert((true, 0, cc), t);
    }
    // pads (channel 10): bank A PLAY REC SEQ ARP / OCT- OCT+ HOME SAVE, bank B FX SCL ENV LFO / EDIT GLO SELECT< SELECT>
    let pads = [T::Btn(12), T::Btn(13), T::Btn(11), T::Btn(10), T::Btn(0), T::Btn(1), T::Btn(8), T::Btn(9),
        T::Btn(2), T::Btn(3), T::Btn(4), T::Btn(5), T::Btn(6), T::Btn(7), T::Step(0, -1), T::Step(0, 1)];
    for (i, t) in pads.iter().enumerate() { b.insert((false, 10, 36 + i as u8), *t); }
    b
}

pub struct Mapper {
    pub layout: Layout,
    /// notes play the FM-1's own keys (F3..G5) rather than its MIDI IN jack
    pub panel_keys: bool,
    pub octave: i32,
    /// CC values per encoder click for absolute knobs
    pub step: i32,
    bindings: HashMap<Src, T>,
    last: HashMap<u16, i32>,
    acc: HashMap<u16, i32>,
    held: HashMap<u16, Vec<Act>>,
    /// Launchpad: pads held (their programmer-mode index)
    pub pressed: [bool; 128],
}

const fn key(cc: bool, n: u8) -> u16 { (cc as u16) << 8 | n as u16 }

impl Mapper {
    pub fn new(layout: Layout) -> Self {
        let mut m = Mapper { layout, panel_keys: false, octave: 0, step: 2, bindings: HashMap::new(), last: HashMap::new(),
            acc: HashMap::new(), held: HashMap::new(), pressed: [false; 128] };
        m.set_layout(layout);
        m
    }

    pub fn set_layout(&mut self, layout: Layout) {
        self.layout = layout;
        self.bindings = match layout { Layout::LaunchpadX => launchpad(), Layout::Mpk => mpk(), Layout::None => HashMap::new() };
        self.last.clear();
        self.acc.clear();
        self.held.clear();
        self.pressed = [false; 128];
    }

    fn binding(&self, cc: bool, ch: u8, n: u8) -> Option<T> {
        self.bindings.get(&(cc, ch, n)).or_else(|| self.bindings.get(&(cc, 0, n))).copied()
    }

    fn note(&self, mut n: i32, vel: u8, on: bool, ch: u8) -> Vec<Act> {
        if self.panel_keys {
            while n < F3 { n += 12; }
            while n > G5 { n -= 12; }
            return vec![Act::Key { id: (KEY0 + n - F3) as u8, down: on }];
        }
        let n = n.clamp(0, 127) as u8;
        vec![Act::Jack(vec![if on { 0x90 } else { 0x80 } | (ch - 1), n, if on { vel.max(1) } else { 0 }])]
    }

    fn press(&mut self, t: T, on: bool, vel: u8, ch: u8, src: u16) -> Vec<Act> {
        match t {
            T::Btn(id) => vec![Act::Key { id, down: on }],
            T::Step(enc, d) => if on { vec![Act::Repeat { src, act: Box::new(Act::Turn { enc, clicks: d }) }] } else { vec![Act::Stop { src }] },
            T::PotStep(d) => if on { vec![Act::Repeat { src, act: Box::new(Act::PotStep(d)) }] } else { vec![Act::Stop { src }] },
            T::Octave(d) => { if on { self.octave = (self.octave + d).clamp(-3, 3); } vec![] }
            T::Mode => { if on { self.panel_keys = !self.panel_keys; } vec![] }
            T::PNote(semi) => self.note(60 + 12 * self.octave + semi, vel, on, ch),
            T::Enc(_) | T::Pot | T::Ignore => vec![],
        }
    }

    pub fn handle(&mut self, b: &[u8]) -> Vec<Act> {
        if b.is_empty() { return vec![]; }
        if b[0] >= 0xf0 { return if b[0] >= 0xf8 { vec![] } else { vec![Act::Jack(b.to_vec())] }; }
        let (st, ch) = (b[0] & 0xf0, (b[0] & 0x0f) + 1);
        if (st == 0x90 || st == 0x80) && b.len() >= 3 {
            let on = st == 0x90 && b[2] > 0;
            let src = key(false, b[1]);
            if self.layout == Layout::LaunchpadX { self.pressed[b[1] as usize & 127] = on; }
            if !on {
                if let Some(undo) = self.held.remove(&src) { return undo; }
            }
            let t = self.binding(false, ch, b[1]);
            if t == Some(T::Ignore) { return vec![]; }
            if !on {
                return match t {
                    Some(t) => self.press(t, false, 0, ch, src),
                    None => self.note(b[1] as i32 + if self.panel_keys { 12 * self.octave } else { 0 }, 0, false, ch),
                };
            }
            let out = match t {
                Some(t) => self.press(t, true, b[2], ch, src),
                None if self.panel_keys => self.note(b[1] as i32 + 12 * self.octave, b[2], true, ch),
                None => vec![Act::Jack(b.to_vec())],
            };
            let undo: Vec<Act> = out.iter().filter_map(|a| match a {
                Act::Key { id, .. } => Some(Act::Key { id: *id, down: false }),
                Act::Jack(j) => Some(Act::Jack(vec![0x80 | (j[0] & 0x0f), j[1], 0])),
                Act::Repeat { src, .. } => Some(Act::Stop { src: *src }),
                _ => None,
            }).collect();
            if !undo.is_empty() { self.held.insert(src, undo); }
            return out;
        }
        if st == 0xb0 && b.len() >= 3 {
            let src = key(true, b[1]);
            if self.layout == Layout::LaunchpadX && b[1] >= 91 { self.pressed[b[1] as usize & 127] = b[2] > 0; }
            let v = b[2] as i32;
            return match self.binding(true, ch, b[1]) {
                None => vec![Act::Jack(b.to_vec())],
                Some(T::Ignore) => vec![],
                Some(T::Pot) => vec![Act::Pot((v * 1023 / 127) as u16)],
                Some(T::Enc(enc)) => {
                    let before = self.last.insert(src, v);
                    let Some(before) = before else { return vec![] };   // its first value only says where it is
                    let a = self.acc.get(&src).copied().unwrap_or(0) + v - before;
                    let clicks = a / self.step;
                    self.acc.insert(src, a - clicks * self.step);
                    if clicks != 0 { vec![Act::Turn { enc, clicks }] } else { vec![] }
                }
                Some(t) => self.press(t, v >= 64, 100, ch, src),
            };
        }
        vec![Act::Jack(b.to_vec())]
    }
}

// ---------------------------------------------------------------- the Launchpad's lights

/// Every pad's colour (index -> r, g, b in 0..127) from the FM-1's 41 LED levels.
pub fn launchpad_colours(m: &Mapper, leds: &[f32; 41]) -> Vec<(u8, [u8; 3])> {
    let lit = |i: usize| leds.get(i).copied().unwrap_or(0.0).clamp(0.0, 1.0);
    let key_of = |semi: i32| {
        let mut n = 60 + 12 * m.octave + semi;
        while n < F3 { n += 12; }
        while n > G5 { n -= 12; }
        (KEY0 + n - F3) as usize
    };
    let mut out = Vec::with_capacity(80);
    for r in 1..=8u8 {
        for c in 1..=8u8 {
            let idx = r * 10 + c;
            let col = match m.bindings.get(&(false, 1, idx)) {
                Some(T::PNote(s)) => {
                    if lit(key_of(*s)) > 0.2 { [127, 70, 0] }
                    else if [1, 3, 6, 8, 10].contains(&s.rem_euclid(12)) { [0, 10, 60] } else { [36, 36, 36] }
                }
                Some(T::Step(_, d)) => if *d < 0 { [60, 4, 4] } else { [4, 60, 10] },
                Some(T::PotStep(d)) => if *d < 0 { [60, 4, 4] } else { [4, 60, 10] },
                Some(T::Btn(id)) => {
                    let l = lit(*id as usize);
                    let on = match *id { PLAY => [0, 127, 20], REC => [127, 0, 0], _ => [127, 80, 0] };
                    if l > 0.05 { on.map(|v| (v as f32 * (0.25 + 0.75 * l)).round() as u8) } else { [24, 24, 24] }
                }
                Some(T::Mode) => if m.panel_keys { [0, 110, 127] } else { [90, 0, 127] },
                _ => [0, 0, 0],
            };
            out.push((idx, if m.pressed[idx as usize] { [127; 3] } else { col }));
        }
    }
    for c in 91..=94u8 {
        let mut col = if c <= 92 { [60, 60, 60] } else { [100, 90, 0] };
        if (c == 91 && m.octave > 0) || (c == 92 && m.octave < 0) { col = [0, 127, 40]; }
        out.push((c, if m.pressed[c as usize] { [127; 3] } else { col }));
    }
    out
}

pub const LPX_PROGRAMMER: [u8; 9] = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x0e, 0x01, 0xf7];
pub const LPX_LIVE: [u8; 9] = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x0e, 0x00, 0xf7];

/// One SysEx that sets these pads' RGB colours.
pub fn lpx_rgb(pads: &[(u8, [u8; 3])]) -> Vec<u8> {
    let mut v = vec![0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x03];
    for (i, [r, g, b]) in pads { v.extend_from_slice(&[0x03, *i, *r & 127, *g & 127, *b & 127]); }
    v.push(0xf7);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mpk_knobs_pads_and_keys() {
        let mut m = Mapper::new(Layout::Mpk);
        assert_eq!(m.handle(&[0x90, 60, 100]), vec![Act::Jack(vec![0x90, 60, 100])]);
        assert_eq!(m.handle(&[0x80, 60, 0]), vec![Act::Jack(vec![0x80, 60, 0])]);
        assert_eq!(m.handle(&[0xb0, 70, 64]), vec![]);
        assert_eq!(m.handle(&[0xb0, 70, 70]), vec![Act::Turn { enc: 3, clicks: 3 }]);
        assert_eq!(m.handle(&[0xb0, 70, 69]), vec![]);
        assert_eq!(m.handle(&[0xb0, 70, 67]), vec![Act::Turn { enc: 3, clicks: -1 }]);
        assert_eq!(m.handle(&[0xb0, 77, 127]), vec![Act::Pot(1023)]);
        assert_eq!(m.handle(&[0xb0, 1, 40]), vec![Act::Jack(vec![0xb0, 1, 40])]);
        assert_eq!(m.handle(&[0x99, 36, 90]), vec![Act::Key { id: PLAY, down: true }]);
        assert_eq!(m.handle(&[0x99, 36, 0]), vec![Act::Key { id: PLAY, down: false }]);
        assert!(matches!(&m.handle(&[0x99, 51, 90])[0], Act::Repeat { act, .. } if **act == Act::Turn { enc: 0, clicks: 1 }));
        assert_eq!(m.handle(&[0x89, 51, 0]).len(), 1);
    }

    #[test]
    fn launchpad_piano_buttons_octave_and_mode() {
        let mut m = Mapper::new(Layout::LaunchpadX);
        assert_eq!(m.handle(&[0x90, 11, 90]), vec![Act::Jack(vec![0x90, 60, 90])]);
        m.handle(&[0xb0, 91, 127]);
        m.handle(&[0xb0, 91, 0]);
        assert_eq!(m.octave, 1);
        assert_eq!(m.handle(&[0x90, 11, 0]), vec![Act::Jack(vec![0x80, 60, 0])]);   // releases what it pressed
        assert_eq!(m.handle(&[0x90, 22, 70]), vec![Act::Jack(vec![0x90, 73, 70])]); // C#5
        assert_eq!(m.handle(&[0x90, 24, 70]), vec![]);
        assert_eq!(m.handle(&[0x90, 75, 70]), vec![Act::Key { id: PLAY, down: true }]);
        assert_eq!(m.handle(&[0x90, 75, 0]), vec![Act::Key { id: PLAY, down: false }]);
        m.handle(&[0x90, 87, 70]);
        assert!(m.panel_keys);
        m.octave = 0;
        assert_eq!(m.handle(&[0x90, 11, 70]), vec![Act::Key { id: 21, down: true }]);
    }

    #[test]
    fn panel_keys_fold_into_the_fm1_range() {
        let mut m = Mapper::new(Layout::None);
        m.panel_keys = true;
        assert_eq!(m.handle(&[0x90, 36, 100]), vec![Act::Key { id: 21, down: true }]);
        assert_eq!(m.handle(&[0x90, 53, 100]), vec![Act::Key { id: 14, down: true }]);
        assert_eq!(m.handle(&[0x90, 80, 100]), vec![Act::Key { id: 29, down: true }]);
        m.panel_keys = false;
        assert_eq!(m.handle(&[0xe0, 0, 80]), vec![Act::Jack(vec![0xe0, 0, 80])]);
    }

    #[test]
    fn launchpad_lights() {
        let mut m = Mapper::new(Layout::LaunchpadX);
        let mut leds = [0.0; 41];
        leds[PLAY as usize] = 1.0;
        leds[21] = 1.0;
        m.handle(&[0x90, 12, 50]);
        let c: HashMap<u8, [u8; 3]> = launchpad_colours(&m, &leds).into_iter().collect();
        assert_eq!(c[&75], [0, 127, 20]);
        assert_eq!(c[&76], [24, 24, 24]);
        assert_eq!(c[&11], [127, 70, 0]);
        assert_eq!(c[&12], [127, 127, 127]);
        assert_eq!(c[&24], [0, 0, 0]);
        assert_eq!(c.len(), 68);
        assert_eq!(lpx_rgb(&[(11, [1, 2, 3])]), vec![0xf0, 0, 0x20, 0x29, 2, 0x0c, 3, 3, 11, 1, 2, 3, 0xf7]);
    }
}
