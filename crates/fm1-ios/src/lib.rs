//! The FM-1 emulator for iOS: what an AUv3 instrument (ios/) calls, through include/fm1_ios.h.
//!
//! One `Fm1` per plugin instance. Its machine runs on a thread of its own (engine.rs); the render
//! block only moves frames and MIDI through lock-free rings (`fm1_render`, `fm1_midi`,
//! `fm1_midi_out` take no lock and allocate nothing). Everything else is for the window or the
//! host's project state, from any other thread.

pub mod engine;
pub mod mapper;
#[path = "../../fm1-live/src/panel.rs"]
#[allow(dead_code)]
mod panel;

use engine::{Cmd, Midi, Shared, RATE, SECTOR};
use std::cell::UnsafeCell;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

/// The render block's side: touched only from the host's render thread (and `fm1_prepare`,
/// which the host calls while it does not render).
struct Render {
    audio: rtrb::Consumer<[f32; 2]>,
    midi: rtrb::Producer<Midi>,
    out: rtrb::Consumer<u8>,
    ratio: f64,
    lead: usize,
    taken: u64,
    frac: f64,
    cur: [f32; 2],
    next: [f32; 2],
}

struct PanelState {
    base: Vec<u32>,
    buf: Vec<u32>,
    lcd: Vec<u16>,
    leds: [f32; 41],
    down: [bool; 64],
    enc: [i32; 8],
    turn: [u32; 9],
}

pub struct Fm1 {
    shared: Arc<Shared>,
    cmds: Mutex<mpsc::Sender<Cmd>>,
    thread: Option<std::thread::JoinHandle<()>>,
    render: UnsafeCell<Render>,
    panel: Mutex<PanelState>,
    sectors: Mutex<Vec<u8>>,
}
// (the render side is used from one thread at a time, as the AU contract has it)
unsafe impl Sync for Fm1 {}
unsafe impl Send for Fm1 {}

impl Fm1 {
    fn send(&self, c: Cmd) { let _ = self.cmds.lock().unwrap().send(c); }
}

#[repr(C)]
pub struct Fm1Status {
    pub booted: bool,
    pub halted: bool,
    /// how much faster than real time the machine could run (0 while it starts)
    pub speed: f32,
    /// frames the render block found missing since the start
    pub starved: u64,
    /// 0 FM-1, 1 SMK-37
    pub board: u32,
    pub mhz: u32,
    pub pot: u32,
    pub panel_keys: bool,
    pub octave: i32,
    pub lcd_rev: u64,
}

// ---------------------------------------------------------------- life

#[no_mangle]
pub extern "C" fn fm1_new() -> *mut Fm1 {
    let shared = Arc::new(Shared::new());
    let (tx, rx) = mpsc::channel();
    let (audio_tx, audio_rx) = rtrb::RingBuffer::<[f32; 2]>::new(1 << 15);
    let (midi_tx, midi_rx) = rtrb::RingBuffer::<Midi>::new(4096);
    let (out_tx, out_rx) = rtrb::RingBuffer::<u8>::new(1 << 15);
    let s = shared.clone();
    let thread = std::thread::Builder::new().name("fm1-machine".into())
        .spawn(move || {
            raise_priority();
            engine::run(s, rx, midi_rx, audio_tx, out_tx)
        })
        .ok();
    Box::into_raw(Box::new(Fm1 {
        shared,
        cmds: Mutex::new(tx),
        thread,
        render: UnsafeCell::new(Render { audio: audio_rx, midi: midi_tx, out: out_rx, ratio: RATE / 48_000.0, lead: 2048,
            taken: 0, frac: 0.0, cur: [0.0; 2], next: [0.0; 2] }),
        panel: Mutex::new(PanelState { base: Vec::new(), buf: Vec::new(), lcd: vec![0; 240 * 240], leds: [0.0; 41],
            down: [false; 64], enc: [0; 8], turn: [0; 9] }),
        sectors: Mutex::new(Vec::new()),
    }))
}

/// The machine's thread as one the system schedules promptly (it feeds the audio).
fn raise_priority() {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    unsafe {
        extern "C" { fn pthread_set_qos_class_self_np(qos: u32, rel: i32) -> i32; }
        const QOS_CLASS_USER_INTERACTIVE: u32 = 0x21;
        pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
    }
}

/// # Safety
/// `h` from `fm1_new`, not used after.
#[no_mangle]
pub unsafe extern "C" fn fm1_free(h: *mut Fm1) {
    if h.is_null() { return; }
    let mut b = Box::from_raw(h);
    b.shared.quit.store(true, Ordering::Relaxed);
    if let Some(t) = b.thread.take() { let _ = t.join(); }
}

unsafe fn get<'a>(h: *const Fm1) -> Option<&'a Fm1> { h.as_ref() }

// ---------------------------------------------------------------- the render block's side

/// The host's rate and largest block, before rendering starts (allocateRenderResources).
/// # Safety
/// Not while `fm1_render` runs.
#[no_mangle]
pub unsafe extern "C" fn fm1_prepare(h: *mut Fm1, sample_rate: f64, max_frames: u32) {
    let Some(f) = get(h) else { return };
    let r = &mut *f.render.get();
    r.ratio = RATE / sample_rate.max(8000.0);
    let block = (max_frames.max(64) as f64 * r.ratio).ceil() as usize;
    r.lead = block + f.shared.settings.lead.load(Ordering::Relaxed) as usize;
    f.send(Cmd::Block(block));
}

/// The delay the machine runs ahead of the host, in the host's samples.
/// # Safety
/// `h` from `fm1_new`.
#[no_mangle]
pub unsafe extern "C" fn fm1_latency(h: *const Fm1) -> u32 {
    let Some(f) = get(h) else { return 0 };
    let r = &*f.render.get();
    (r.lead as f64 / r.ratio).round() as u32
}

/// A MIDI message from the host, `offset` samples into the block about to be rendered.
/// Realtime-safe. Longer messages (SysEx) go in 3-byte pieces.
/// # Safety
/// Render thread only; `bytes` holds `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn fm1_midi(h: *mut Fm1, bytes: *const u8, len: u32, offset: u32) {
    let Some(f) = get(h) else { return };
    if bytes.is_null() || len == 0 { return; }
    let r = &mut *f.render.get();
    let frame = r.taken + (offset as f64 * r.ratio) as u64 + r.lead as u64;
    let b = std::slice::from_raw_parts(bytes, len as usize);
    for chunk in b.chunks(3) {
        let mut m = Midi { frame, bytes: [0; 3], len: chunk.len() as u8 };
        m.bytes[..chunk.len()].copy_from_slice(chunk);
        let _ = r.midi.push(m);
    }
}

/// Fill `frames` samples of the two channels. Realtime-safe.
/// # Safety
/// Render thread only; `left` / `right` hold `frames` floats.
#[no_mangle]
pub unsafe extern "C" fn fm1_render(h: *mut Fm1, left: *mut f32, right: *mut f32, frames: u32) {
    let Some(f) = get(h) else { return };
    if left.is_null() || right.is_null() { return; }
    let r = &mut *f.render.get();
    let (l, rr) = (std::slice::from_raw_parts_mut(left, frames as usize), std::slice::from_raw_parts_mut(right, frames as usize));
    let mut starved = 0;
    for i in 0..frames as usize {
        r.frac += r.ratio;
        while r.frac >= 1.0 {
            match r.audio.pop() {
                Ok(x) => { r.cur = r.next; r.next = x; r.taken += 1; r.frac -= 1.0; }
                Err(_) => { r.frac = r.frac.min(1.0); starved += 1; break; }
            }
        }
        let t = r.frac.min(1.0) as f32;
        l[i] = r.cur[0] + (r.next[0] - r.cur[0]) * t;
        rr[i] = r.cur[1] + (r.next[1] - r.cur[1]) * t;
    }
    if starved > 0 { f.shared.starved.fetch_add(starved, Ordering::Relaxed); }
}

/// The next message for the host's MIDI out (the Launchpad's lights): its length, copied into
/// `buf`, or 0 when there is none (or `cap` is too small: it is dropped). Realtime-safe.
/// # Safety
/// Render thread only; `buf` holds `cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn fm1_midi_out(h: *mut Fm1, buf: *mut u8, cap: u32) -> u32 {
    let Some(f) = get(h) else { return 0 };
    let r = &mut *f.render.get();
    if r.out.slots() < 2 { return 0; }
    let lo = r.out.pop().unwrap_or(0) as usize;
    let hi = r.out.pop().unwrap_or(0) as usize;
    let n = lo | hi << 8;
    let fits = n <= cap as usize && !buf.is_null();
    for i in 0..n {
        let b = r.out.pop().unwrap_or(0);
        if fits { *buf.add(i) = b; }
    }
    if fits { n as u32 } else { 0 }
}

// ---------------------------------------------------------------- firmware and settings

/// Boot a package (.fwsc) with saved flash sectors over it (`sectors`: records of a 4-byte
/// little-endian offset and the 4096-byte sector, as `fm1_sectors_copy` gives them). 0 when it
/// runs; otherwise -1 and the reason in `err` (NUL-terminated).
/// # Safety
/// The pointers hold their lengths; `err` may be null.
#[no_mangle]
pub unsafe extern "C" fn fm1_boot(h: *mut Fm1, pkg: *const u8, len: usize, sectors: *const u8, sectors_len: usize,
                                  err: *mut u8, err_cap: usize) -> i32 {
    let Some(f) = get(h) else { return -1 };
    let fail = |msg: &str| {
        if !err.is_null() && err_cap > 0 {
            let n = msg.len().min(err_cap - 1);
            std::ptr::copy_nonoverlapping(msg.as_ptr(), err, n);
            *err.add(n) = 0;
        }
        -1
    };
    if pkg.is_null() || len == 0 { return fail("no package"); }
    let pkg = Arc::new(std::slice::from_raw_parts(pkg, len).to_vec());
    let s = if sectors.is_null() { &[][..] } else { std::slice::from_raw_parts(sectors, sectors_len) };
    let Some(sectors) = unpack_sectors(s) else { return fail("invalid saved flash") };
    let (tx, rx) = mpsc::channel();
    f.send(Cmd::Boot { pkg, sectors, reply: tx });
    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(())) => 0,
        Ok(Err(e)) => fail(&e),
        Err(_) => fail("the machine did not answer"),
    }
}

pub fn unpack_sectors(s: &[u8]) -> Option<Vec<(u32, Vec<u8>)>> {
    if s.len() % (4 + SECTOR) != 0 { return None; }
    s.chunks(4 + SECTOR).map(|c| {
        let at = u32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        (at as usize % SECTOR == 0 && (at as usize) < fm1_soc::FLASH_SIZE).then(|| (at, c[4..].to_vec()))
    }).collect()
}

pub fn pack_sectors(s: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let mut v = Vec::with_capacity(s.len() * (4 + SECTOR));
    for (at, d) in s { v.extend_from_slice(&at.to_le_bytes()); v.extend_from_slice(d); }
    v
}

/// What the firmware has written to its flash (its patches and settings), for the host's project:
/// waits for the flash to be idle (at most ~2 s), keeps the records and returns their size in
/// bytes; `fm1_sectors_copy` then copies them.
/// # Safety
/// `h` from `fm1_new`.
#[no_mangle]
pub unsafe extern "C" fn fm1_sectors_snapshot(h: *mut Fm1) -> usize {
    let Some(f) = get(h) else { return 0 };
    let (tx, rx) = mpsc::channel();
    f.send(Cmd::Sectors(tx));
    let s = rx.recv_timeout(Duration::from_secs(3)).unwrap_or_else(|_| f.shared.saved.lock().unwrap().1.clone());
    let packed = pack_sectors(&s);
    let n = packed.len();
    *f.sectors.lock().unwrap() = packed;
    n
}

/// # Safety
/// `out` holds `cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn fm1_sectors_copy(h: *mut Fm1, out: *mut u8, cap: usize) -> usize {
    let Some(f) = get(h) else { return 0 };
    let s = f.sectors.lock().unwrap();
    let n = s.len().min(cap);
    if !out.is_null() { std::ptr::copy_nonoverlapping(s.as_ptr(), out, n); }
    n
}

/// # Safety
/// `h` from `fm1_new`.
#[no_mangle]
pub unsafe extern "C" fn fm1_set(h: *mut Fm1, what: u32, value: i32) {
    let Some(f) = get(h) else { return };
    let st = &f.shared.settings;
    match what {
        // the clock in MHz (the machine boots again with its flash)
        0 => st.mhz.store(value.clamp(20, 480) as u32, Ordering::Relaxed),
        // MASTER 0..1023
        1 => st.pot.store(value.clamp(0, 1023) as u32, Ordering::Relaxed),
        // MIDI channel 0 (as sent) .. 16
        2 => st.channel.store(value.clamp(0, 16) as u32, Ordering::Relaxed),
        // lead frames beyond a host block (latency); takes effect at the next fm1_prepare
        3 => st.lead.store(value.clamp(128, 4096) as u32, Ordering::Relaxed),
        // controller layout: 0 none, 1 Launchpad X, 2 MPK
        4 => { st.layout.store(value as u32, Ordering::Relaxed); f.send(Cmd::Layout(mapper::Layout::from_u32(value as u32))); }
        // notes play the FM-1's own keys
        5 => f.send(Cmd::PanelKeys(value != 0)),
        _ => {}
    }
}

/// A matrix key (buttons 0..13, note keys 14..40) from the window.
/// # Safety
/// `h` from `fm1_new`.
#[no_mangle]
pub unsafe extern "C" fn fm1_key(h: *mut Fm1, id: u32, down: bool) {
    if let Some(f) = get(h) { f.send(Cmd::Key { id: id as u8, down }); }
}

/// A panel encoder (0 SELECT, 1 PRESETS, 2 ALGORITHM, 3..6 KNOB1..4) turned from the window.
/// # Safety
/// `h` from `fm1_new`.
#[no_mangle]
pub unsafe extern "C" fn fm1_enc(h: *mut Fm1, enc: u32, clicks: i32) {
    if let Some(f) = get(h) { f.send(Cmd::Enc { enc: enc as u8, clicks }); }
}

/// # Safety
/// `out` points to an Fm1Status.
#[no_mangle]
pub unsafe extern "C" fn fm1_status(h: *const Fm1, out: *mut Fm1Status) {
    let (Some(f), Some(out)) = (get(h), out.as_mut()) else { return };
    let v = f.shared.view.lock().unwrap();
    let st = &f.shared.settings;
    *out = Fm1Status {
        booted: v.booted, halted: v.halted, speed: v.speed, starved: f.shared.starved.load(Ordering::Relaxed),
        board: (v.board == fm1_soc::Board::Smk37) as u32, mhz: st.mhz.load(Ordering::Relaxed), pot: st.pot.load(Ordering::Relaxed),
        panel_keys: st.panel_keys.load(Ordering::Relaxed), octave: st.octave.load(Ordering::Relaxed), lcd_rev: v.lcd_rev,
    };
}

// ---------------------------------------------------------------- the front panel

#[no_mangle]
pub extern "C" fn fm1_panel_width() -> u32 { panel::W as u32 }
#[no_mangle]
pub extern "C" fn fm1_panel_height() -> u32 { panel::H as u32 }

/// The window's own state for the drawing: 0 a key held (id), 1 an encoder's clicks (index),
/// 3 a knob's glow (index; frames left).
/// # Safety
/// `h` from `fm1_new`.
#[no_mangle]
pub unsafe extern "C" fn fm1_panel_set(h: *mut Fm1, kind: u32, i: u32, v: i32) {
    let Some(f) = get(h) else { return };
    let mut p = f.panel.lock().unwrap();
    match kind {
        0 if i < 64 => p.down[i as usize] = v != 0,
        1 if i < 8 => p.enc[i as usize] = v,
        3 if i < 9 => p.turn[i as usize] = v.max(0) as u32,
        _ => {}
    }
}

/// Draw the FM-1's panel with the machine's screen and LEDs: RGBA bytes, width * height * 4,
/// valid until the next call.
/// # Safety
/// `h` from `fm1_new`.
#[no_mangle]
pub unsafe extern "C" fn fm1_panel_draw(h: *mut Fm1) -> *const u8 {
    let Some(f) = get(h) else { return std::ptr::null() };
    let mut guard = f.panel.lock().unwrap();
    let p = &mut *guard;
    {
        let v = f.shared.view.lock().unwrap();
        p.lcd.copy_from_slice(&v.lcd);
        // LEDs: take the brightest of what the machine reported lately (led_take is a share of time on)
        p.leds = v.leds;
    }
    if p.base.is_empty() {
        p.base = panel::base();
        p.buf = vec![0; p.base.len()];
    }
    let pot = f.shared.settings.pot.load(Ordering::Relaxed) as u16;
    let st = panel::State { lcd: &p.lcd, enc_clicks: &std::array::from_fn(|i| p.enc[i]), pot, down: &std::array::from_fn(|i| p.down[i]),
        leds: &p.leds, turning: &std::array::from_fn(|i| p.turn[i]) };
    panel::draw(&mut p.buf, &p.base, &st);
    for t in p.turn.iter_mut() { *t = t.saturating_sub(1); }
    for px in p.buf.iter_mut() {
        let (r, g, b) = ((*px >> 16) & 255, (*px >> 8) & 255, *px & 255);
        *px = r | g << 8 | b << 16 | 0xff00_0000;
    }
    p.buf.as_ptr() as *const u8
}

/// What is at (x, y) in panel pixels: -1 nothing, 0..6 an encoder (panel index), 7 MASTER,
/// 100 + id a button or key.
#[no_mangle]
pub extern "C" fn fm1_panel_hit(x: f32, y: f32) -> i32 {
    match panel::hit(x, y) {
        Some(panel::Ctl::Enc(i)) => i as i32,
        Some(panel::Ctl::Pot) => 7,
        Some(panel::Ctl::Btn(id)) | Some(panel::Ctl::Key(id)) => 100 + id as i32,
        None => -1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sectors_pack_and_unpack() {
        let s = vec![(0x1000u32, vec![7u8; SECTOR]), (0xf9000, vec![1; SECTOR])];
        assert_eq!(unpack_sectors(&pack_sectors(&s)).unwrap(), s);
        assert!(unpack_sectors(&[1, 2, 3]).is_none());
        let mut bad = pack_sectors(&s);
        bad[0] = 1;
        assert!(unpack_sectors(&bad).is_none());
    }

    /// FM1_TEST_FWSC=package: boot it, play a note, render a second of audio at 48 kHz through
    /// the render side, as an AU host would, and draw the panel.
    #[test]
    fn a_package_boots_renders_and_draws() {
        let Ok(path) = std::env::var("FM1_TEST_FWSC") else { return };
        let pkg = std::fs::read(path).unwrap();
        unsafe {
            let h = fm1_new();
            fm1_set(h, 0, 100);
            fm1_prepare(h, 48_000.0, 512);
            let mut err = [0u8; 200];
            assert_eq!(fm1_boot(h, pkg.as_ptr(), pkg.len(), std::ptr::null(), 0, err.as_mut_ptr(), err.len()), 0);
            assert!(fm1_boot(h, [1u8; 64].as_ptr(), 64, std::ptr::null(), 0, err.as_mut_ptr(), err.len()) < 0);
            assert_eq!(fm1_boot(h, pkg.as_ptr(), pkg.len(), std::ptr::null(), 0, err.as_mut_ptr(), err.len()), 0);
            assert!(fm1_latency(h) > 512);
            let (mut l, mut r) = (vec![0f32; 512], vec![0f32; 512]);
            let mut peak = 0f32;
            let start = std::time::Instant::now();
            for block in 0..400 {
                if block == 150 { fm1_midi(h, [0x90, 60, 110].as_ptr(), 3, 0); }
                fm1_render(h, l.as_mut_ptr(), r.as_mut_ptr(), 512);
                peak = l.iter().chain(&r).fold(peak, |p, s| p.max(s.abs()));
                std::thread::sleep(Duration::from_micros(10_667));   // a 512-sample block at 48 kHz
            }
            let mut s: Fm1Status = std::mem::zeroed();
            fm1_status(h, &mut s);
            eprintln!("rendered {:.1} s in {:.1} s; speed {:.2}x; starved {}; peak {peak}", 400.0 * 512.0 / 48_000.0,
                start.elapsed().as_secs_f32(), s.speed, s.starved);
            assert!(s.booted && !s.halted);
            assert!(s.speed > 1.0, "the machine keeps up");
            let px = fm1_panel_draw(h);
            assert!(!px.is_null());
            let lcd_lit = (&*h).shared.view.lock().unwrap().lcd.iter().any(|&p| p != 0);
            assert!(lcd_lit, "the screen shows something");
            assert!(fm1_sectors_snapshot(h) % (4 + SECTOR) == 0);
            assert_eq!(fm1_panel_hit(250.0, 135.0), 0);      // SELECT
            fm1_free(h);
        }
    }

    #[test]
    fn launchpad_lights_reach_the_midi_out() {
        let Ok(path) = std::env::var("FM1_TEST_FWSC") else { return };
        let pkg = std::fs::read(path).unwrap();
        unsafe {
            let h = fm1_new();
            fm1_prepare(h, 44_100.0, 256);
            assert_eq!(fm1_boot(h, pkg.as_ptr(), pkg.len(), std::ptr::null(), 0, std::ptr::null_mut(), 0), 0);
            fm1_set(h, 4, 1);
            let (mut l, mut r) = (vec![0f32; 256], vec![0f32; 256]);
            let mut msgs = Vec::new();
            let mut buf = [0u8; 1024];
            for _ in 0..100 {
                fm1_render(h, l.as_mut_ptr(), r.as_mut_ptr(), 256);
                loop {
                    let n = fm1_midi_out(h, buf.as_mut_ptr(), buf.len() as u32);
                    if n == 0 { break; }
                    msgs.push(buf[..n as usize].to_vec());
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(msgs.first().map(|m| m.as_slice()), Some(&mapper::LPX_PROGRAMMER[..]));
            assert!(msgs.iter().any(|m| m.len() > 100 && m[6] == 3), "RGB SysEx for the pads");
            // a pad press from the Launchpad: PLAY
            fm1_midi(h, [0x90, 75, 100].as_ptr(), 3, 0);
            fm1_render(h, l.as_mut_ptr(), r.as_mut_ptr(), 256);
            fm1_free(h);
        }
    }
}
