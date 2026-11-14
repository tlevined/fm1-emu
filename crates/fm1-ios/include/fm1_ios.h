// The FM-1 emulator's C interface for iOS (crates/fm1-ios/src/lib.rs). One Fm1 per plugin
// instance. fm1_render, fm1_midi and fm1_midi_out are realtime-safe and belong to the render
// thread; everything else is for other threads.
#ifndef FM1_IOS_H
#define FM1_IOS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct Fm1 Fm1;

typedef struct {
    bool booted;
    bool halted;
    float speed;        // emulated time per time spent emulating (below 1: the sound breaks up)
    uint64_t starved;   // frames the render block found missing, since the start
    uint32_t board;     // 0 FM-1, 1 SMK-37
    uint32_t mhz;
    uint32_t pot;       // MASTER 0..1023
    bool panel_keys;    // notes play the FM-1's own keys
    int32_t octave;     // the controller layout's octave
    uint64_t lcd_rev;   // changes when the screen does
} Fm1Status;

enum {
    FM1_SET_CLOCK = 0,      // MHz (the machine boots again, keeping its flash)
    FM1_SET_MASTER = 1,     // 0..1023
    FM1_SET_CHANNEL = 2,    // 0 as sent, 1..16
    FM1_SET_LEAD = 3,       // frames run ahead beyond a host block; next fm1_prepare
    FM1_SET_LAYOUT = 4,     // 0 none, 1 Launchpad X, 2 Akai MPK
    FM1_SET_PANEL_KEYS = 5, // 1: notes play the FM-1's own keys (F3..G5)
};

Fm1 *fm1_new(void);
void fm1_free(Fm1 *h);

// render thread
void fm1_prepare(Fm1 *h, double sample_rate, uint32_t max_frames);  // before rendering starts
uint32_t fm1_latency(const Fm1 *h);                                   // in host samples
void fm1_midi(Fm1 *h, const uint8_t *bytes, uint32_t len, uint32_t offset);
void fm1_render(Fm1 *h, float *left, float *right, uint32_t frames);
uint32_t fm1_midi_out(Fm1 *h, uint8_t *buf, uint32_t cap);           // next message's length, 0 none

// firmware, saves, settings
int32_t fm1_boot(Fm1 *h, const uint8_t *pkg, size_t len, const uint8_t *sectors, size_t sectors_len,
                 uint8_t *err, size_t err_cap);                        // 0 ok, -1 and err
size_t fm1_sectors_snapshot(Fm1 *h);                                   // size of the records
size_t fm1_sectors_copy(Fm1 *h, uint8_t *out, size_t cap);
void fm1_set(Fm1 *h, uint32_t what, int32_t value);
void fm1_key(Fm1 *h, uint32_t id, bool down);                          // buttons 0..13, keys 14..40
void fm1_enc(Fm1 *h, uint32_t enc, int32_t clicks);                    // 0 SELECT 1 PRESETS 2 ALGORITHM 3..6 KNOB1..4
void fm1_status(const Fm1 *h, Fm1Status *out);

// the front panel (1280 x 820)
uint32_t fm1_panel_width(void);
uint32_t fm1_panel_height(void);
void fm1_panel_set(Fm1 *h, uint32_t kind, uint32_t i, int32_t v);     // 0 key held, 1 encoder clicks, 3 knob glow
const uint8_t *fm1_panel_draw(Fm1 *h);                                 // RGBA, width*height*4
int32_t fm1_panel_hit(float x, float y);                               // -1, 0..6 encoder, 7 MASTER, 100+id

#ifdef __cplusplus
}
#endif
#endif
