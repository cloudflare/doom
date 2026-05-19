//
// wmcp_state.c
//
// Exposes a single Emscripten-exported function, wmcp_get_state_json(),
// that returns a pointer to a static JSON buffer describing the current
// game state. Consumed by the WebMCP `get_state` tool in the React app.
//
// The JSON shape is kept aligned with the DoomVisionState TypeScript
// type in src/lib/doomState.ts by hand -- there is no automatic
// generator. Whenever a field is added on one side, mirror it on the
// other, then rebuild the wasm (`make doom-build && make doom-copy`).
//
// Notes on design:
//   * Single static buffer, returned by pointer. JS-side code (ccall
//     with "string" return) copies the string out before the next call,
//     so reentrancy isn't a concern. The renderer doesn't call us;
//     only our JS tool does, single-threaded.
//   * We don't allocate. Pure stack + static buffer to keep the impl
//     trivial and crash-resistant inside the Wasm sandbox.
//   * Enemies are filtered to alive things that count for the kill
//     stats (MF_COUNTKILL & health > 0) within a forward 180-degree
//     cone and a max range. Optional line-of-sight check piggybacks
//     on the engine's own P_CheckSight().
//

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"
#include "p_mobj.h"
#include "p_local.h"
#include "tables.h"
#include "info.h"
#include "m_fixed.h"
#include "r_main.h"
#include "i_video.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

// Max enemies reported. Matches DoomVisionState.enemies_visible cap.
#define WMCP_MAX_ENEMIES 6

// Range in map units beyond which we don't report enemies even if the
// engine still has them in memory. 2048 map units is roughly the player's
// usable visual range in vanilla Doom corridors; tweak if needed.
#define WMCP_MAX_RANGE (2048 << FRACBITS)

// Half the field-of-view used to decide which enemies are "in front of"
// the player. 45 degrees on each side = 90 degree cone, matches the
// rendered viewport reasonably well at the default screen size.
#define WMCP_HALF_FOV (ANG45)

// Static return buffer. 8KB is plenty for a state with 6 enemies; the
// largest one I measured during prototyping was ~700 bytes.
static char wmcp_buf[8192];

// Cached pointers initialised lazily on first call. The pointer to
// players[] and to gamestate / automapactive / menuactive is stable
// across the lifetime of the process so we don't have to look them up
// every call -- but linker quirks aside, doing so is cheap, so we just
// reference the globals directly each time.

static const char *
wmcp_screen_kind_str(void)
{
    // Title screen / demo loops sit in GS_DEMOSCREEN. The menu can be
    // overlaid on top of any state, so check that first -- including
    // during demo playback, because pressing Esc during a demo opens
    // the menu and the agent should drive it normally from there.
    if (menuactive)
    {
        return "menu";
    }
    if (gamestate == GS_DEMOSCREEN)
    {
        return "title";
    }
    if (gamestate == GS_INTERMISSION)
    {
        return "intermission";
    }
    if (gamestate == GS_FINALE)
    {
        return "finale";
    }
    if (gamestate == GS_LEVEL)
    {
        // Attract-mode demo playback. Doom's idle loop cycles through
        // baked-in demos (DEMO1/DEMO2/DEMO3 lumps) which render exactly
        // like real gameplay -- same first-person view, HUD, enemies --
        // but human input is ignored except for Esc. If we returned
        // "playing" here the agent would happily fire and move and
        // think it's playing; flag this so the agent can press Esc to
        // open the menu and start a real game instead.
        if (demoplayback)
        {
            return "demo";
        }
        if (automapactive)
        {
            return "automap";
        }
        // Distinguish "dead" from "playing" by player state. The local
        // player is the one whose POV we are rendering.
        if (consoleplayer >= 0 && consoleplayer < MAXPLAYERS)
        {
            if (players[consoleplayer].playerstate == PST_DEAD)
            {
                return "dead";
            }
        }
        return "playing";
    }
    return "unknown";
}

static const char *
wmcp_weapon_str(weapontype_t w)
{
    switch (w)
    {
        case wp_fist:          return "fist";
        case wp_chainsaw:      return "chainsaw";
        case wp_pistol:        return "pistol";
        case wp_shotgun:       return "shotgun";
        case wp_supershotgun:  return "super_shotgun";
        case wp_chaingun:      return "chaingun";
        case wp_missile:       return "rocket_launcher";
        case wp_plasma:        return "plasma_rifle";
        case wp_bfg:           return "bfg";
        default:               return "unknown";
    }
}

// Maps the weapon a player is currently holding to the ammo type that
// weapon consumes. Mirrors weaponinfo[] from d_items.c but written out
// here so we don't need to link a new translation unit just for one
// lookup.
static const char *
wmcp_ammo_type_for_weapon(weapontype_t w)
{
    switch (w)
    {
        case wp_fist:
        case wp_chainsaw:
            return "none";
        case wp_pistol:
        case wp_chaingun:
            return "bullets";
        case wp_shotgun:
        case wp_supershotgun:
            return "shells";
        case wp_missile:
            return "rockets";
        case wp_plasma:
        case wp_bfg:
            return "cells";
        default:
            return "unknown";
    }
}

// Approximate the face state shown on the HUD. The real face logic in
// st_stuff.c is a small state machine driven by damage, pickups, attack
// hold and a timer. We don't try to replicate it tic-by-tic; we just
// classify the *meaning* a UI would convey.
static const char *
wmcp_face_state_str(const player_t *p)
{
    if (p->playerstate == PST_DEAD)         return "dead";
    if (p->cheats & CF_GODMODE)             return "god";
    if (p->damagecount > 0)                 return "hurt";
    // bonuscount flashes on pickups (including weapon pickups), which is
    // a reasonable analogue for "evil_grin".
    if (p->bonuscount > 0)                  return "evil_grin";
    // refire is incremented when the player holds fire across multiple
    // tics. The vanilla face's "rampage" trigger is similar.
    if (p->attackdown && p->refire >= 2)    return "rampage";
    return "ok";
}

// Append a key name to the JSON keys array. Returns the new write
// position in dst, or NULL on overflow.
static char *
wmcp_append_key(char *dst, char *end, int *first, const char *name)
{
    int written = snprintf(dst, (size_t)(end - dst), "%s\"%s\"",
                           *first ? "" : ",", name);
    if (written < 0 || written >= (end - dst))
    {
        return NULL;
    }
    *first = 0;
    return dst + written;
}

static int
wmcp_classify_mobj(const mobj_t *mo, const char **out_name)
{
    // Return 1 and set *out_name if mo is something the player would
    // consider an enemy that's currently alive. Otherwise return 0.
    if ((mo->flags & MF_COUNTKILL) == 0)
    {
        return 0;
    }
    if (mo->health <= 0)
    {
        return 0;
    }
    if (mo->flags & MF_CORPSE)
    {
        return 0;
    }

    switch (mo->type)
    {
        case MT_POSSESSED: *out_name = "zombieman";        return 1;
        case MT_SHOTGUY:   *out_name = "shotgun_guy";       return 1;
        case MT_TROOP:     *out_name = "imp";               return 1;
        case MT_SERGEANT:  *out_name = "demon";             return 1;
        case MT_SHADOWS:   *out_name = "spectre";           return 1;
        case MT_SKULL:     *out_name = "lost_soul";         return 1;
        case MT_HEAD:      *out_name = "cacodemon";         return 1;
        case MT_BRUISER:   *out_name = "baron_of_hell";     return 1;
        case MT_KNIGHT:    *out_name = "knight_of_hell";    return 1;
        case MT_UNDEAD:    *out_name = "revenant";          return 1;
        case MT_FATSO:     *out_name = "mancubus";          return 1;
        case MT_BABY:      *out_name = "arachnotron";       return 1;
        case MT_PAIN:      *out_name = "pain_elemental";    return 1;
        case MT_VILE:      *out_name = "archvile";          return 1;
        case MT_CYBORG:    *out_name = "cyberdemon";        return 1;
        case MT_SPIDER:    *out_name = "spider_mastermind"; return 1;
        default:           *out_name = "other";             return 1;
    }
}

// Convert a signed relative angle to one of the five bearing bins used
// by the schema. Input is a doom BAM in the range [-ANG180, ANG180).
static const char *
wmcp_bearing_bin(int32_t rel_angle)
{
    // Bin boundaries:
    //   |rel| <  ANG45/2   -> center      (~ +/-11 degrees)
    //   |rel| <  ANG45 + ANG45/2 -> left/right   (~11-56 degrees)
    //   else                     -> far_left/far_right
    int32_t mag = rel_angle < 0 ? -rel_angle : rel_angle;
    if (mag < (ANG45 / 2))
    {
        return "center";
    }
    if (rel_angle < 0)
    {
        if (mag < ANG45 + (ANG45 / 2)) return "right";
        return "far_right";
    }
    else
    {
        if (mag < ANG45 + (ANG45 / 2)) return "left";
        return "far_left";
    }
}

static const char *
wmcp_distance_bin(fixed_t dist)
{
    // Thresholds tuned to feel right against a 320x200 viewport. "near"
    // is roughly the range at which an imp fills a sizeable chunk of
    // the screen; "far" is at the edge of useful aim.
    if (dist < (512 << FRACBITS))  return "near";
    if (dist < (1024 << FRACBITS)) return "mid";
    return "far";
}

// Returns the number of enemies appended. Writes into *cursor and bumps
// *cursor on success. Sets *truncated to 1 if we hit the array cap.
static int
wmcp_append_enemies(char **cursor, char *end, const player_t *p, int *truncated)
{
    int count = 0;
    int first = 1;
    *truncated = 0;

    if (p->mo == NULL)
    {
        return 0;
    }

    const mobj_t *self = p->mo;
    fixed_t self_x = self->x;
    fixed_t self_y = self->y;
    angle_t self_angle = self->angle;

    // Walk the thinker list. mobj thinkers have function == P_MobjThinker
    // but since we don't link P_MobjThinker's address here cheaply, we
    // use the global thinkercap convention: any thinker that's actually
    // a mobj has a non-NULL P_MobjThinker function pointer. To avoid the
    // typeof issue we instead just treat every thinker as a possible
    // mobj and validate via the MF flags. This is the same trick that
    // p_enemy.c uses for P_LookForPlayers fallbacks.
    for (thinker_t *th = thinkercap.next;
         th != NULL && th != &thinkercap;
         th = th->next)
    {
        if (th->function.acp1 != (actionf_p1)P_MobjThinker)
        {
            continue;
        }

        const mobj_t *mo = (const mobj_t *)th;
        const char *name = NULL;
        if (!wmcp_classify_mobj(mo, &name))
        {
            continue;
        }

        // Range check.
        fixed_t dx = mo->x - self_x;
        fixed_t dy = mo->y - self_y;
        // Use the engine's approxdistance to avoid a sqrt. Equivalent
        // to P_AproxDistance from p_maputl.c.
        fixed_t adx = dx < 0 ? -dx : dx;
        fixed_t ady = dy < 0 ? -dy : dy;
        fixed_t approx_dist = adx + ady - ((adx < ady ? adx : ady) >> 1);
        if (approx_dist > WMCP_MAX_RANGE)
        {
            continue;
        }

        // Bearing check.
        angle_t to_target = R_PointToAngle2(self_x, self_y, mo->x, mo->y);
        // Signed relative angle: positive = to the left of facing.
        int32_t rel = (int32_t)(to_target - self_angle);
        // Drop anything outside the forward 180-degree arc -- saves us
        // listing things directly behind the player.
        int32_t abs_rel = rel < 0 ? -rel : rel;
        if ((angle_t)abs_rel > ANG90 + WMCP_HALF_FOV)
        {
            continue;
        }

        // Optional sight check. Cast away const for the engine API.
        if (!P_CheckSight((mobj_t *)self, (mobj_t *)mo))
        {
            continue;
        }

        if (count >= WMCP_MAX_ENEMIES)
        {
            *truncated = 1;
            break;
        }

        const char *bearing = wmcp_bearing_bin(rel);
        const char *distance = wmcp_distance_bin(approx_dist);

        int written = snprintf(*cursor, (size_t)(end - *cursor),
            "%s{\"type\":\"%s\",\"bearing\":\"%s\",\"distance\":\"%s\"}",
            first ? "" : ",", name, bearing, distance);
        if (written < 0 || written >= (end - *cursor))
        {
            // Buffer full. Stop here; caller will close the array.
            *truncated = 1;
            break;
        }
        *cursor += written;
        first = 0;
        count++;
    }

    return count;
}

// Returns true if the local player object is in a state where it makes
// sense to read HUD values. When false we emit -1 / "unknown" defaults.
static int
wmcp_hud_visible(void)
{
    if (gamestate != GS_LEVEL) return 0;
    if (consoleplayer < 0 || consoleplayer >= MAXPLAYERS) return 0;
    return 1;
}

EMSCRIPTEN_KEEPALIVE
const char *
wmcp_get_state_json(void)
{
    char *cur = wmcp_buf;
    char *end = wmcp_buf + sizeof(wmcp_buf);

    const char *screen = wmcp_screen_kind_str();
    int hud_ok = wmcp_hud_visible();

    int health = -1, armor = -1, ammo_count = -1;
    const char *ammo_type = "unknown";
    const char *weapon = "unknown";
    const char *face = "unknown";
    int in_combat = 0;
    int low_health = 0;
    const player_t *p = NULL;

    if (hud_ok)
    {
        p = &players[consoleplayer];
        weapon = wmcp_weapon_str(p->readyweapon);
        ammo_type = wmcp_ammo_type_for_weapon(p->readyweapon);
        // Use p->health between levels, mo->health during levels; the
        // schema represents the visible HUD so we prefer mo->health when
        // the mobj exists.
        health = (p->mo != NULL) ? p->mo->health : p->health;
        armor = p->armorpoints;
        face = wmcp_face_state_str(p);
        low_health = (health > 0 && health <= 30) ? 1 : 0;

        // Ammo count for the ready weapon. Fists / chainsaw show 0 on the
        // vanilla HUD; report -1 for those so the caller can distinguish
        // "no ammo type" from "zero rounds left of a real ammo type".
        switch (p->readyweapon)
        {
            case wp_fist:
            case wp_chainsaw:
                ammo_count = -1;
                break;
            case wp_pistol:
            case wp_chaingun:
                ammo_count = p->ammo[am_clip];
                break;
            case wp_shotgun:
            case wp_supershotgun:
                ammo_count = p->ammo[am_shell];
                break;
            case wp_missile:
                ammo_count = p->ammo[am_misl];
                break;
            case wp_plasma:
            case wp_bfg:
                ammo_count = p->ammo[am_cell];
                break;
            default:
                ammo_count = -1;
                break;
        }
    }

    // Begin object.
    int n = snprintf(cur, (size_t)(end - cur),
        "{\"screen\":\"%s\",\"hud\":{"
        "\"health\":%d,\"armor\":%d,\"ammo\":%d,"
        "\"ammo_type\":\"%s\",\"weapon\":\"%s\",\"face_state\":\"%s\","
        "\"keys\":[",
        screen, health, armor, ammo_count, ammo_type, weapon, face);
    if (n < 0 || n >= (end - cur)) goto overflow;
    cur += n;

    // Keys array.
    if (hud_ok && p != NULL)
    {
        int first = 1;
        if (p->cards[it_bluecard])   { cur = wmcp_append_key(cur, end, &first, "blue_keycard");   if (!cur) goto overflow; }
        if (p->cards[it_yellowcard]) { cur = wmcp_append_key(cur, end, &first, "yellow_keycard"); if (!cur) goto overflow; }
        if (p->cards[it_redcard])    { cur = wmcp_append_key(cur, end, &first, "red_keycard");    if (!cur) goto overflow; }
        if (p->cards[it_blueskull])  { cur = wmcp_append_key(cur, end, &first, "blue_skull");     if (!cur) goto overflow; }
        if (p->cards[it_yellowskull]){ cur = wmcp_append_key(cur, end, &first, "yellow_skull");   if (!cur) goto overflow; }
        if (p->cards[it_redskull])   { cur = wmcp_append_key(cur, end, &first, "red_skull");      if (!cur) goto overflow; }
    }

    // Close keys/hud, open enemies.
    n = snprintf(cur, (size_t)(end - cur), "]},\"enemies_visible\":[");
    if (n < 0 || n >= (end - cur)) goto overflow;
    cur += n;

    int truncated = 0;
    int enemy_count = 0;
    if (hud_ok && strcmp(screen, "playing") == 0 && p != NULL)
    {
        enemy_count = wmcp_append_enemies(&cur, end, p, &truncated);
    }
    (void)enemy_count;

    in_combat = (enemy_count > 0 && p != NULL && p->attackdown);

    // Build a caption that's useful for TTS / logs even when the
    // structured fields are partly empty. <80 chars.
    char caption[96];
    if (strcmp(screen, "playing") == 0)
    {
        snprintf(caption, sizeof(caption),
                 "%s hp=%d armor=%d ammo=%d wpn=%s enemies=%d",
                 screen, health, armor, ammo_count, weapon, enemy_count);
    }
    else
    {
        snprintf(caption, sizeof(caption), "%s", screen);
    }
    // Hard truncate to 80 chars to match the schema cap.
    caption[80] = '\0';

    n = snprintf(cur, (size_t)(end - cur),
        "],\"in_combat\":%s,\"low_health\":%s,\"caption\":\"%s\"}",
        in_combat ? "true" : "false",
        low_health ? "true" : "false",
        caption);
    if (n < 0 || n >= (end - cur)) goto overflow;
    cur += n;

    return wmcp_buf;

overflow:
    // Fall back to a minimal valid JSON object so the JS side never sees
    // garbage. This should be unreachable with the current sizing.
    snprintf(wmcp_buf, sizeof(wmcp_buf),
        "{\"screen\":\"unknown\",\"hud\":{\"health\":-1,\"armor\":-1,"
        "\"ammo\":-1,\"ammo_type\":\"unknown\",\"weapon\":\"unknown\","
        "\"face_state\":\"unknown\",\"keys\":[]},"
        "\"enemies_visible\":[],\"in_combat\":false,\"low_health\":false,"
        "\"caption\":\"buffer overflow\"}");
    return wmcp_buf;
}

// ---------------------------------------------------------------------------
// Framebuffer snapshot
//
// Returns a pointer to a static 320x200 RGBA buffer reflecting the most
// recent frame chocolate-doom drew into I_VideoBuffer, with the current
// gamma-corrected palette applied. Alpha is always 0xFF.
//
// Returning a static buffer matches the wmcp_get_state_json convention:
// the JS side (Module.ccall) copies the bytes out before the next call,
// and we never call this function ourselves from another thread (the
// Doom main loop is single-threaded under Emscripten).
//
// Guards:
//   * I_VideoBuffer is NULL until I_InitGraphics runs. If a caller asks
//     for a frame during boot we return an all-black image instead of
//     dereferencing NULL.
//
// Layout note: the returned buffer is ordered exactly as ImageData wants
// on the JS side: row-major, no row padding, R G B A bytes per pixel.
// ---------------------------------------------------------------------------

#define WMCP_FB_WIDTH SCREENWIDTH
#define WMCP_FB_HEIGHT SCREENHEIGHT
#define WMCP_FB_BYTES (WMCP_FB_WIDTH * WMCP_FB_HEIGHT * 4)

static unsigned char wmcp_framebuffer_rgba[WMCP_FB_BYTES];

EMSCRIPTEN_KEEPALIVE
const unsigned char *
wmcp_get_framebuffer_rgba(void)
{
    unsigned char pal[256][3];
    I_CopyPaletteRGB(pal);

    if (I_VideoBuffer == NULL)
    {
        // Pre-I_InitGraphics: nothing has been drawn yet. Return an
        // opaque black frame so the JS side still gets a well-formed
        // image. memset is fine because R=G=B=0 and alpha needs to be
        // 0xFF, which we set in a second pass.
        memset(wmcp_framebuffer_rgba, 0, WMCP_FB_BYTES);
        for (int i = 3; i < WMCP_FB_BYTES; i += 4)
        {
            wmcp_framebuffer_rgba[i] = 0xFF;
        }
        return wmcp_framebuffer_rgba;
    }

    // Tight inner loop: one indexed-pixel -> RGBA pack per iteration.
    // 64,000 iterations, ~250 KB of writes. Inlined manually rather than
    // using memcpy of 3 + a store of 1, because the indexed source is one
    // byte and the RGBA destination is four bytes -- a memcpy here would
    // be a pessimisation.
    const pixel_t *src = I_VideoBuffer;
    unsigned char *dst = wmcp_framebuffer_rgba;
    const int total = WMCP_FB_WIDTH * WMCP_FB_HEIGHT;
    for (int i = 0; i < total; i++)
    {
        const unsigned char *rgb = pal[src[i]];
        dst[0] = rgb[0];
        dst[1] = rgb[1];
        dst[2] = rgb[2];
        dst[3] = 0xFF;
        dst += 4;
    }

    return wmcp_framebuffer_rgba;
}

// ---------------------------------------------------------------------------
// Menu introspection
//
// Doom doesn't store menu item labels as strings -- each menuitem_t's
// `name` field is a 9-char graphic lump name like "M_NGAME" that gets
// blit at render time from a patch in the WAD. There's no in-engine
// string-form to scrape. We hand-translate the lump names below.
//
// The load/save menus are an exception: their menuitem `name` is "" and
// the visible text comes from savegamestrings[i] at render time, so for
// those we read savegamestrings directly.
//
// We reach into m_menu.c via externs (currentMenu, itemOn, LoadDef,
// SaveDef, savegamestrings). All four symbols are non-static there so
// no engine patch is needed.
// ---------------------------------------------------------------------------

// menuitem_t / menu_t are defined static-locally inside m_menu.c. We
// can't share that definition without an engine refactor, so duplicate
// the layout here. If chocolate-doom ever changes these structs we'll
// notice immediately (the JSON output will be garbage), so keep this in
// sync with doom/src/doom/m_menu.c.
typedef struct {
    short status;
    char name[10];
    void (*routine)(int choice);
    char alphaKey;
} wmcp_menuitem_t;

typedef struct wmcp_menu_s {
    short numitems;
    struct wmcp_menu_s *prevMenu;
    wmcp_menuitem_t *menuitems;
    void (*routine)(void);
    short x;
    short y;
    short lastOn;
} wmcp_menu_t;

extern wmcp_menu_t *currentMenu;
extern short itemOn;
extern wmcp_menu_t LoadDef;
extern wmcp_menu_t SaveDef;
// SAVESTRINGSIZE is 24 per p_saveg.h. The array is dimensioned to 10 in
// m_menu.c even though only the first 6 slots are visible.
extern char savegamestrings[10][24];

// Hand-rolled M_XXXXX -> human label mapping. Covers every menuitem in
// vanilla chocolate-doom. Items not in the table fall through to the
// raw lump name so the agent at least sees *something*.
static const struct {
    const char *lump;
    const char *label;
} WMCP_MENU_LABELS[] = {
    // Main menu
    { "M_NGAME",  "New Game" },
    { "M_OPTION", "Options" },
    { "M_LOADG",  "Load Game" },
    { "M_SAVEG",  "Save Game" },
    { "M_RDTHIS", "Read This!" },
    { "M_QUITG",  "Quit Game" },
    // Episode picker
    { "M_EPI1",   "Knee-Deep in the Dead" },
    { "M_EPI2",   "The Shores of Hell" },
    { "M_EPI3",   "Inferno" },
    { "M_EPI4",   "Thy Flesh Consumed" },
    // Skill picker
    { "M_JKILL",  "I'm too young to die" },
    { "M_ROUGH",  "Hey, not too rough" },
    { "M_HURT",   "Hurt me plenty" },
    { "M_ULTRA",  "Ultra-Violence" },
    { "M_NMARE",  "Nightmare!" },
    // Options menu
    { "M_ENDGAM", "End Game" },
    { "M_MESSG",  "Messages" },
    { "M_DETAIL", "Graphic Detail" },
    { "M_SCRNSZ", "Screen Size" },
    { "M_MSENS",  "Mouse Sensitivity" },
    { "M_SVOL",   "Sound Volume" },
    // Sound submenu
    { "M_SFXVOL", "Sfx Volume" },
    { "M_MUSVOL", "Music Volume" },
};
static const int WMCP_MENU_LABEL_COUNT =
    sizeof(WMCP_MENU_LABELS) / sizeof(WMCP_MENU_LABELS[0]);

static const char *
wmcp_lookup_menu_label(const char *lump)
{
    if (lump == NULL || lump[0] == '\0') return NULL;
    for (int i = 0; i < WMCP_MENU_LABEL_COUNT; i++)
    {
        if (strcmp(WMCP_MENU_LABELS[i].lump, lump) == 0)
        {
            return WMCP_MENU_LABELS[i].label;
        }
    }
    return NULL;
}

// Buffer for the menu JSON. Generous: with 16 items each ~40 bytes the
// upper bound is well under 1 KB; padded heavily for safety.
static char wmcp_menu_buf[4096];

// Emit a JSON string with rudimentary escaping. Sufficient for menu
// labels and save-game strings (printable ASCII / hyphens / apostrophes).
// Returns updated cursor or NULL on overflow.
static char *
wmcp_emit_string(char *cur, char *end, const char *s)
{
    if (cur >= end) return NULL;
    *cur++ = '"';
    for (const char *p = s; *p && cur < end - 1; p++)
    {
        unsigned char c = (unsigned char)*p;
        if (c == '"' || c == '\\')
        {
            if (cur + 2 > end) return NULL;
            *cur++ = '\\';
            *cur++ = (char)c;
        }
        else if (c < 0x20)
        {
            // Skip control characters silently; menu strings shouldn't
            // contain them but the savegame slot may have stale bytes.
        }
        else
        {
            *cur++ = (char)c;
        }
    }
    if (cur >= end) return NULL;
    *cur++ = '"';
    return cur;
}

EMSCRIPTEN_KEEPALIVE
const char *
wmcp_get_menu_json(void)
{
    char *cur = wmcp_menu_buf;
    char *end = wmcp_menu_buf + sizeof(wmcp_menu_buf);

    // No menu visible? Return a JSON null. The JS wrapper translates
    // that to a "no menu open" result.
    if (!menuactive || currentMenu == NULL)
    {
        snprintf(wmcp_menu_buf, sizeof(wmcp_menu_buf), "null");
        return wmcp_menu_buf;
    }

    const wmcp_menu_t *m = currentMenu;
    const int is_load = (m == &LoadDef);
    const int is_save = (m == &SaveDef);

    int n = snprintf(cur, (size_t)(end - cur),
        "{\"cursor_index\":%d,\"is_save_menu\":%s,\"is_load_menu\":%s,\"items\":[",
        (int)itemOn,
        is_save ? "true" : "false",
        is_load ? "true" : "false");
    if (n < 0 || n >= (end - cur)) goto overflow;
    cur += n;

    const int num = m->numitems;
    for (int i = 0; i < num; i++)
    {
        const wmcp_menuitem_t *it = &m->menuitems[i];

        // Resolve label.
        const char *label = NULL;
        char savetmp[32];
        if ((is_load || is_save) && i >= 0 && i < 10)
        {
            // savegamestrings is null-terminated up to SAVESTRINGSIZE-1.
            // Copy defensively into a local buffer.
            size_t lim = sizeof(savetmp) - 1;
            size_t k = 0;
            for (; k < lim && k < 24 && savegamestrings[i][k] != '\0'; k++)
            {
                savetmp[k] = savegamestrings[i][k];
            }
            savetmp[k] = '\0';
            label = (k > 0) ? savetmp : "(empty slot)";
        }
        else
        {
            // m->menuitems[i].name is a NUL-padded char[10]. Copy into a
            // sized buffer to ensure NUL-termination before strcmp.
            char lump[16];
            size_t k = 0;
            for (; k < 9 && it->name[k] != '\0'; k++)
            {
                lump[k] = it->name[k];
            }
            lump[k] = '\0';
            label = wmcp_lookup_menu_label(lump);
            if (label == NULL)
            {
                // Fall back to the raw lump name so the agent at least
                // has *some* identifier to reason about.
                label = (lump[0] != '\0') ? lump : "(no label)";
            }
        }

        const int enabled = (it->status > 0) ? 1 : 0;
        const int is_cursor = (i == itemOn) ? 1 : 0;

        n = snprintf(cur, (size_t)(end - cur),
            "%s{\"index\":%d,\"label\":",
            i == 0 ? "" : ",",
            i);
        if (n < 0 || n >= (end - cur)) goto overflow;
        cur += n;

        cur = wmcp_emit_string(cur, end, label);
        if (cur == NULL) goto overflow;

        // alphaKey is a single char or 0; emit empty string for 0.
        char hot[2] = { 0, 0 };
        if (it->alphaKey != '\0' &&
            (unsigned char)it->alphaKey >= 0x20 &&
            (unsigned char)it->alphaKey < 0x7F)
        {
            hot[0] = it->alphaKey;
        }

        n = snprintf(cur, (size_t)(end - cur),
            ",\"enabled\":%s,\"cursor\":%s,\"hot_key\":\"%s\"}",
            enabled ? "true" : "false",
            is_cursor ? "true" : "false",
            hot);
        if (n < 0 || n >= (end - cur)) goto overflow;
        cur += n;
    }

    if (cur + 2 > end) goto overflow;
    *cur++ = ']';
    *cur++ = '}';
    if (cur >= end) goto overflow;
    *cur = '\0';
    return wmcp_menu_buf;

overflow:
    snprintf(wmcp_menu_buf, sizeof(wmcp_menu_buf),
        "{\"cursor_index\":-1,\"is_save_menu\":false,\"is_load_menu\":false,"
        "\"items\":[],\"error\":\"menu buffer overflow\"}");
    return wmcp_menu_buf;
}
