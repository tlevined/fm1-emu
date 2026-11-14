//! The emulated FM-1 on a thread of its own, a little ahead of the host (as the desktop plugin's
//! crates/fm1-plugin/src/engine.rs, which this follows): it keeps a ring of its 44.1 kHz frames
//! `lead` frames ahead of what the render block has taken; the host's MIDI reaches it stamped with
//! the frame it is due at. Controller layouts (mapper.rs) are applied here, and the Launchpad's
//! lights go out through a byte ring the render block hands to the host.

use crate::mapper::{self, Act, Layout, Mapper};
use fm1_core::{Bus, Cpu};
use fm1_soc::{machine, Action, Board, Soc};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const RAM_BASE: u32 = 0x01c0_0000;
const RAM_SIZE: usize = 1 << 20;
pub const RATE: f64 = 44_100.0;
pub const SECTOR: usize = 4096;
/// The matrix encoder of each panel encoder (fm1-live's panel::ENCS)
const ENC_IDS: [u8; 7] = [0, 6, 1, 2, 3, 4, 5];

#[derive(Clone, Copy, Default)]
pub struct Midi {
    pub frame: u64,
    pub bytes: [u8; 3],
    pub len: u8,
}

pub type Sectors = Vec<(u32, Vec<u8>)>;

pub enum Cmd {
    Boot { pkg: Arc<Vec<u8>>, sectors: Sectors, reply: mpsc::Sender<Result<(), String>> },
    Key { id: u8, down: bool },
    /// a panel encoder (index in the panel's list)
    Enc { enc: u8, clicks: i32 },
    /// a long message from the host (SysEx): straight into the jack
    Long(Vec<u8>),
    Block(usize),
    Layout(Layout),
    PanelKeys(bool),
    /// the flash sectors the firmware has written, once its flash is idle
    Sectors(mpsc::Sender<Sectors>),
}

/// What the window and the plugin read.
pub struct View {
    pub lcd: Vec<u16>,
    pub lcd_rev: u64,
    pub leds: [f32; 41],
    pub board: Board,
    pub booted: bool,
    pub halted: bool,
    pub speed: f32,
}

/// Settings anyone may change; the thread reads them every round.
pub struct Settings {
    pub mhz: AtomicU32,
    /// MASTER 0..1023
    pub pot: AtomicU32,
    /// 0: as sent, else every channel message moved to this channel
    pub channel: AtomicU32,
    /// frames beyond a host block the machine runs ahead
    pub lead: AtomicU32,
    pub layout: AtomicU32,
    pub panel_keys: AtomicBool,
    pub octave: AtomicI32,
}

pub struct Shared {
    pub view: Mutex<View>,
    pub settings: Settings,
    pub quit: AtomicBool,
    pub starved: AtomicU64,
    /// the package running and what its flash holds that the package's did not (for the host's project)
    pub saved: Mutex<(Option<Arc<Vec<u8>>>, Sectors)>,
}

impl Shared {
    pub fn new() -> Self {
        Shared {
            view: Mutex::new(View { lcd: vec![0; 240 * 240], lcd_rev: 0, leds: [0.0; 41], board: Board::Fm1, booted: false, halted: false, speed: 0.0 }),
            settings: Settings { mhz: AtomicU32::new(100), pot: AtomicU32::new(900), channel: AtomicU32::new(0), lead: AtomicU32::new(1024),
                layout: AtomicU32::new(0), panel_keys: AtomicBool::new(false), octave: AtomicI32::new(0) },
            quit: AtomicBool::new(false),
            starved: AtomicU64::new(0),
            saved: Mutex::new((None, Vec::new())),
        }
    }
}

struct Machine {
    cpu: Cpu,
    cpu1: Option<Cpu>,
    soc: Soc,
    pending_tick: bool,
    halted: bool,
    flash0: Vec<u8>,
    jit: bool,
}

impl Machine {
    fn boot(pkg: &[u8], sectors: &[(u32, Vec<u8>)], mhz: u64) -> Result<Self, String> {
        for (at, data) in sectors {
            if *at as usize % SECTOR != 0 || data.len() != SECTOR || *at as usize + SECTOR > fm1_soc::FLASH_SIZE {
                return Err("invalid saved flash".into());
            }
        }
        let st = std::panic::catch_unwind(|| fm1_soc::stock_from_package(pkg, None))
            .map_err(|_| "malformed firmware package".to_owned())??;
        let mut soc = Soc::new(RAM_SIZE, st.xip);
        soc.periph.hz = mhz * 1_000_000;
        soc.periph.skip_idle = true;
        let mut cpu = Cpu::new(st.entry);
        // iOS lets no app make machine code at run time: the interpreter there (fm1-core's build.rs
        // builds no native JIT for it). Elsewhere (the tests on a desktop) the JIT as the plugin has it.
        let jit = !cfg!(target_os = "ios") && std::env::var("FM1_NO_JIT").is_err();
        cpu.jit_on = jit;
        cpu.user = true;
        let params = RAM_BASE + 0x7fc00;
        soc.write32(params, params + 0x40);
        cpu.regs[0] = fm1_soc::stock_boot(&mut soc, &st.flash, params, st.board);
        let flash0 = soc.flash.mem.clone();
        restore_flash(&mut soc, sectors);
        Ok(Machine { cpu, cpu1: None, soc, pending_tick: false, halted: false, flash0, jit })
    }

    fn run(&mut self, n: u32) {
        let jit = self.jit;
        let Machine { cpu, cpu1, soc, pending_tick, .. } = self;
        if machine::run_dual(cpu1, soc, n, RAM_SIZE, jit, |soc, k| machine::run_blocks(cpu, soc, k, pending_tick)).is_err() {
            self.halted = true;
        }
    }

    fn changed_sectors(&self) -> Sectors {
        let (now, then) = (&self.soc.flash.mem, &self.flash0);
        (0..now.len().min(then.len()) / SECTOR)
            .filter(|s| now[s * SECTOR..(s + 1) * SECTOR] != then[s * SECTOR..(s + 1) * SECTOR])
            .map(|s| ((s * SECTOR) as u32, now[s * SECTOR..(s + 1) * SECTOR].to_vec()))
            .collect()
    }

    fn apply(&mut self, a: Action) { self.soc.periph.apply(&a); }
}

fn restore_flash(soc: &mut Soc, sectors: &[(u32, Vec<u8>)]) {
    for (at, data) in sectors {
        let at = *at as usize;
        soc.flash.mem[at..at + data.len()].copy_from_slice(data);
        let from = at.max(fm1_soc::XIP_FLASH_OFFSET);
        let end = (at + data.len()).min(fm1_soc::XIP_FLASH_OFFSET + soc.xip.len());
        if from < end {
            soc.xip[from - fm1_soc::XIP_FLASH_OFFSET..end - fm1_soc::XIP_FLASH_OFFSET].copy_from_slice(&data[from - at..end - at]);
        }
    }
}

fn rtrb_fill(p: &rtrb::Producer<[f32; 2]>) -> usize { p.buffer().capacity() - p.slots() }

/// A message for the host's MIDI out, framed as a 2-byte length and the bytes.
fn push_out(out: &mut rtrb::Producer<u8>, msg: &[u8]) {
    if out.slots() < msg.len() + 2 { return; }      // (the host is not taking them: drop)
    let n = msg.len() as u16;
    let _ = out.push((n & 0xff) as u8);
    let _ = out.push((n >> 8) as u8);
    for &b in msg { let _ = out.push(b); }
}

/// The thread: commands in, MIDI in (stamped), frames and MIDI out.
pub fn run(shared: Arc<Shared>, cmds: mpsc::Receiver<Cmd>, mut midi_in: rtrb::Consumer<Midi>,
           mut out: rtrb::Producer<[f32; 2]>, mut midi_out: rtrb::Producer<u8>) {
    let st = &shared.settings;
    let mut m: Option<Machine> = None;
    let mut active: Option<Arc<Vec<u8>>> = None;
    let mut block = 1024usize;
    let mut made: u64 = 0;
    let mut due: VecDeque<Midi> = VecDeque::new();
    let mut pot = u32::MAX;
    let mut mapper = Mapper::new(Layout::None);
    let mut repeats: HashMap<u16, (Act, Instant)> = HashMap::new();
    let mut lights: HashMap<u8, [u8; 3]> = HashMap::new();
    let mut want_programmer = false;
    let mut pending_sectors: Vec<(mpsc::Sender<Sectors>, Instant)> = Vec::new();
    let (mut last_view, mut last_take, mut last_flash, mut last_lights) = (Instant::now(), Instant::now(), Instant::now(), Instant::now());
    let mut free: Option<(Instant, u64)> = None;
    let (mut speed_t, mut speed_ms, mut busy) = (Instant::now(), 0u64, Duration::ZERO);
    let mut long: Vec<u8> = Vec::new();

    // what a mapped action does to the machine
    let act = |m: &mut Option<Machine>, a: &Act, st: &Settings| {
        let Some(mm) = m.as_mut() else { return };
        match a {
            Act::Key { id, down } => mm.apply(Action::Key { id: *id, down: *down }),
            Act::Turn { enc, clicks } => if let Some(&e) = ENC_IDS.get(*enc as usize) { mm.apply(Action::Enc { enc: e, clicks: *clicks }) },
            Act::Pot(v) => st.pot.store(*v as u32, Ordering::Relaxed),
            Act::PotStep(d) => {
                let v = (st.pot.load(Ordering::Relaxed) as i32 + d).clamp(0, 1023);
                st.pot.store(v as u32, Ordering::Relaxed);
            }
            Act::Jack(bytes) => {
                let ch = st.channel.load(Ordering::Relaxed) as u8;
                for (i, &b) in bytes.iter().enumerate() {
                    let b = if i == 0 && ch != 0 && (0x80..0xf0).contains(&b) { (b & 0xf0) | (ch - 1) } else { b };
                    mm.apply(Action::Midi { b });
                }
            }
            Act::Repeat { .. } | Act::Stop { .. } => {}
        }
    };

    while !shared.quit.load(Ordering::Relaxed) {
        while let Ok(c) = cmds.try_recv() {
            match c {
                Cmd::Boot { pkg, sectors, reply } => {
                    match Machine::boot(&pkg, &sectors, st.mhz.load(Ordering::Relaxed) as u64) {
                        Ok(next) => {
                            m = Some(next);
                            active = Some(pkg.clone());
                            *shared.saved.lock().unwrap() = (Some(pkg), sectors);
                            let _ = reply.send(Ok(()));
                        }
                        Err(e) => { let _ = reply.send(Err(e)); continue; }
                    }
                    pot = u32::MAX;
                    due.clear();
                    repeats.clear();
                    let mut v = shared.view.lock().unwrap();
                    v.booted = true;
                    v.halted = false;
                    v.speed = 0.0;
                    v.board = m.as_ref().map_or(Board::Fm1, |m| m.soc.board);
                    (speed_t, speed_ms, busy) = (Instant::now(), 0, Duration::ZERO);
                }
                Cmd::Key { id, down } => act(&mut m, &Act::Key { id, down }, st),
                Cmd::Enc { enc, clicks } => act(&mut m, &Act::Turn { enc, clicks }, st),
                Cmd::Long(bytes) => act(&mut m, &Act::Jack(bytes), st),
                Cmd::Block(b) => block = b,
                Cmd::Layout(l) => {
                    if mapper.layout == Layout::LaunchpadX && l != Layout::LaunchpadX { push_out(&mut midi_out, &mapper::LPX_LIVE); }
                    mapper.set_layout(l);
                    lights.clear();
                    want_programmer = l == Layout::LaunchpadX;
                }
                Cmd::PanelKeys(on) => { mapper.panel_keys = on; lights.clear(); }
                Cmd::Sectors(reply) => pending_sectors.push((reply, Instant::now())),
            }
        }
        if want_programmer {
            push_out(&mut midi_out, &mapper::LPX_PROGRAMMER);
            want_programmer = false;
        }
        // a new clock: the timers count its cycles, so boot again with what the firmware wrote
        let mhz = st.mhz.load(Ordering::Relaxed) as u64;
        if let (Some(mm), Some(pkg)) = (m.as_ref(), active.as_ref()) {
            if mm.soc.periph.hz != mhz * 1_000_000 && !mm.soc.flash.busy() {
                let sectors = mm.changed_sectors();
                if let Ok(next) = Machine::boot(pkg, &sectors, mhz) {
                    m = Some(next);
                    pot = u32::MAX;
                    due.clear();
                }
            }
        }
        let p = st.pot.load(Ordering::Relaxed).min(1023);
        if p != pot && m.as_ref().is_some_and(|m| m.soc.board == Board::Fm1) {
            pot = p;
            if let Some(mm) = m.as_mut() { mm.apply(Action::Adc { ch: 4, value: p as u16 }); }
        }
        // held pads repeat
        let now = Instant::now();
        let fire: Vec<Act> = repeats.values_mut().filter(|(_, at)| *at <= now)
            .map(|(a, at)| { *at = now + Duration::from_millis(70); a.clone() }).collect();
        for a in &fire { act(&mut m, a, st); }

        while let Ok(e) = midi_in.pop() { due.push_back(e); }
        // the flash's sectors for the host's project, once nothing is being written
        if !pending_sectors.is_empty() {
            let idle = m.as_ref().map_or(true, |mm| !mm.soc.flash.busy());
            pending_sectors.retain(|(reply, at)| {
                if idle || at.elapsed() > Duration::from_secs(2) {
                    let s = m.as_ref().map(|mm| mm.changed_sectors()).unwrap_or_default();
                    shared.saved.lock().unwrap().1 = s.clone();
                    let _ = reply.send(s);
                    false
                } else { true }
            });
        }

        let lead = block + st.lead.load(Ordering::Relaxed) as usize;
        let Some(mm) = m.as_mut().filter(|m| !m.halted) else {
            while out.slots() > 0 && rtrb_fill(&out) < lead { let _ = out.push([0.0, 0.0]); made += 1; }
            due.retain(|e| e.frame > made);
            std::thread::sleep(Duration::from_millis(2));
            continue;
        };
        let fill = rtrb_fill(&out);
        if fill < lead { last_take = Instant::now(); free = None; }
        if fill >= lead && last_take.elapsed() >= Duration::from_millis(50) {
            // the host takes no audio: run on in real time, the audio dropped, as the device would
            let (t0, ms0) = *free.get_or_insert((Instant::now(), mm.soc.periph.ms()));
            if mm.soc.periph.ms() - ms0 < t0.elapsed().as_millis() as u64 {
                let t1 = Instant::now();
                mm.run(20_000);
                busy += t1.elapsed();
                mm.soc.periph.audio.clear();
            } else {
                std::thread::sleep(Duration::from_millis(1));
            }
        } else if fill >= lead {
            std::thread::sleep(Duration::from_micros(500));
        } else {
            while due.front().is_some_and(|e| e.frame <= made) {
                let e = due.pop_front().unwrap();
                let bytes = &e.bytes[..e.len as usize];
                // SysEx in pieces of 3 (as the render block passes it): gathered, then into the jack
                if bytes.first() == Some(&0xf0) || !long.is_empty() {
                    long.extend_from_slice(bytes);
                    if long.contains(&0xf7) || long.len() > 4096 {
                        let msg = std::mem::take(&mut long);
                        act(&mut m, &Act::Jack(msg), st);
                    }
                    continue;
                }
                for a in mapper.handle(bytes) {
                    match a {
                        Act::Repeat { src, act: inner } => {
                            act(&mut m, &inner, st);
                            repeats.insert(src, (*inner, Instant::now() + Duration::from_millis(350)));
                        }
                        Act::Stop { src } => { repeats.remove(&src); }
                        a => act(&mut m, &a, st),
                    }
                }
            }
            st.panel_keys.store(mapper.panel_keys, Ordering::Relaxed);
            st.octave.store(mapper.octave, Ordering::Relaxed);
            let Some(mm) = m.as_mut() else { continue };
            let t0 = Instant::now();
            mm.run(20_000);
            busy += t0.elapsed();
            let a = std::mem::take(&mut mm.soc.periph.audio);
            for f in a.chunks_exact(2) {
                if out.push([f[0] as f32 / 32768.0, f[1] as f32 / 32768.0]).is_ok() { made += 1; }
            }
        }
        let Some(mm) = m.as_mut() else { continue };
        if last_view.elapsed() >= Duration::from_millis(30) {
            last_view = Instant::now();
            let mut v = shared.view.lock().unwrap();
            if v.lcd != mm.soc.lcd.fb { v.lcd.copy_from_slice(&mm.soc.lcd.fb); v.lcd_rev += 1; }
            if mm.soc.board == Board::Fm1 { v.leds = mm.soc.periph.led_take(); }
            v.halted = mm.halted;
            if speed_t.elapsed() >= Duration::from_secs(1) {
                let ms = mm.soc.periph.ms();
                if speed_ms > 0 && busy > Duration::ZERO {
                    v.speed = ms.saturating_sub(speed_ms) as f32 / busy.as_secs_f32() / 1000.0;
                }
                (speed_t, speed_ms, busy) = (Instant::now(), ms.max(1), Duration::ZERO);
            }
            // the Launchpad shows the LEDs and what each pad does
            if mapper.layout == Layout::LaunchpadX && last_lights.elapsed() >= Duration::from_millis(40) {
                last_lights = Instant::now();
                let changed: Vec<(u8, [u8; 3])> = mapper::launchpad_colours(&mapper, &v.leds).into_iter()
                    .filter(|(i, c)| lights.get(i) != Some(c)).collect();
                drop(v);
                for chunk in changed.chunks(40) {
                    if midi_out.slots() < 220 { break; }
                    for (i, c) in chunk { lights.insert(*i, *c); }
                    push_out(&mut midi_out, &mapper::lpx_rgb(chunk));
                }
            }
        }
        if last_flash.elapsed() >= Duration::from_secs(2) && !mm.soc.flash.busy() {
            last_flash = Instant::now();
            let now = mm.changed_sectors();
            let mut s = shared.saved.lock().unwrap();
            if s.1 != now { s.1 = now; }
        }
    }
    if mapper.layout == Layout::LaunchpadX { push_out(&mut midi_out, &mapper::LPX_LIVE); }
}
