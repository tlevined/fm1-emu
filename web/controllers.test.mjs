// The controller mappers: what an Akai MPK and a Launchpad X do to the FM-1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMapper, profileFor, launchpadColours, targets, LPX, BUTTONS } from "./controllers.js";

const B = Object.fromEntries(BUTTONS.map((n, i) => [n, i]));
const mpk = () => createMapper(profileFor("MPK mini 3"));
const lpx = (s) => createMapper(profileFor("Launchpad X LPX MIDI Out"), s);

test("devices are recognised by their port names", () => {
  assert.equal(profileFor("MPK mini 3").id, "mpk");
  assert.equal(profileFor("Akai MPK Mini Plus").id, "mpk");
  assert.equal(profileFor("LPX MIDI").id, "lpx");
  assert.equal(profileFor("Launchpad X LPX DAW Out").id, "lpx");
  assert.equal(profileFor("Launchpad Mini MK3"), null);
  assert.equal(profileFor("Arturia KeyStep"), null);
});

test("MPK: keys and the joystick go to the jack, knobs turn encoders, K8 is MASTER", () => {
  const m = mpk();
  assert.deepEqual(m.handle([0x90, 60, 100]), [{ type: "jack", bytes: [0x90, 60, 100] }]);
  assert.deepEqual(m.handle([0x80, 60, 0]), [{ type: "jack", bytes: [0x80, 60, 0] }]);
  assert.deepEqual(m.handle([0xe0, 0, 80]), [{ type: "jack", bytes: [0xe0, 0, 80] }]);
  assert.deepEqual(m.handle([0xb0, 1, 50]), [{ type: "jack", bytes: [0xb0, 1, 50] }]);     // mod
  assert.deepEqual(m.handle([0xb0, 70, 64]), []);                                         // K1's first value: where it is
  assert.deepEqual(m.handle([0xb0, 70, 70]), [{ type: "turn", enc: 3, clicks: 3 }]);      // KNOB1, two CC steps a click
  assert.deepEqual(m.handle([0xb0, 70, 69]), []);
  assert.deepEqual(m.handle([0xb0, 70, 67]), [{ type: "turn", enc: 3, clicks: -1 }]);
  assert.deepEqual(m.handle([0xb0, 74, 10]), []);
  assert.deepEqual(m.handle([0xb0, 74, 14]), [{ type: "turn", enc: 0, clicks: 2 }]);      // K5: SELECT
  assert.deepEqual(m.handle([0xb0, 77, 127]), [{ type: "pot", value: 1023 }]);
});

test("MPK: pads press buttons and let go of them, bank B nudges SELECT", () => {
  const m = mpk();
  assert.deepEqual(m.handle([0x99, 36, 90]), [{ type: "key", id: B.PLAY, down: true }]);
  assert.deepEqual(m.handle([0x89, 36, 0]), [{ type: "key", id: B.PLAY, down: false }]);
  assert.deepEqual(m.handle([0x99, 37, 90]), [{ type: "key", id: B.REC, down: true }]);
  assert.deepEqual(m.handle([0x99, 37, 0]), [{ type: "key", id: B.REC, down: false }]);    // note-on 0 is a release
  const r = m.handle([0x99, 51, 90]);
  assert.equal(r[0].type, "repeat");
  assert.deepEqual(r[0].action, { type: "turn", enc: 0, clicks: 1 });
  assert.deepEqual(m.handle([0x89, 51, 0]).map((a) => a.type), ["stop"]);
});

test("relative knobs: 1..63 right, 65..127 left", () => {
  const m = createMapper(profileFor("MPK mini 3"), { relative: true });
  assert.deepEqual(m.handle([0xb0, 71, 1]), [{ type: "turn", enc: 4, clicks: 1 }]);
  assert.deepEqual(m.handle([0xb0, 71, 127]), [{ type: "turn", enc: 4, clicks: -1 }]);
  assert.deepEqual(m.handle([0xb0, 71, 64]), []);
});

test("notes on the FM-1's own keys fold into F3..G5 and follow the octave", () => {
  const m = createMapper(profileFor("MPK mini 3"), { mode: "panel" });
  assert.deepEqual(m.handle([0x90, 60, 100]), [{ type: "key", id: 21, down: true }]);      // C4 = matrix id 21
  assert.deepEqual(m.handle([0x80, 60, 0]), [{ type: "key", id: 21, down: false }]);
  assert.deepEqual(m.handle([0x90, 36, 100]), [{ type: "key", id: 21, down: true }]);      // C2 folds to C4
  assert.deepEqual(m.handle([0x90, 53, 100]), [{ type: "key", id: 14, down: true }]);      // F3: the lowest
  assert.deepEqual(m.handle([0x90, 79, 100]), [{ type: "key", id: 40, down: true }]);      // G5: the highest
  assert.deepEqual(m.handle([0x90, 80, 100]), [{ type: "key", id: 29, down: true }]);      // G#5 -> G#4
});

test("a note released after the octave changed releases what it pressed", () => {
  const m = lpx();
  assert.deepEqual(m.handle([0x90, 11, 90]), [{ type: "jack", bytes: [0x90, 60, 90] }]);   // row 1 col 1: C4
  m.handle([0xb0, 91, 127]);                                                             // ▲ octave
  m.handle([0xb0, 91, 0]);
  assert.equal(m.state.octave, 1);
  assert.deepEqual(m.handle([0x90, 11, 0]), [{ type: "jack", bytes: [0x80, 60, 0] }]);
  assert.deepEqual(m.handle([0x90, 11, 90]), [{ type: "jack", bytes: [0x90, 72, 90] }]);
});

test("Launchpad X: the piano, the encoder rows, the buttons, the mode pad", () => {
  const m = lpx();
  assert.deepEqual(m.handle([0x90, 12, 70]), [{ type: "jack", bytes: [0x90, 62, 70] }]);   // D4
  assert.deepEqual(m.handle([0x90, 22, 70]), [{ type: "jack", bytes: [0x90, 61, 70] }]);   // C#4
  assert.deepEqual(m.handle([0x90, 24, 70]), []);                                          // the gap between E and F
  assert.deepEqual(m.handle([0x90, 31, 70]), [{ type: "jack", bytes: [0x90, 72, 70] }]);   // C5
  assert.deepEqual(m.handle([0x90, 51, 70])[0].action, { type: "turn", enc: 0, clicks: -1 });
  assert.deepEqual(m.handle([0x90, 67, 70])[0].action, { type: "turn", enc: 6, clicks: 1 });
  assert.deepEqual(m.handle([0x90, 68, 70])[0].action, { type: "potstep", delta: 64 });
  assert.deepEqual(m.handle([0x90, 75, 70]), [{ type: "key", id: B.PLAY, down: true }]);
  assert.deepEqual(m.handle([0x90, 75, 0]), [{ type: "key", id: B.PLAY, down: false }]);
  assert.deepEqual(m.handle([0x90, 81, 70]), [{ type: "key", id: B.FX, down: true }]);
  m.handle([0x90, 87, 70]);
  assert.equal(m.state.mode, "panel");
  assert.deepEqual(m.handle([0x90, 11, 70]), [{ type: "key", id: 21, down: true }]);
});

test("learned bindings win over the layout", () => {
  const m = createMapper(profileFor("MPK mini 3"), { overrides: { "cc:1:20": "enc:1", "note:1:48": "btn:9" } });
  m.handle([0xb0, 20, 0]);
  assert.deepEqual(m.handle([0xb0, 20, 6]), [{ type: "turn", enc: 1, clicks: 3 }]);
  assert.deepEqual(m.handle([0x90, 48, 1]), [{ type: "key", id: B.SAVE, down: true }]);
  assert.ok(targets().some((t) => t.id === "btn:9"));
});

test("Launchpad lights: keys, the FM-1's LEDs and pressed pads", () => {
  const leds = new Float32Array(41);
  leds[B.PLAY] = 1;
  leds[21] = 1;                                                           // C4's key LED (a sequencer step)
  const c = launchpadColours({ mode: "jack", octave: 0, overrides: {} }, leds, new Set([12]));
  assert.deepEqual(c.get(75), [0, 127, 20]);                              // PLAY lit green
  assert.deepEqual(c.get(76), [24, 24, 24]);                              // REC off: dim
  assert.deepEqual(c.get(11), [127, 70, 0]);                              // C4's LED on the piano pad
  assert.deepEqual(c.get(12), [127, 127, 127]);                           // held
  assert.deepEqual(c.get(24), [0, 0, 0]);                                 // no key there
  assert.deepEqual(c.get(87), [90, 0, 127]);                              // mode: jack
  assert.equal(c.size, 72 + 8);
  const sx = LPX.rgb([[11, [1, 2, 3]]]);
  assert.deepEqual(sx, [0xf0, 0, 0x20, 0x29, 2, 0x0c, 3, 3, 11, 1, 2, 3, 0xf7]);
});
