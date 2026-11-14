// MIDI controllers as FM-1 front panels: an Akai MPK (mini) and a Novation Launchpad X, each with a
// layout of its own, plus MIDI learn for any other knob or pad. A controller this page knows is
// "claimed": its messages go through a mapper (knobs turn the FM-1's encoders, pads press its
// buttons, keys play its keys or its MIDI IN jack) and do not also arrive through the "MIDI in"
// picker. The Launchpad shows the FM-1's LEDs and what each pad does.
//
// The mapper is pure (controllers.test.mjs): MIDI bytes in, actions out:
//   { type: "key", id, down }  a matrix key (buttons 0..13, note keys 14..40 = F3..G5)
//   { type: "turn", enc, clicks }  an encoder (0 SELECT, 1 PRESETS, 2 ALGORITHM, 3..6 KNOB1..4)
//   { type: "pot", value } / { type: "potstep", delta }  MASTER (0..1023)
//   { type: "jack", bytes }  into the emulated MIDI IN jack
//   { type: "repeat", ... } wraps a turn / potstep to repeat while a pad is held

export const ENCODERS = ["SELECT", "PRESETS", "ALGORITHM", "KNOB1", "KNOB2", "KNOB3", "KNOB4"];
export const BUTTONS = ["OCT-", "OCT+", "FX", "SCL", "ENV", "LFO", "EDIT", "GLO", "HOME", "SAVE", "ARP", "SEQ", "PLAY", "REC"];
const B = Object.fromEntries(BUTTONS.map((n, i) => [n, i]));
const F3 = 53, G5 = 79, KEY0 = 14;

// every target a control can be learned to, with its words
export function targets() {
  const t = [{ id: "jack", label: "MIDI IN jack (pass through)" }, { id: "ignore", label: "Nothing (ignore)" }];
  ENCODERS.forEach((n, i) => t.push({ id: `enc:${i}`, label: `${n} knob (turn)` }, { id: `step:${i}:-1`, label: `${n} one step left (pad)` },
    { id: `step:${i}:1`, label: `${n} one step right (pad)` }));
  t.push({ id: "pot", label: "MASTER volume" });
  BUTTONS.forEach((n, i) => t.push({ id: `btn:${i}`, label: `${n} button` }));
  t.push({ id: "octave:1", label: "Controller octave up" }, { id: "octave:-1", label: "Controller octave down" },
    { id: "mode", label: "Toggle notes: jack / FM-1 keys" });
  return t;
}

// a message's source, the key bindings use: "cc:<ch>:<n>" / "note:<ch>:<n>" (ch 1..16)
export function sourceOf(bytes) {
  const st = bytes[0] & 0xf0, ch = (bytes[0] & 0x0f) + 1;
  if (st === 0xb0) return `cc:${ch}:${bytes[1]}`;
  if (st === 0x90 || st === 0x80) return `note:${ch}:${bytes[1]}`;
  return null;
}

// ---------------------------------------------------------------- profiles
// Akai MPK mini (MK3 factory program; mk2, Plus and the larger MPKs answer the same way once their
// knobs send CC 70-77 and pads notes 36-51 on channel 10, or after MIDI learn)
const MPK = {
  id: "mpk",
  name: "Akai MPK",
  match: /\bmpk/i,
  bindings: {
    // top row K1-K4: the FM-1's four knobs; bottom row K5-K7 its big encoders, K8 MASTER
    "cc:*:70": "enc:3", "cc:*:71": "enc:4", "cc:*:72": "enc:5", "cc:*:73": "enc:6",
    "cc:*:74": "enc:0", "cc:*:75": "enc:1", "cc:*:76": "enc:2", "cc:*:77": "pot",
    // pads, bank A: bottom row the transport, top row octave and navigation
    "note:10:36": "btn:12", "note:10:37": "btn:13", "note:10:38": "btn:11", "note:10:39": "btn:10",
    "note:10:40": "btn:0", "note:10:41": "btn:1", "note:10:42": "btn:8", "note:10:43": "btn:9",
    // bank B: the edit pages, and SELECT one step either way
    "note:10:44": "btn:2", "note:10:45": "btn:3", "note:10:46": "btn:4", "note:10:47": "btn:5",
    "note:10:48": "btn:6", "note:10:49": "btn:7", "note:10:50": "step:0:-1", "note:10:51": "step:0:1",
  },
};

// Novation Launchpad X in Programmer mode: pad (row r from the bottom, column c) is note 10r + c,
// the top row's buttons CC 91-98, the right column CC 89, 79 .. 19
//   rows 1-4  two octaves of piano: white keys on rows 1 and 3, black keys above them
//   row 5     the seven encoders one step left, MASTER down;  row 6  one step right, MASTER up
//   row 7     HOME SAVE ARP SEQ PLAY REC OCT- OCT+;  row 8  FX SCL ENV LFO EDIT GLO, notes mode
//   top row   ▲ ▼ octave, ◀ ▶ SELECT
export const LP_WHITE = [0, 2, 4, 5, 7, 9, 11, 12];                         // columns 1..8
export const LP_BLACK = { 2: 1, 3: 3, 5: 6, 6: 8, 7: 10 };                   // column -> semitone
function launchpadBindings() {
  const b = {};
  for (let c = 1; c <= 8; c++) {
    for (const [row, oct] of [[1, 0], [3, 12]]) b[`note:1:${row * 10 + c}`] = `pnote:${LP_WHITE[c - 1] + oct}`;
    for (const [row, oct] of [[2, 0], [4, 12]]) b[`note:1:${row * 10 + c}`] = LP_BLACK[c] !== undefined ? `pnote:${LP_BLACK[c] + oct}` : "ignore";
    b[`note:1:${50 + c}`] = c < 8 ? `step:${c - 1}:-1` : "potstep:-64";
    b[`note:1:${60 + c}`] = c < 8 ? `step:${c - 1}:1` : "potstep:64";
  }
  ["HOME", "SAVE", "ARP", "SEQ", "PLAY", "REC", "OCT-", "OCT+"].forEach((n, i) => { b[`note:1:${71 + i}`] = `btn:${B[n]}`; });
  ["FX", "SCL", "ENV", "LFO", "EDIT", "GLO"].forEach((n, i) => { b[`note:1:${81 + i}`] = `btn:${B[n]}`; });
  b["note:1:87"] = "mode";
  b["note:1:88"] = "ignore";
  Object.assign(b, { "cc:1:91": "octave:1", "cc:1:92": "octave:-1", "cc:1:93": "step:0:-1", "cc:1:94": "step:0:1" });
  for (let r = 1; r <= 8; r++) b[`cc:1:${r * 10 + 9}`] = "ignore";
  for (let c = 95; c <= 98; c++) b[`cc:1:${c}`] = "ignore";
  return b;
}
const LAUNCHPAD = { id: "lpx", name: "Novation Launchpad X", match: /launchpad x|\blpx\b/i, bindings: launchpadBindings(), launchpad: true };

export const PROFILES = [LAUNCHPAD, MPK];
export const profileFor = (name) => PROFILES.find((p) => p.match.test(name)) || null;

// ---------------------------------------------------------------- the mapper
// `state`: { mode: "jack" | "panel", octave: -3..3, relative: bool, overrides: { source: target }, step: CC values per click }
export function createMapper(profile, state = {}) {
  const s = { mode: "jack", octave: 0, relative: false, overrides: {}, step: 2, ...state };
  const last = new Map();          // an absolute knob's last value
  const acc = new Map();           // its movement not yet a whole click
  const held = new Map();          // a note or pad down: what its release undoes

  const bindingOf = (src) => {
    if (!src) return null;
    if (s.overrides[src]) return s.overrides[src];
    if (profile?.bindings[src]) return profile.bindings[src];
    const any = src.replace(/^(\w+):\d+:/, "$1:*:");
    return profile?.bindings[any] || null;
  };

  // a played note (a key, or a Launchpad piano pad at semitone `semi` from its C)
  function note(n, vel, on, ch) {
    if (s.mode === "panel") {
      while (n < F3) n += 12;
      while (n > G5) n -= 12;
      return [{ type: "key", id: KEY0 + n - F3, down: on }];
    }
    n = Math.max(0, Math.min(127, n));
    return [{ type: "jack", bytes: [(on ? 0x90 : 0x80) | (ch - 1), n, on ? Math.max(1, vel) : 0] }];
  }

  function press(target, on, vel, ch, src) {
    const [kind, a, b] = target.split(":");
    switch (kind) {
      case "btn": return [{ type: "key", id: Number(a), down: on }];
      case "step": return on ? [{ type: "repeat", src, action: { type: "turn", enc: Number(a), clicks: Number(b) } }] : [{ type: "stop", src }];
      case "potstep": return on ? [{ type: "repeat", src, action: { type: "potstep", delta: Number(a) } }] : [{ type: "stop", src }];
      case "octave":
        if (on) s.octave = Math.max(-3, Math.min(3, s.octave + Number(a)));
        return on ? [{ type: "state" }] : [];
      case "mode":
        if (on) s.mode = s.mode === "jack" ? "panel" : "jack";
        return on ? [{ type: "state" }] : [];
      case "pnote": return note(60 + 12 * s.octave + Number(a), vel, on, ch);
      case "enc": case "pot": return [];          // (a pad learned to a knob: nothing to turn)
      default: return [];
    }
  }

  function handle(input) {
    const bytes = Array.from(input);
    const st = bytes[0] & 0xf0, ch = (bytes[0] & 0x0f) + 1;
    if (bytes[0] >= 0xf0) return bytes[0] >= 0xf8 ? [] : [{ type: "jack", bytes }];
    const src = sourceOf(bytes);
    const target = bindingOf(src);
    if (st === 0x90 || st === 0x80) {
      const on = st === 0x90 && bytes[2] > 0;
      if (!on && held.has(src)) {                  // released: undo what its press did
        const undo = held.get(src);
        held.delete(src);
        return undo;
      }
      if (!on) return target && target !== "jack" && target !== "ignore" ? press(target, false, 0, ch, src) : note(bytes[1] + (s.mode === "panel" ? 12 * s.octave : 0), 0, false, ch);
      if (target === "ignore") return [];
      const out = target && target !== "jack" ? press(target, true, bytes[2], ch, src)
        : s.mode === "panel" ? note(bytes[1] + 12 * s.octave, bytes[2], true, ch)
        : [{ type: "jack", bytes }];
      const undo = out.flatMap((a) => a.type === "key" ? [{ ...a, down: false }]
        : a.type === "jack" ? [{ type: "jack", bytes: [0x80 | (a.bytes[0] & 0x0f), a.bytes[1], 0] }]
        : a.type === "repeat" ? [{ type: "stop", src }] : []);
      if (undo.length) held.set(src, undo);
      return out;
    }
    if (st === 0xb0) {
      if (!target || target === "jack") return [{ type: "jack", bytes }];
      if (target === "ignore") return [];
      const v = bytes[2];
      if (target === "pot") return [{ type: "pot", value: Math.round(v * 1023 / 127) }];
      if (target.startsWith("enc:")) {
        const enc = Number(target.slice(4));
        let delta;
        if (s.relative) delta = v === 0 || v === 64 ? 0 : v < 64 ? v : v - 128;
        else {
          const before = last.get(src);
          last.set(src, v);
          if (before === undefined) return [];     // (its first message only says where it is)
          delta = v - before;
        }
        let a = (acc.get(src) || 0) + delta;
        const step = s.relative ? 1 : s.step;
        const clicks = Math.trunc(a / step);
        a -= clicks * step;
        acc.set(src, a);
        return clicks ? [{ type: "turn", enc, clicks }] : [];
      }
      // a button sending CC: 127 down, 0 up
      return press(target, v >= 64, 100, ch, src);
    }
    return [{ type: "jack", bytes }];              // pitch bend, aftertouch, program change…
  }

  return { handle, state: s, bindingOf, reset() { last.clear(); acc.clear(); held.clear(); } };
}

// ---------------------------------------------------------------- the Launchpad's lights
// the colour of every pad: Map(index -> [r, g, b], 0..127). `pressed`: the indices held;
// `leds`: the FM-1's 41 LED levels (0..1); `state`: the mapper's
const OFF = [0, 0, 0];
const scale = (c, f) => c.map((v) => Math.round(v * f));
export function launchpadColours(state, leds = [], pressed = new Set()) {
  const out = new Map();
  const lit = (i) => Math.max(0, Math.min(1, leds[i] || 0));
  const bindings = { ...LAUNCHPAD.bindings, ...state.overrides };
  const keyOf = (semi) => {                       // the panel key a piano pad plays, for its LED
    let n = 60 + 12 * state.octave + semi;
    while (n < F3) n += 12;
    while (n > G5) n -= 12;
    return KEY0 + n - F3;
  };
  for (let r = 1; r <= 8; r++) for (let c = 1; c <= 9; c++) {
    const idx = r * 10 + c;
    const t = c === 9 ? bindings[`cc:1:${idx}`] : bindings[`note:1:${idx}`];
    let col = OFF;
    if (!t || t === "ignore") col = OFF;
    else if (t.startsWith("pnote:")) {
      const semi = Number(t.slice(6)), black = [1, 3, 6, 8, 10].includes(semi % 12);
      col = black ? [0, 10, 60] : [36, 36, 36];
      const l = lit(keyOf(semi));
      if (l > 0.2) col = [127, 70, 0];             // the FM-1 lights this key (its sequencer's steps)
    } else if (t.startsWith("step:") || t.startsWith("potstep:")) {
      col = t.endsWith("-1") || t.endsWith("-64") ? [60, 4, 4] : [4, 60, 10];
    } else if (t.startsWith("btn:")) {
      const id = Number(t.slice(4)), l = lit(id);
      const on = id === B.PLAY ? [0, 127, 20] : id === B.REC ? [127, 0, 0] : [127, 80, 0];
      col = l > 0.05 ? scale(on, 0.25 + 0.75 * l) : [24, 24, 24];
    } else if (t === "mode") col = state.mode === "panel" ? [0, 110, 127] : [90, 0, 127];
    else if (t.startsWith("octave:")) col = [60, 60, 60];
    if (pressed.has(idx)) col = [127, 127, 127];
    out.set(idx, col);
  }
  const arrows = { 91: [60, 60, 60], 92: [60, 60, 60], 93: [100, 90, 0], 94: [100, 90, 0] };
  for (let c = 91; c <= 98; c++) {
    let col = arrows[c] || OFF;
    const t = bindings[`cc:1:${c}`];
    if (!t || t === "ignore") col = OFF;
    if (c === 91 && state.octave > 0) col = [0, 127, 40];
    if (c === 92 && state.octave < 0) col = [0, 127, 40];
    if (pressed.has(c)) col = [127, 127, 127];
    out.set(c, col);
  }
  return out;
}

// SysEx for the Launchpad X (its programmer's reference)
export const LPX = {
  programmer: [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x0e, 0x01, 0xf7],
  live: [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x0e, 0x00, 0xf7],
  // RGB for some pads: [index, r, g, b]...
  rgb: (pads) => [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c, 0x03, ...pads.flatMap(([i, [r, g, b]]) => [0x03, i, r, g, b]), 0xf7],
};
// ---------------------------------------------------------------- the running side (browser)
const KEY = "fm1pwa.ctl.";
const load = (id) => { try { return JSON.parse(localStorage.getItem(KEY + id)) || {}; } catch { return {}; } };
const save = (id, v) => { try { localStorage.setItem(KEY + id, JSON.stringify(v)); } catch { /* private mode */ } };

export function createControllers(app) {
  const devices = new Map();     // profile id -> { profile, mapper, inputs: Set, output, enabled, pressed, sent, ... }
  let access = null, sysex = false, learning = null, onUpdate = () => {};
  const repeats = new Map();

  function act(dev, actions) {
    for (const a of actions) {
      switch (a.type) {
        case "key": app.setKey(a.id, a.down); break;
        case "turn": app.turn(a.enc, a.clicks); break;
        case "pot": app.setPot(a.value); break;
        case "potstep": app.setPot(app.pot + a.delta); break;
        case "jack": app.midiIn(a.bytes); break;
        case "repeat": {
          act(dev, [a.action]);
          clearTimeout(repeats.get(a.src)?.t);
          const r = { t: 0 };
          const again = () => { act(dev, [a.action]); r.t = setTimeout(again, 70); };
          r.t = setTimeout(again, 350);
          repeats.set(a.src, r);
          break;
        }
        case "stop": clearTimeout(repeats.get(a.src)?.t); repeats.delete(a.src); break;
        case "state": persist(dev); onUpdate(); break;
      }
    }
  }
  function persist(dev) {
    const s = dev.mapper.state;
    save(dev.profile.id, { enabled: dev.enabled, mode: s.mode, octave: s.octave, relative: s.relative, overrides: s.overrides });
  }

  function onMessage(dev, e) {
    const bytes = Array.from(e.data);
    if (!bytes.length) return;
    const src = sourceOf(bytes);
    if (learning && learning.dev === dev && src && !(bytes[0] >> 4 === 0x8 || (bytes[0] >> 4 === 0x9 && bytes[2] === 0))) {
      dev.mapper.state.overrides[src] = learning.target;
      learning.done?.(src);
      learning = null;
      persist(dev);
      onUpdate();
      return;
    }
    if (!dev.enabled || (dev.profile.launchpad && !dev.programmer)) return;
    if (dev.profile.launchpad && src) {
      const idx = bytes[1];
      const st = bytes[0] & 0xf0;
      if ((st === 0x90 && bytes[2] > 0) || (st === 0xb0 && bytes[2] > 0)) dev.pressed.add(idx);
      else dev.pressed.delete(idx);
    }
    act(dev, dev.mapper.handle(bytes));
    app.midiActivity?.();
  }

  function sendLights(dev) {
    if (!dev.output || !dev.enabled || !dev.programmer) return;
    const colours = launchpadColours(dev.mapper.state, app.leds(), dev.pressed);
    const changed = [];
    for (const [i, c] of colours) {
      const k = c.join(",");
      if (dev.sent.get(i) !== k) { dev.sent.set(i, k); changed.push([i, c]); }
    }
    if (!changed.length) return;
    try {
      for (let i = 0; i < changed.length; i += 40) dev.output.send(LPX.rgb(changed.slice(i, i + 40)));
    } catch { dev.sent.clear(); /* the device went */ }
  }
  setInterval(() => { for (const dev of devices.values()) if (dev.profile.launchpad) sendLights(dev); }, 40);

  function enterProgrammer(dev) {
    // (without SysEx the Launchpad stays in its own Note mode: not claimed, it plays through "MIDI in")
    if (!dev.output || !sysex || !dev.enabled) { dev.programmer = false; return; }
    try { dev.output.send(LPX.programmer); dev.programmer = true; dev.sent.clear(); } catch { dev.programmer = false; }
  }
  function leaveProgrammer(dev) {
    if (!dev.output || !sysex || !dev.programmer) return;
    try { dev.output.send(LPX.live); } catch { /* gone */ }
    dev.programmer = false;
  }

  function scan() {
    if (!access) return;
    const seen = new Set();
    for (const input of access.inputs.values()) {
      const profile = profileFor(input.name);
      if (!profile) continue;
      seen.add(profile.id);
      let dev = devices.get(profile.id);
      if (!dev) {
        const st = load(profile.id);
        dev = { profile, inputs: new Map(), output: null, enabled: st.enabled !== false, pressed: new Set(), sent: new Map(), programmer: false,
          mapper: createMapper(profile, { mode: st.mode || "jack", octave: st.octave || 0, relative: !!st.relative, overrides: st.overrides || {} }) };
        devices.set(profile.id, dev);
      }
      if (!dev.inputs.has(input.id)) {
        const handler = (e) => onMessage(dev, e);
        input.addEventListener("midimessage", handler);
        dev.inputs.set(input.id, { input, handler });
      }
    }
    for (const dev of devices.values()) {
      if (!seen.has(dev.profile.id)) { dev.present = false; continue; }
      dev.present = true;
      if (dev.profile.launchpad) {
        const outs = [...access.outputs.values()].filter((o) => dev.profile.match.test(o.name));
        const out = outs.find((o) => /midi/i.test(o.name) && !/daw/i.test(o.name)) || outs.find((o) => !/daw/i.test(o.name)) || outs[0] || null;
        if (out !== dev.output) { dev.output = out; dev.programmer = false; }
        if (!dev.programmer) enterProgrammer(dev);
      }
    }
    app.midiRefresh?.();
    onUpdate();
  }

  async function open() {
    if (access) return true;
    if (!navigator.requestMIDIAccess) return false;
    try { access = await navigator.requestMIDIAccess({ sysex: true }); sysex = true; }
    catch {
      try { access = await navigator.requestMIDIAccess(); sysex = false; } catch { return false; }
    }
    access.addEventListener("statechange", () => scan());
    scan();
    return true;
  }

  addEventListener("pagehide", () => { for (const dev of devices.values()) leaveProgrammer(dev); });

  return {
    open,
    get supported() { return !!navigator.requestMIDIAccess; },
    get opened() { return !!access; },
    get sysex() { return sysex; },
    devices: () => [...devices.values()],
    // main.js: is this input ours (so the MIDI in picker leaves it alone)?
    claims(input) {
      const p = profileFor(input?.name || ""), d = p && devices.get(p.id);
      return !!(d && d.enabled && (!p.launchpad || d.programmer));
    },
    setEnabled(dev, on) {
      dev.enabled = on;
      if (dev.profile.launchpad) { if (on) enterProgrammer(dev); else leaveProgrammer(dev); }
      persist(dev); app.midiRefresh?.(); onUpdate();
    },
    setMode(dev, mode) { dev.mapper.state.mode = mode; persist(dev); onUpdate(); },
    setRelative(dev, on) { dev.mapper.state.relative = on; dev.mapper.reset(); persist(dev); onUpdate(); },
    learn(dev, target, done) { learning = target ? { dev, target, done } : null; },
    forget(dev, src) { delete dev.mapper.state.overrides[src]; persist(dev); onUpdate(); },
    resetMappings(dev) { dev.mapper.state.overrides = {}; persist(dev); onUpdate(); },
    onUpdate(fn) { onUpdate = fn; },
  };
}

// ---------------------------------------------------------------- the panel in the sidebar
export function mountControllers(app, ctl, box) {
  const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
    return e;
  };
  const body = el("div", { className: "ctl-body" });
  box.append(el("h2", { className: "eyebrow", id: "h-ctl" }, "Controllers"), body);
  const labels = new Map(targets().map((t) => [t.id, t.label]));
  const describe = (src) => {
    const [kind, ch, n] = src.split(":");
    return kind === "cc" ? `CC ${n} (ch ${ch})` : `note ${n} (ch ${ch})`;
  };

  function render() {
    if (!ctl.supported) {
      body.replaceChildren(el("p", { className: "ctl-note" },
        "This browser has no Web MIDI, so USB and Bluetooth MIDI controllers can't reach the page. On iPad no browser has it yet (all use Safari's engine). " +
        "Use a Web MIDI browser app on the iPad, or Chrome or Edge on a computer. Touch and the computer keyboard still play."));
      return;
    }
    if (!ctl.opened) {
      const b = el("button", { type: "button", className: "primary", textContent: "Connect MIDI controllers" });
      b.addEventListener("click", async () => {
        b.disabled = true;
        if (!await ctl.open()) body.append(el("p", { className: "ctl-note" }, "MIDI access was not given."));
        render();
      });
      body.replaceChildren(el("p", { className: "dim" }, "Akai MPK and Launchpad X get their own FM-1 layouts. Other controllers play through “MIDI in” below, or learn knobs here."), b);
      return;
    }
    const devs = ctl.devices();
    const kids = [];
    if (!ctl.sysex) kids.push(el("p", { className: "ctl-note" }, "SysEx was not allowed: the Launchpad X can't switch to its programmer layout or show the FM-1's lights. Reload and allow SysEx to use them."));
    if (!devs.length) kids.push(el("p", { className: "dim" }, "No Akai MPK or Launchpad X connected. Plug one in: it shows up here."));
    for (const dev of devs) {
      const s = dev.mapper.state;
      const on = el("input", { type: "checkbox", checked: dev.enabled });
      on.addEventListener("change", () => ctl.setEnabled(dev, on.checked));
      const mode = el("select", {}, new Option("the MIDI IN jack (velocity, any range)", "jack"), new Option("the FM-1's own keys (F3–G5)", "panel"));
      mode.value = s.mode;
      mode.addEventListener("change", () => ctl.setMode(dev, mode.value));
      mode.setAttribute("aria-label", `${dev.profile.name}: notes play`);
      const rel = el("input", { type: "checkbox", checked: s.relative });
      rel.addEventListener("change", () => ctl.setRelative(dev, rel.checked));
      const tsel = el("select", {}, ...targets().map((t) => new Option(t.label, t.id)));
      tsel.setAttribute("aria-label", "Learn a control for");
      const learnBtn = el("button", { type: "button", textContent: "Learn" });
      const learnMsg = el("span", { className: "dim", role: "status" });
      learnBtn.addEventListener("click", () => {
        if (learnBtn.dataset.on) { ctl.learn(dev, null); delete learnBtn.dataset.on; learnBtn.textContent = "Learn"; learnMsg.textContent = ""; return; }
        learnBtn.dataset.on = "1";
        learnBtn.textContent = "Cancel";
        learnMsg.textContent = "Now move a knob or press a pad on the controller…";
        ctl.learn(dev, tsel.value, (src) => { learnMsg.textContent = `${describe(src)} → ${labels.get(tsel.value)}`; });
      });
      const learned = Object.entries(s.overrides).map(([src, t]) => {
        const x = el("button", { type: "button", textContent: "✕", className: "ctl-x" });
        x.setAttribute("aria-label", `Forget ${describe(src)}`);
        x.addEventListener("click", () => ctl.forget(dev, src));
        return el("li", {}, `${describe(src)} → ${labels.get(t) || t} `, x);
      });
      const reset = el("button", { type: "button", textContent: "Reset to the layout" });
      reset.addEventListener("click", () => ctl.resetMappings(dev));
      kids.push(el("div", { className: "ctl-dev" },
        el("label", { className: "check ctl-name" }, on, el("b", {}, dev.profile.name), dev.present ? "" : el("span", { className: "dim" }, " (unplugged)")),
        el("label", {}, "Notes play ", mode),
        dev.profile.launchpad ? el("p", { className: "dim ctl-octave" }, `Piano pads from C${4 + s.octave} · ▲▼ octave · ◀▶ SELECT`) : null,
        !dev.profile.launchpad ? el("label", { className: "check" }, rel, " knobs send relative values (endless encoders)") : null,
        el("details", {}, el("summary", {}, "Layout and MIDI learn"),
          el("p", { className: "dim" }, dev.profile.launchpad
            ? "Rows 1–4: two octaves of piano. Row 5: each encoder one step left, MASTER down; row 6: one step right, MASTER up. Row 7: HOME SAVE ARP SEQ PLAY REC OCT− OCT+. Row 8: FX SCL ENV LFO EDIT GLO, then notes jack / keys. Buttons light like the FM-1's."
            : "Knobs K1–K4: the FM-1's KNOB1–4; K5 SELECT, K6 PRESETS, K7 ALGORITHM, K8 MASTER. Pads bank A: PLAY REC SEQ ARP / OCT− OCT+ HOME SAVE; bank B: FX SCL ENV LFO / EDIT GLO SELECT◀ SELECT▶. Keys, joystick and sustain go to the synth."),
          el("div", { className: "row" }, tsel, learnBtn), learnMsg,
          learned.length ? el("ul", { className: "ctl-learned" }, ...learned) : null,
          learned.length ? reset : null)));
    }
    body.replaceChildren(...kids);
  }
  ctl.onUpdate(render);
  render();
  return { render };
}
