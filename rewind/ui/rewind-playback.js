/**
 * Civilization VII Rewind — Playback UI
 *
 * On-demand map, opened from the endgame Victories "Rewind" tab or the in-game minimap checkbox.
 * A scrubber (Play/Pause, draggable div timeline with per-age sections, step buttons, speed
 * cycle) + a hex map with toggleable layers (territory, borders, units, wonders, resources,
 * fog, leader ribbon). Territory: rural owned tiles fill PRIMARY, urban/center tiles solid
 * SECONDARY, the outer border SECONDARY, the city-center dot/star PRIMARY. Opens at the most
 * recent frame (applyOpenPosition); reopening within the same game turn keeps the position.
 *
 * Rendering (Coherent/Gameface): the map is a small fixed set of stacked <canvas> layers (bg
 * terrain, per-turn state, per-age resources, per-game natural wonders) plus DOM marker layers
 * (man-made wonders, city dots, units) — see the layer overview above ensureMapRoot. The chrome
 * (panel, scrubber, tooltips, ribbon) is position:FIXED DOM styled via individual style setters.
 * Native <input type=range> is dead in Gameface — the scrubber is a div track + mouse drag.
 * Markers are DOM (not canvas) because every canvas fill/stroke leaks one of Coherent's 49152
 * static-resource pool items and never frees it — see the KNOWN ISSUE note at the canvas-draw section.
 *
 * Storage: reads the GAME config store (Configuration.getGame) written by rewind-recorder.js — a global
 * frame index (gi) across all ages; keep the schema in sync with the recorder.
 */

import ViewManager from '/core/ui/views/view-manager.js';
import { Icon } from '/core/ui/utilities/utilities-image.js';

const TAG = '[REWIND]';
const STORE_NS = 'CivRewind__';   // key prefix in the GAME config store (Configuration.getGame/editGame)
const DATA_VERSION = 14;  // v14: compact encoding — territory/units/visibility bit-packed; wonders delta-coded + type-indexed; terrain captured once
// Decoders for the recorder's bit-packed layers — must mirror rewind-recorder.js's pack* math exactly.
function unpackTerr(v) { const i = Math.floor(v / 1024), r = v % 1024; return [i, Math.floor(r / 8) - 1, r % 8]; }   // [plot, owner(-1 unowned), cls]
function unpackUnit(v) { const plot = Math.floor(v / 65536), r = v % 65536; return [plot, Math.floor(r / 1024), r % 1024]; }   // [plot, owner, typeIdx]
function unpackVisI(v) { return Math.floor(v / 4); }
function unpackVisS(v) { return v % 4; }
const OBJ_META = 'meta';
const OBJ_TURNS = 'turns';
const OBJ_BASE = 'base';
const OBJ_UNITS = 'units';
const OBJ_WONDERS = 'wonders';
const OBJ_SUZE = 'suze';
const OBJ_PLAYERS = 'players';
const KEY_INDEX = 'index';
const KEY_TERRAIN = 'terrain';
const KEY_NATURAL = 'natural';

// Target milliseconds PER TURN for each speed. We draw EVERY turn in order (never skip in playback); the
// scheduler self-corrects for how long each turn's draw actually took, so a heavy turn just makes playback
// run slower than the target rather than dropping a turn. Most turns are cheap now (delta-gated state skip +
// incremental units), so we comfortably hit the target — a genuine 4x that draws all 4x the turns.
const PLAY_SPEEDS = [400, 200, 100, 800];               // ms per turn for 1x / 2x / 4x / 0.5x
const PLAY_SPEED_LABELS = ['1x', '2x', '4x', '0.5x'];
const MIN_TURN_MS = 45;                                 // floor between turn draws: a heavy turn slows playback instead of stacking draws back-to-back
let speedIdx = 0;
const LAYOUT_PAD = 8;                                    // inner padding within the available area
const MAX_FILL = 0.97;                                   // map occupies at most this fraction of the zone (keeps a small margin)
const SCRUB_RESERVE = 110;                               // px below the map for the scrub bar (used when there's no Exit button to bound it)
const MIN_CW = 5, MAX_CW = 80;
// --- chrome scale unification ------------------------------------------------------------------------
// Native fxs-button/fxs-checkbox size themselves in rem, which follows Civ's Interface Scale, while our
// slider/turn-label chrome uses ps() (viewport resolution). At a non-default Interface Scale the two desync
// — the buttons balloon and the control row overflows. UNIFY_PS_CHROME drives the buttons + checkbox-label
// text from ps() too, so they track the slider/turn text. Flip to false to restore the prior rem sizing.
const UNIFY_PS_CHROME = true;
// Control-button metrics in DESIGN px (each ps()-scaled at runtime), sized so the buttons sit at the same
// scale as the checkboxes/labels instead of dwarfing them. The decorative frame is a border-image; keeping
// its width proportional to the box (2*FRAME_V == BTN_H, and BTN_MINW > 2*FRAME_H) means it never triggers
// the border-image reduction, so every button renders an identical, full frame → uniform heights.
const BTN_H = 20;                    // button box height (≈ the checkbox 18 / label-font 13 scale)
const BTN_FONT = 10;                 // caption font (smaller than the checkbox labels so "Play"/"Pause" isn't cramped in the box)
const BTN_MINW = 52;                 // min width (> 2*FRAME_H so the side frame isn't reduced)
const BTN_FRAME_V = 10, BTN_FRAME_H = 21;   // frame border-image-width (top/bottom, left/right)
const BTN_OUT_V = 4, BTN_OUT_H = 3;         // frame border-image-outset
// Single UI scale from viewport height (1080p reference, clamped), so the fixed-size chrome (fonts,
// paddings, track height, scrub reserve, etc.) scales with resolution like the map does.
function uiScale() { const ih = (typeof window !== 'undefined' && window.innerHeight) || 1080; return Math.max(0.75, Math.min(2.5, ih / 1080)); }
function ps(n) { return Math.round(n * uiScale()); }   // scale a px value
// IDs our endgame-tab override stamps onto the native Victories elements, so we can measure the real
// content pane + Exit button at runtime (adapts to any resolution / aspect ratio).
const PANE_EL_ID = 'rewind-panel-container';
const EXIT_EL_ID = 'rewind-endgame-buttons';
const HEX_CLIP = 'polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)';   // pointy-top

// terrain class -> rgb, tuned toward the in-game minimap palette
const TERRAIN_RGB = [
  [25, 58, 110],    // 0 deep ocean   — dark navy
  [44, 108, 164],   // 1 coastal sea  — deeper medium blue
  [114, 104, 94],   // 2 mountain
  [224, 206, 150],  // 3 desert
  [196, 186, 118],  // 4 plains
  [104, 150, 80],   // 5 grassland
  [60, 120, 55],    // 6 tropical
  [206, 212, 205],  // 7 tundra
  [130, 128, 116],  // 8 other land
  [58, 130, 190],   // 9 lake            — medium blue (was coastal)
  [96, 172, 198],   // 10 navigable river — lighter cyan-blue (was lake)
];
// city-state (isMinor) type -> dot color; villages/goodie-huts (isIndependent) -> one purple dot
const CITYSTATE_TYPE_COLOR = {
  MILITARISTIC: '#e74c3c', SCIENTIFIC: '#3498db', ECONOMIC: '#f1c40f',
  CULTURAL: '#c0399b', DIPLOMATIC: '#1abc9c', EXPANSIONIST: '#2ecc71',
};
const GOODIE_DOT = '#8a2be2';   // goodie hut / independent village

const DEBUG = false;   // set true to re-enable the mod's [REWIND] informational logging
function log(msg) { if (DEBUG) console.warn(`${TAG} ${msg}`); }
function err(msg) { console.error(`${TAG} ${msg}`); }

// --- store (read-only) -------------------------------------------------------
// Reads from the GAME config store (Configuration.getGame().getValue), which — unlike the GameTutorial-
// backed Catalog we used before — SURVIVES age transitions. Same getObject(id).read(key) shape as before,
// so the call sites below are unchanged; keys are namespaced as STORE_NS + id + '_' + key.
function cfgGet(k) { try { const g = (typeof Configuration !== 'undefined' && Configuration.getGame) ? Configuration.getGame() : null; return (g && g.getValue) ? g.getValue(k) : null; } catch (e) { return null; } }
const gameStore = { getObject(id) { const pfx = STORE_NS + id + '_'; return { read: (key) => cfgGet(pfx + key) }; } };
function getCatalog() { return gameStore; }
function readManifest() {
  try { const raw = getCatalog().getObject(OBJ_META).read(KEY_INDEX); if (raw) { const m = JSON.parse(raw); if (m && m.v === DATA_VERSION) return m; } } catch (e) { err(`manifest read: ${e}`); }
  return null;
}
function readTurn(t) {
  try { const raw = getCatalog().getObject(OBJ_TURNS).read('t' + t); if (raw) return JSON.parse(raw); } catch (e) { err(`turn ${t} read: ${e}`); }
  return null;
}
function readTerrain() {
  try { const raw = getCatalog().getObject(OBJ_BASE).read(KEY_TERRAIN); if (raw) return JSON.parse(raw); } catch (e) { err(`terrain read: ${e}`); }
  return null;
}
const unitsCache = new Map();   // gi -> [[plotIndex, ownerId, typeIdx], ...] (decoded from the packed flat array)
function readUnitsTurn(t) {
  if (unitsCache.has(t)) return unitsCache.get(t);
  let arr = [];
  try { const raw = getCatalog().getObject(OBJ_UNITS).read('u' + t); if (raw) { const r = JSON.parse(raw); if (r && Array.isArray(r.u)) arr = r.u.map(unpackUnit); } } catch (e) { err(`units ${t} read: ${e}`); }
  unitsCache.set(t, arr);
  return arr;
}
// Per-age resource layer: OBJ_BASE key 'res_<ageId>' → Map(plotIndex -> classCode). Class colors match the
// in-game resource-class icons (0 bonus green, 1 city blue, 2 empire amber, 3 treasure gold, 4 factory teal).
const KEY_RES = 'res';
const RESOURCE_COLOR = ['#5faa38', '#4a88cc', '#d7a03a', '#e6c144', '#43b598'];
const resCache = new Map();   // ageId -> Map(plotIndex -> classCode)
function readResourcesForAge(ageId) {
  if (resCache.has(ageId)) return resCache.get(ageId);
  const m = new Map();
  try { const raw = getCatalog().getObject(OBJ_BASE).read(KEY_RES + '_' + ageId); if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) for (const e of a) m.set(e[0], e[1]); } } catch (e) { err(`resources ${ageId} read: ${e}`); }
  resCache.set(ageId, m);
  return m;
}
function resourcesForPos() { return frames.length ? readResourcesForAge(frames[pos][0]) : new Map(); }
function readNatural() {   // static list of natural-wonder plot indexes
  try { const raw = getCatalog().getObject(OBJ_BASE).read(KEY_NATURAL); if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) return a; } } catch (e) { err(`natural read: ${e}`); }
  return [];
}
const suzeCache = new Map();   // turn -> Map(cityStateId -> suzerainId)
function readSuzerainTurn(t) {
  if (suzeCache.has(t)) return suzeCache.get(t);
  const m = new Map();
  try { const raw = getCatalog().getObject(OBJ_SUZE).read('s' + t); if (raw) { const r = JSON.parse(raw); if (r && Array.isArray(r.s)) for (const [cs, suz] of r.s) m.set(cs, suz); } } catch (e) { err(`suze ${t} read: ${e}`); }
  suzeCache.set(t, m);
  return m;
}
// Turn records are write-once, so cache parsed records to avoid re-reading + re-parsing on every scrub.
const turnCache = new Map();
function readTurnCached(t) { if (turnCache.has(t)) return turnCache.get(t); const r = readTurn(t); turnCache.set(t, r); return r; }
// Frames are indexed by a GLOBAL index (gi) that runs across ALL ages (frames[gi] = [ageId, turn, snap]),
// and gi is also the storage key. Each age begins with a snapshot, so the nearest snapshot at-or-before a
// gi is always within the same age → walking gi back to it, then forward, reconstructs that age's state
// without any per-age bookkeeping. `apply(record, isSnapshot)` folds each record into the accumulator.
function walkFrames(targetGi, apply) {
  let snap = -1;
  for (let g = targetGi; g >= 0; g--) if (frames[g] && frames[g][2] === 1) { snap = g; break; }   // nearest snapshot ≤ targetGi
  if (snap < 0) return;
  const snapRec = readTurnCached(snap); if (snapRec) apply(snapRec, true);
  for (let g = snap + 1; g <= targetGi; g++) { const rec = readTurnCached(g); if (rec) apply(rec, rec.s === 1); }
}
/** Reconstruct Map plotIndex -> (ownerId<<3 | cls) at frame gi. terr is a flat array of packed ints. */
function reconstruct(targetGi) {
  const m = new Map();
  walkFrames(targetGi, (rec, isSnap) => { if (isSnap) m.clear(); for (const v of rec.terr) { const t = unpackTerr(v); if (t[1] < 0) m.delete(t[0]); else m.set(t[0], (t[1] << 3) | (t[2] & 7)); } });
  return m;
}
// Man-made wonders at frame gi (the `won` delta rides on the turn records) → Map(plot -> [owner, typeIdx]).
// A `won` entry of length <= 1 is a removal.
function reconstructWonders(targetGi) {
  const m = new Map();
  walkFrames(targetGi, (rec, isSnap) => { if (isSnap) m.clear(); if (Array.isArray(rec.won)) for (const e of rec.won) { if (e.length <= 1) m.delete(e[0]); else m.set(e[0], [e[1], e[2]]); } });
  return m;
}
let curWonders = null, curWondersPos = -2;
function wondersForPos() {
  if (curWondersPos === pos && curWonders) return curWonders;
  curWonders = frames.length ? reconstructWonders(pos) : new Map();
  curWondersPos = pos;
  return curWonders;
}
function wonderNameByIdx(idx) { const t = (manifest && Array.isArray(manifest.wonderTypes)) ? manifest.wonderTypes[idx] : null; return t ? (t[1] || '') : ''; }
// Per-tile constructibles at frame gi (the `bld` delta rides on the same records). Map(plot -> [typeIdx…]).
function reconstructBuildings(targetGi) {
  const m = new Map();
  walkFrames(targetGi, (rec, isSnap) => { if (isSnap) m.clear(); if (Array.isArray(rec.bld)) for (const [plot, arr] of rec.bld) { if (arr && arr.length) m.set(plot, arr); else m.delete(plot); } });
  return m;
}
// Lazily reconstruct + cache the building map for the current scrub position (rebuilt only on pos change,
// so scrubbing stays cheap and hovers reuse it).
let curBuildings = null, curBuildingsPos = -2;
function buildingsForPos() {
  if (curBuildingsPos === pos && curBuildings) return curBuildings;
  curBuildings = frames.length ? reconstructBuildings(pos) : new Map();
  curBuildingsPos = pos;
  return curBuildings;
}
// Settlements at frame gi (the `set` delta rides on the records). Map(center -> [name, pop, type, [yields]]).
// A `set` entry of length <= 1 is a removal (razed/absorbed).
function reconstructSettlements(targetGi) {
  const m = new Map();
  walkFrames(targetGi, (rec, isSnap) => { if (isSnap) m.clear(); if (Array.isArray(rec.set)) for (const e of rec.set) { if (e.length <= 1) m.delete(e[0]); else m.set(e[0], [e[1], e[2], e[3], e[4]]); } });
  return m;
}
let curSettlements = null, curSettlementsPos = -2;
function settlementsForPos() {
  if (curSettlementsPos === pos && curSettlements) return curSettlements;
  curSettlements = frames.length ? reconstructSettlements(pos) : new Map();
  curSettlementsPos = pos;
  return curSettlements;
}
// Local-observer visibility at frame gi (the `vis` delta rides on the records). Int8Array[w*h]:
// 0 hidden / 1 revealed / 2 in-LOS. Missing tiles default to 0 (hidden).
function reconstructVisibility(targetGi) {
  const n = basePos ? basePos.length : ((manifest && manifest.w && manifest.h) ? manifest.w * manifest.h : 0);
  const vis = new Int8Array(n);
  walkFrames(targetGi, (rec, isSnap) => { if (isSnap) vis.fill(0); if (Array.isArray(rec.vis)) for (const v of rec.vis) { const i = unpackVisI(v); if (i >= 0 && i < n) vis[i] = unpackVisS(v); } });
  return vis;
}
let curVis = null, curVisPos = -2;
function visForPos() {
  if (curVisPos === pos && curVis) return curVis;
  curVis = frames.length ? reconstructVisibility(pos) : new Int8Array(0);
  curVisPos = pos;
  return curVis;
}
// Per-player HISTORICAL identity at frame gi (from the delta-coded `idd` in the players store) →
// Map(pid -> [leader, civ, adjective, primaryInt, secondaryInt, civType, csType]). Civ/colors change at
// age transitions (e.g. Aksum → Abbasid), so this lets each age show the civ that was actually played
// then, instead of the player's CURRENT civ — and lets dispersed city-states (Players.get null) keep
// their recorded name/class. Fields are Locale-composed strings / raw color ints from record time;
// csType (city-state class code) is absent in recordings made before 2026-07-09.
const playersCache = new Map();   // gi -> parsed players record { t, s, vp, idd }
function readPlayersRec(gi) {
  if (playersCache.has(gi)) return playersCache.get(gi);
  let r = null;
  try { const raw = getCatalog().getObject(OBJ_PLAYERS).read('p' + gi); if (raw) r = JSON.parse(raw); } catch (e) { err(`players ${gi} read: ${e}`); }
  playersCache.set(gi, r);
  return r;
}
function reconstructIdentity(targetGi) {
  const m = new Map();
  let snap = -1;
  for (let g = targetGi; g >= 0; g--) if (frames[g] && frames[g][2] === 1) { snap = g; break; }   // nearest snapshot ≤ targetGi
  if (snap < 0) return m;
  const apply = (rec, isSnap) => { if (!rec) return; if (isSnap) m.clear(); if (Array.isArray(rec.idd)) for (const e of rec.idd) { if (e.length <= 1) m.delete(e[0]); else m.set(e[0], e.slice(1)); } };
  apply(readPlayersRec(snap), true);
  for (let g = snap + 1; g <= targetGi; g++) apply(readPlayersRec(g), false);
  return m;
}
let curIdentity = null, curIdentityPos = -2;
function identityForPos() {
  if (curIdentityPos === pos && curIdentity) return curIdentity;
  curIdentity = frames.length ? reconstructIdentity(pos) : new Map();
  curIdentityPos = pos;
  return curIdentity;
}
// Majors the local observer had met AT the current frame (recorded full per frame) → Set of pids. Powers
// history-aware fog: leaders appear in the ribbon only once they've been met.
function metForPos() {
  const rec = frames.length ? readPlayersRec(pos) : null;
  return new Set(rec && Array.isArray(rec.met) ? rec.met : []);
}
// Pairwise broad relationships at the current frame (delta-coded in the players records) → Map("a,b" a<b →
// code: 0 neutral / 1 up / 2 down / 3 alliance / 4 war).
function reconstructRelationships(targetGi) {
  const m = new Map();
  let snap = -1;
  for (let g = targetGi; g >= 0; g--) if (frames[g] && frames[g][2] === 1) { snap = g; break; }
  if (snap < 0) return m;
  const apply = (rec, isSnap) => { if (!rec) return; if (isSnap) m.clear(); if (Array.isArray(rec.rel)) for (const e of rec.rel) { const k = e[0] + ',' + e[1]; if (e.length <= 2) m.delete(k); else m.set(k, e[2]); } };
  apply(readPlayersRec(snap), true);
  for (let g = snap + 1; g <= targetGi; g++) apply(readPlayersRec(g), false);
  return m;
}
let curRel = null, curRelPos = -2;
function relationshipForPos() {
  if (curRelPos === pos && curRel) return curRel;
  curRel = frames.length ? reconstructRelationships(pos) : new Map();
  curRelPos = pos;
  return curRel;
}
// Fog-of-war overlay colors (drawn last, over the map): hidden = opaque near-black; revealed = the same
// near-black at partial alpha so known-but-unseen terrain reads as dimmed.
const FOG_HIDDEN = '#04060a';
const FOG_REVEALED = 'rgba(4,6,10,0.55)';
// Frame value layout: cls = v&7, ownerId = (v>>3)&63, suzerain = (v>>9)?(v>>9)-1:-1 (only on
// city-state CENTER tiles). reconstruct() builds the owner/cls part; frameFor() tags suzerained
// city-state centers so the incremental diff naturally repaints them when suzerainty changes.
function frameFor(gi) {
  const frame = reconstruct(gi);
  const suz = readSuzerainTurn(gi);
  if (suz && suz.size) {
    for (const [i, v] of frame) {
      if ((v & 7) === 2 && ownerMeta(v >> 3).kind === 'citystate') {   // v is still raw here (no suze bits)
        const s = suz.get(v >> 3);
        if (s != null && s >= 0) frame.set(i, v | ((s + 1) << 9));
      }
    }
  }
  return frame;
}

// --- colors ------------------------------------------------------------------
const PALETTE = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
  '#46f0f0', '#f032e6', '#bcf60c', '#fa8072', '#008080', '#e6beff', '#9a6324', '#aaffc3'];
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function intToRgb(c) { return [c & 255, (c >> 8) & 255, (c >> 16) & 255]; }   // R,G,B low->high
function colorOk(c) { if (!c) return false; const r = c & 255, g = (c >> 8) & 255, b = (c >> 16) & 255; return !(r > 240 && g > 240 && b > 240); }
const rgbCss = a => `rgb(${a[0]},${a[1]},${a[2]})`;
function blendCss(base, over, a) { return `rgb(${Math.round(base[0] * (1 - a) + over[0] * a)},${Math.round(base[1] * (1 - a) + over[1] * a)},${Math.round(base[2] * (1 - a) + over[2] * a)})`; }

// Dual player colors. Usage (per user spec): inner fill + city-center dot = PRIMARY;
// outer border + urban tiles = SECONDARY.
// Cached per (pos, owner): a player's colors can differ per age (civ swap), so the recorded colors for the
// CURRENT frame win; fall back to the live engine colors, then the palette.
const ownerColorCache = new Map();
function ownerColors(owner) {
  const ck = pos + ':' + owner;
  if (ownerColorCache.has(ck)) return ownerColorCache.get(ck);
  let primary = null, secondary = null;
  const id2 = identityForPos().get(owner);   // recorded [leader, civ, adj, primaryInt, secondaryInt]
  if (id2) { if (colorOk(id2[3])) primary = intToRgb(id2[3]); if (colorOk(id2[4])) secondary = intToRgb(id2[4]); }
  if (!primary) { try { const c = UI.Player.getPrimaryColorValueAsHex(owner); if (colorOk(c)) primary = intToRgb(c); } catch (e) {} }
  if (!secondary) { try { const c = UI.Player.getSecondaryColorValueAsHex(owner); if (colorOk(c)) secondary = intToRgb(c); } catch (e) {} }
  if (!primary) primary = hexToRgb(PALETTE[((owner % PALETTE.length) + PALETTE.length) % PALETTE.length]);
  if (!secondary) secondary = primary.map(v => Math.round(v * 0.55));
  const out = { primary, primaryCss: rgbCss(primary), secondary, secondaryCss: rgbCss(secondary) };
  ownerColorCache.set(ck, out);
  return out;
}

// per-owner classification — cached. kind:
//   'major'     -> isMajor: real color, border, tint
//   'citystate' -> independent power / city-state: white tint + type-color border & dot
//   'village'   -> isBarbarian (camps): no border/fill
// City-states are detected via isIndependent OR isMinor — the engine sets one or the other depending
// on the power's state (the base game keys on isMinor; we saw isIndependent in an earlier game), so
// keying on only one mis-classified some city-states as majors (colored fill + dark secondary border).
const ownerMetaCache = new Map();
function csTypeLabel(def, code) {   // localized city-state type name ("Militaristic"), else title-cased code
  try { if (def && def.Name) { const n = L(def.Name); if (n && !/^LOC_/.test(n)) return n; } } catch (e) {}
  return code ? code.charAt(0) + code.slice(1).toLowerCase() : '';
}
function ownerMeta(owner) {
  if (ownerMetaCache.has(owner)) return ownerMetaCache.get(owner);
  // Default to 'citystate' (neutral white + gray), NOT 'major'. 'major' is only assigned on a positive
  // isMajor. Otherwise a city-state whose Players.get is null (removed/absorbed independent) or that
  // momentarily reports both isMinor and isIndependent false would fall through and render with MAJOR
  // styling (primary fill + secondary border → the teal-fill/black-border artifact).
  let kind = 'citystate', dotType = '#dddddd', typeLabel = '', resolved = false;
  try {
    const pl = (typeof Players !== 'undefined' && Players.get) ? Players.get(owner) : null;
    if (pl && pl.isMajor) { kind = 'major'; resolved = true; }
    else if (pl && pl.isBarbarian) { kind = 'village'; resolved = true; }
    else {
      kind = 'citystate';   // any non-major, non-barbarian (incl. unclassifiable / null) → independent power
      let def; try { if (pl && pl.getCityStateCityStateType) def = GameInfo.CityStateTypes.lookup(pl.getCityStateCityStateType()); } catch (e) {}
      let code = def && def.CityStateType;
      if (!code) {   // dispersed city-state: live lookup fails → recorded class (identity[6], absent pre-2026-07-09 recordings)
        try { const id2 = identityForPos().get(owner); if (id2 && id2[6]) code = id2[6]; } catch (e) {}
      }
      dotType = CITYSTATE_TYPE_COLOR[code] || '#dddddd';
      typeLabel = csTypeLabel(def, code);
      resolved = !!code;
    }
  } catch (e) {}
  const meta = { kind, dotType, typeLabel };
  // Don't cache an unresolved city-state (gray, unlabeled): the recorded class may become readable at a
  // different frame (identity is per-pos), and a later call should get to retry.
  if (resolved) ownerMetaCache.set(owner, meta);
  return meta;
}

// --- layout / geometry -------------------------------------------------------
let basePos = null, terrain = null, maxCol = 0, maxRow = 0;
let idxByCR = null, layoutW = 0;   // (col,row) -> plot index lookup, for cursor→hex hit-testing (tooltips)
let cellByIndex = null, paintedKey = null, neighborsByIndex = null;
let hexW = 12, hexH = 14, rowStep = 10, mapPxW = 0, mapPxH = 0, mapX = 0, mapY = 0;
let exitKeepoutX = null;   // left edge of the Exit button (px) the scrub bar must stay left of; null = none
let EDGE = null, segLen = 8, borderT = 3, outlineT = 5, dotR = 3;

// Measure the available area at runtime: the real Victories content pane + Exit button if present
// (so layout adapts to any resolution/aspect), else a viewport default for the in-game launcher.
let cachedPaneArea = null;   // last real Victories-pane measurement, reused in-game so the overlay matches its size
// Horizontal footprint of the minimap/lens widget (where our Rewind checkbox lives) measured inward from
// whichever screen edge it hugs, in CSS px — 0 if not found. Used to pad the in-game map so it clears the
// lens menu. Clamped so a bad measurement can never collapse the map.
const LENS_TIGHTEN = 24;   // let the map edge sit slightly INTO the widget's (transparently-padded) bounding box for a tighter fit
// Horizontal footprint of the minimap/lens widget, plus which screen edge it hugs. The widget lives in one
// bottom corner, so we only need to keep the map off THAT side — not both — which is what lets the in-game
// map spread across the rest of the width.
function lensBox(iw) {
  try {
    const el = document.querySelector('.mini-map-container') || document.querySelector('panel-mini-map');
    if (!el) return { intrusion: 0, onRight: true };
    const r = el.getBoundingClientRect();
    if (!r || r.width < 10 || r.height < 10) return { intrusion: 0, onRight: true };
    const onRight = (r.left + r.width / 2) > iw / 2;
    const intrusion = onRight ? (iw - r.left) : r.right;
    return { intrusion: Math.max(0, Math.min(Math.round(iw * 0.45), Math.round(intrusion))), onRight };
  } catch (e) { return { intrusion: 0, onRight: true }; }
}
function measureArea() {
  const iw = (typeof window !== 'undefined' && window.innerWidth) || 1920;
  const ih = (typeof window !== 'undefined' && window.innerHeight) || 1080;
  try {
    const pane = document.getElementById(PANE_EL_ID);
    if (pane) {
      const r = pane.getBoundingClientRect();
      if (r && r.width > 80 && r.height > 80) {
        let exitLeft = null, exitTop = null;
        const eb = document.getElementById(EXIT_EL_ID);
        if (eb) { const er = eb.getBoundingClientRect(); if (er && er.width > 0 && er.height > 0) { exitLeft = er.left; exitTop = er.top; } }
        cachedPaneArea = mkArea(r.left, r.top, r.width, r.height, exitLeft, exitTop, true);   // pane=true
        return cachedPaneArea;
      }
    }
  } catch (e) { err(`measureArea: ${e}`); }
  // In-game (no Victories pane visible): size straight from the viewport so the map is as large as the
  // screen allows, kept CENTERED on screen. Vertically it fills a tall band clear of the top HUD and the
  // bottom scrub bar. Horizontally it pads BOTH sides equally by the minimap/lens widget's footprint (so
  // the map clears that bottom corner while staying centered — the map is height-bound, so the symmetric
  // pad costs no map size here anyway).
  const top = Math.round(ih * 0.045), bottom = Math.round(ih * 0.955);
  const margin = Math.round(iw * 0.012);
  const lens = lensBox(iw);
  const pad = lens.intrusion > 0 ? Math.max(margin, lens.intrusion - LENS_TIGHTEN) : margin;
  return mkArea(pad, top, Math.max(80, iw - 2 * pad), Math.max(80, bottom - top), null, null);
}
function mkArea(x, y, w, h, exitLeft, exitTop, pane) {
  const R = v => Math.round(v);
  const a = { x: R(x), y: R(y), w: R(w), h: R(h), exitLeft: exitLeft != null ? R(exitLeft) : null, exitTop: exitTop != null ? R(exitTop) : null, pane: !!pane };
  a.key = `${a.x},${a.y},${a.w},${a.h},${a.exitLeft},${a.exitTop},${a.pane ? 1 : 0}`;
  return a;
}
let layoutDims = '';
let backdrop = null;
// The map is drawn across a FIXED, small set of canvases plus DOM layers for the per-tile markers. Every
// canvas paint call permanently consumes ~1 item of Coherent's per-process 49,152 static-resource pool
// (see the KNOWN ISSUE note), while clears, display swaps, and DOM mutation are measured FREE — so paints
// happen only where recorded content actually changed:
//   bg    — static terrain (fog off) / flat hidden fill (fog on); repainted only on layout or fog change.
//   state — territory fills + fog dim + borders + capital stars, plus (fog on only) the vis-gated resource
//           overlay and natural-wonder rings; repainted per position change, with a sequential-advance
//           SKIP gate and a color-batched PARTIAL repaint (only the changed tiles) before any wholesale.
//   res   — one canvas per age, painted once; shown when fog is OFF (swapped per age, pure show/hide).
//   natw  — one canvas per game, painted once; shown when fog is OFF (winding-hole rings show the live
//           map through the hole). Fog ON hides res+natw and draws their content in the state layer.
//   DOM   — man-made wonders, city dots, unit markers: diffed per frame via certified-free style writes
//           (position/color/opacity), never recreated.
// A module-level mapCtx points at the canvas being painted, so the low-level path builders stay
// unchanged. mapRoot aliases the bg element for existence/geometry guards.
const bgLayer    = { id: 'rewind-map-bg',    z: 99981, el: null, ctx: null };
const stateLayer = { id: 'rewind-map-state', z: 99982, el: null, ctx: null };
const LAYERS = [bgLayer, stateLayer];
// Per-age / per-game painted-once canvases. byAge maps a key (ageId for res; 0 for the single natw canvas)
// to a slot painted exactly once; showing one is a display swap. Under FOG both are hidden and their
// content is drawn vis-gated in the state layer (a static canvas can't respect per-frame visibility).
function mkAgedLayer(id, z) { return { id, z, byAge: new Map(), spare: [], el: null }; }
const resLayer  = mkAgedLayer('rewind-map-res',  99984);   // resources: constant within an age
const natwLayer = mkAgedLayer('rewind-map-natw', 99986);   // natural wonders: constant for the whole game
// DOM marker containers: man-made wonder triangles (border-trick divs; drawWonderLayer skips fog-hidden
// tiles), city dots (Borders toggle), unit markers on top; unitDom is the map's pointer target
// (pointer-events:auto suppresses the live game's plot tooltip). Markers are reusable divs mutated with
// certified-free ops (position/color/opacity-park; styled-element hide/show cycles measured free — harness
// dispS, 150k cycles); never recreated.
const wonDom  = { id: 'rewind-map-mmw',   z: 99985, el: null };
const dotDom  = { id: 'rewind-map-dots',  z: 99988, el: null };
const unitDom = { id: 'rewind-map-units', z: 99989, el: null };
let mapRoot = null, mapVisible = false;
let building = false, buildToken = 0, revealWhenBuilt = false;
let showTerritory = true, showBorders = true;   // layer toggles: cell fills / boundary segments + center markers
let showLeaders = true;                          // leader ribbon (top-right, over the map)
let showResources = false;                       // resource overlay (hollow hex tinted by class), off by default
let fogMode = false, suppressFog = false;        // fog-of-war overlay (defaults ON at every map open; see setFogFromContext)
let fogLocked = false;                           // multiplayer + game-in-progress: fog is forced ON and the toggle is disabled (no scouting the replay)
function isMultiplayerGame() { try { const g = (typeof Configuration !== 'undefined' && Configuration.getGame) ? Configuration.getGame() : null; return !!(g && g.isAnyMultiplayer); } catch (e) { return false; } }
// Is the game genuinely OVER for the local player (defeated / a victory claimed / the final age has ended)?
// Drives the MP fog lock: keyed on this rather than endgameMode, because the Victories→Rewind tab is
// reachable MID-game (endgameMode=true there), which would otherwise let a MP player scout via the replay.
// Any failure returns false (still-playing) → stays LOCKED, the safe anti-scout direction.
function isLocalGameOver() {
  try {
    const vm = (typeof Game !== 'undefined') ? Game.VictoryManager : null;
    if (vm) {
      if (typeof vm.getLatestPlayerDefeat === 'function' && typeof GameContext !== 'undefined') {
        const d = vm.getLatestPlayerDefeat(GameContext.localPlayerID);
        if (d != null && (typeof DefeatTypes === 'undefined' || d !== DefeatTypes.NO_DEFEAT)) return true;
      }
      if (typeof vm.getVictories === 'function') { const v = vm.getVictories(); if (v && v.length) return true; }
    }
    const ap = (typeof Game !== 'undefined') ? Game.AgeProgressManager : null;
    if (ap && ap.isFinalAge && ap.isAgeOver) return true;
  } catch (e) {}
  return false;
}
let bgDirty = true, bgFog = null;                // bg needs a (re)render; bgFog = the fog state the bg was last drawn with
function makeLayerEl(L) {
  const c = document.createElement('canvas'); c.id = L.id;
  // Canvases pass pointer events through; the unit container above them is the map's pointer target.
  // The bg layer carries the deep-ocean backfill + frame; upper layers are transparent.
  c.style.cssText = `position:fixed;pointer-events:none;z-index:${L.z};display:${mapVisible ? 'block' : 'none'};`;
  return c;
}
// BACKGROUND — Coherent canvas static-resource leak: every canvas fill()/stroke() call permanently
// registers ~1 item of the per-process 49,152 "static resource" pool (dense real workloads amortize to
// ~0.23/call) and nothing ever frees it; see the KNOWN ISSUE note at the canvas-draw section. The renderer
// minimizes paint calls (DOM markers for volatile content, skip gate + color-batched partial repaints for
// the state canvas) so a normal session stays far under the cap. There is no runtime budget guard — if a
// user somehow scrubs enough to exhaust the pool the game crashes, same as any canvas-heavy Gameface mod.
// Leak-hunt instrumentation + on-screen test panel (the "LEAK TEST" strip + [REWIND] HB heartbeat), kept
// behind this flag for easy re-enabling. Set false for release: contexts are then left un-instrumented
// (zero per-call overhead) and the HB.* counters stay idle.
const LT_ENABLED = false;
const HB = { draws: 0, spaints: 0, walks: 0, fills: 0, strokes: 0, subs: 0, marks: 0, moves: 0, mhides: 0, ribs: 0, rimg: 0, tips: 0, t0: Date.now() };
function instrumentCtx(ctx) {
  if (!LT_ENABLED) return;   // no wrapping in release → canvas ops run at native speed
  const f = ctx.fill.bind(ctx), s = ctx.stroke.bind(ctx), m = ctx.moveTo.bind(ctx);
  ctx.fill = function () { HB.fills++; return f.apply(null, arguments); };
  ctx.stroke = function () { HB.strokes++; return s.apply(null, arguments); };
  ctx.moveTo = function (x, y) { HB.subs++; return m(x, y); };
}

// === LEAK-TEST HARNESS (gated by LT_ENABLED; false in release) =========================================
// Isolates WHICH operation consumes the 49,152 static-resource pool: pick a mode from the on-screen "LEAK
// TEST" panel (visible while the map is open), then leave the game idle. The harness issues that one
// operation at a fixed rate against dedicated tiny-but-visible elements (bottom-left corner; they must be
// visible — Cohtml doesn't rasterize occluded/offscreen content). Per-op leak rate = 49,152 / ops-at-crash
// (read `test=` in the last [REWIND] HB line). A mode that survives ~20 min at 500 ops/s (~600k ops) is
// clean at <0.08/op. Most modes auto-stop after 25 min; the scrub/sweep soak modes run until clicked off.
let ltMode = 'off', ltOps = 0, ltTimer = null, ltStartMs = 0;
let ltCanvas = null, ltCtx = null, ltTextEl = null, ltWideEl = null, ltDispEl = null, ltDispSEl = null, ltPanel = null, ltStatus = null;
let ltCvShowEl = null;   // pre-painted canvas for the cvShow mode (display-cycled; pattern painted ONCE)
let ltManyCvs = null;    // cvMany mode: N map-sized canvases, each painted once — the per-frame-cache VRAM smoke test
const LT_RATES = { base: 0, scrub: 20, scrubR: 20, scrubT: 0, sweep: 20, fillS: 500, fillC: 500, fillG: 500, strk: 500, clear: 500, dstOut: 500, putImg: 200, text: 200, width: 200, disp: 200, dispS: 200, cvShow: 200, cvMany: 5, decay: 500 };
// Seeded PRNG (mulberry32) for the scrub mode: same seed + same recording = the same jump sequence every
// run, so pipeline changes can be compared crash-to-crash on identical workloads.
let ltRand = null;
function ltMulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
let ltImgData = null;   // reused ImageData for the putImg mode (the candidate fill/stroke-free renderer)
let ltSweepDir = 1, ltSweepLast = 0;
function ltOp(k) {
  switch (ltMode) {
    case 'sweep': {   // ping-pong: sequential playback forward then backward at 4x speed (100ms/turn) —
                      // the realistic replay workload (ticks at 20/s; steps gated to the 4x cadence).
      const now = Date.now();
      if (now - ltSweepLast < PLAY_SPEEDS[2]) break;
      ltSweepLast = now;
      if (frames.length && cellByIndex) {
        let next = pos + ltSweepDir;
        if (next >= frames.length) { ltSweepDir = -1; next = Math.max(0, frames.length - 2); }
        if (next < 0) { ltSweepDir = 1; next = Math.min(frames.length - 1, 1); }
        goToIndex(next);
      }
      break;
    }
    case 'scrub':   // deterministic random scrubbing through the REAL pipeline (goToIndex = full redraw +
    case 'scrubR':  // controls + ribbon), at ~hard-drag rate — the end-to-end calibration workload.
      if (frames.length && cellByIndex) goToIndex((ltRand() * frames.length) | 0);
      break;
    case 'fillS': ltCtx.beginPath(); ltCtx.rect(2, 2, 20, 20); ltCtx.fillStyle = '#3a6ea5'; ltCtx.fill(); break;
    case 'decay':   // pool-reclamation probe: 60s bursts of fillS (30k fills each) separated by 300s idle.
                    // No decay → crash ~64s into burst #2 (t≈7min). Reclaim ≥30k/5min → survives auto-stop.
                    // Partial → crash in burst #3-4; burst count at death measures the reclaim rate.
                    // (Only in-burst iterations issue a fill; the ops counter keeps ticking for pacing.)
      if (((Date.now() - ltStartMs) / 1000) % 360 < 60) { ltCtx.beginPath(); ltCtx.rect(2, 2, 20, 20); ltCtx.fillStyle = '#3a6ea5'; ltCtx.fill(); }
      break;
    case 'fillC': ltCtx.beginPath(); ltCtx.rect(2, 2, 20, 20); ltCtx.fillStyle = `rgb(${k % 251},${(k * 7) % 251},${(k * 13) % 251})`; ltCtx.fill(); break;
    case 'fillG': ltCtx.beginPath(); ltCtx.rect(1 + (k % 5), 1 + ((k * 3) % 5), 4 + (k % 16), 4 + ((k * 7) % 16)); ltCtx.fillStyle = '#3a6ea5'; ltCtx.fill(); break;
    case 'strk':  ltCtx.beginPath(); ltCtx.moveTo(2, 2); ltCtx.lineTo(22, 22); ltCtx.strokeStyle = '#3a6ea5'; ltCtx.lineWidth = 2; ltCtx.stroke(); break;
    case 'dstOut':  // destination-out erase (shape-keyed "undo" for incremental repaint). 1:1 with normal
                    // fills, same timing readout as `clear`: ~98s = erases cost ~1/call, ~197s = free.
                    // VISUAL support check: corner square flickering blue/empty = erases work; solid blue =
                    // composite op ignored by Cohtml → the whole erase idea is off the table.
      if (k & 1) { ltCtx.globalCompositeOperation = 'destination-out'; ltCtx.beginPath(); ltCtx.rect(2, 2, 20, 20); ltCtx.fillStyle = '#000'; ltCtx.fill(); ltCtx.globalCompositeOperation = 'source-over'; }
      else { ltCtx.beginPath(); ltCtx.rect(2, 2, 20, 20); ltCtx.fillStyle = '#3a6ea5'; ltCtx.fill(); }
      break;
    case 'clear':   // clearRect isolation — the op incremental repaints lean on. STRICT 1:1 fill/clear
                    // alternation: every clear follows a fill, so an "empty canvas clear" no-op
                    // optimization can't hide a leak. The known ~1/call fill rate is the clock: crash at
                    // ~49k ops (~197s) = clears clean; ~24.5k ops (~98s) = clears leak ~1/call too;
                    // between = partial (rate = 49152/(ops/2) - 1). Every branch crashes — no ambiguity.
      if (k & 1) ltCtx.clearRect(0, 0, 24, 24);
      else { ltCtx.beginPath(); ltCtx.rect(2, 2, 20, 20); ltCtx.fillStyle = '#3a6ea5'; ltCtx.fill(); }
      break;
    case 'putImg': {   // pixel upload, varying content — the fill/stroke-free rendering candidate
      if (!ltImgData) {
        // Cohtml's 2D context lacks createImageData; probe every route to a pixel buffer before giving up.
        try { if (typeof ltCtx.createImageData === 'function') ltImgData = ltCtx.createImageData(24, 24); } catch (e) {}
        try { if (!ltImgData && typeof ImageData !== 'undefined') ltImgData = new ImageData(24, 24); } catch (e) {}
        try { if (!ltImgData && typeof ImageData !== 'undefined') ltImgData = new ImageData(new Uint8ClampedArray(24 * 24 * 4), 24, 24); } catch (e) {}
        if (!ltImgData || typeof ltCtx.putImageData !== 'function') {
          console.error(`${TAG} putImg UNSUPPORTED: createImageData=${typeof ltCtx.createImageData} putImageData=${typeof ltCtx.putImageData} ImageData=${typeof ImageData} getImageData=${typeof ltCtx.getImageData}`);
          ltStart('off');
          if (ltStatus) ltStatus.textContent = 'putImg UNSUPPORTED';
          return;
        }
      }
      const d = ltImgData.data, v = k % 251;
      for (let p = 0; p < d.length; p += 4) { d[p] = v; d[p + 1] = (v * 7) % 251; d[p + 2] = (v * 13) % 251; d[p + 3] = 255; }
      ltCtx.putImageData(ltImgData, 0, 0); break;
    }
    case 'text':  ltTextEl.textContent = 'T' + k; break;
    case 'width': ltWideEl.style.width = (2 + (k % 40)) + 'px'; break;
    case 'disp':  ltDispEl.style.display = (k & 1) ? 'none' : 'block'; break;    // plain div; a hide+show cycle = 2 ops
    case 'dispS': ltDispSEl.style.display = (k & 1) ? 'none' : 'block'; break;   // ribbon-like styled div (border/radius/shadow)
    case 'cvMany': {   // per-frame-canvas cache smoke test: 40 map-sized canvases painted once, visibility
                       // cycled at 5/s. Watches for VRAM trouble (crash, corruption, FPS collapse) rather
                       // than pool math — pool cost is just the one-time ~3 paints per canvas (~120 items).
      if (!ltManyCvs) {
        ltManyCvs = [];
        const w = mapPxW > 0 ? Math.round(mapPxW) : 1200, h = mapPxH > 0 ? Math.round(mapPxH) : 900;
        for (let n = 0; n < 40; n++) {
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          cv.style.cssText = `position:fixed;left:120px;top:120px;width:${w}px;height:${h}px;z-index:2000008;display:none;pointer-events:none;`;
          document.body.appendChild(cv);
          try {   // painted exactly once: full tint + two distinguishing shapes so cycling is visible
            const c = cv.getContext('2d');
            c.fillStyle = `rgb(${(n * 37) % 200 + 30},${(n * 71) % 200 + 30},${(n * 113) % 200 + 30})`; c.fillRect(0, 0, w, h);
            c.fillStyle = '#ffffff'; c.fillRect((n * 29) % (w - 60), (n * 53) % (h - 60), 60, 60);
            c.fillStyle = '#101418'; c.fillRect(w / 2 - 40, h / 2 - 40, 80, 80);
          } catch (e) {}
          ltManyCvs.push(cv);
        }
      }
      for (let n = 0; n < ltManyCvs.length; n++) ltManyCvs[n].style.display = (n === k % ltManyCvs.length) ? 'block' : 'none';
      break;
    }
    case 'cvShow':  // display-cycle a canvas painted ONCE (10 fills at creation, never repainted). Crash at
                    // ~50s = re-show replays the command buffer (~10 items/show); ~8min = ~1/show (texture
                    // re-registration); survives = free. AFTER the run: pattern still visible = content
                    // survives hiding; blank = Cohtml drops hidden canvas backings → per-age canvases dead.
      ltCvShowEl.style.display = (k & 1) ? 'none' : 'block'; break;
  }
}
function ltEnsureEls() {
  if (ltCanvas) return;
  ltCanvas = document.createElement('canvas'); ltCanvas.width = 24; ltCanvas.height = 24;
  // Hot-pink backing: erased/cleared regions show PINK through the canvas. dstOut visual verdict: square
  // flashing pink/purple = destination-out works; solid dark blue = composite op ignored (#000 erase-fills).
  ltCanvas.style.cssText = 'position:fixed;left:4px;bottom:44px;width:24px;height:24px;z-index:2000009;background-color:#ff00ff;pointer-events:none;';
  ltCtx = ltCanvas.getContext('2d');   // deliberately NOT instrumented — the harness counts its own ops via ltOps
  ltTextEl = document.createElement('div');
  ltTextEl.style.cssText = 'position:fixed;left:32px;bottom:52px;z-index:2000009;color:#888;font-size:10px;pointer-events:none;';
  ltTextEl.textContent = 'T0';
  ltWideEl = document.createElement('div');
  ltWideEl.style.cssText = 'position:fixed;left:32px;bottom:44px;height:4px;width:2px;z-index:2000009;background-color:#888;pointer-events:none;';
  ltDispEl = document.createElement('div');
  ltDispEl.style.cssText = 'position:fixed;left:80px;bottom:44px;width:14px;height:14px;z-index:2000009;background-color:#666;pointer-events:none;';
  ltDispSEl = document.createElement('div');   // ribbon-row-like: border + radius + shadow (generated imagery)
  ltDispSEl.style.cssText = 'position:fixed;left:100px;bottom:44px;width:14px;height:14px;z-index:2000009;background-color:#446;border:2px solid #6a88bb;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,0.6);pointer-events:none;';
  ltCvShowEl = document.createElement('canvas'); ltCvShowEl.width = 16; ltCvShowEl.height = 16;
  ltCvShowEl.style.cssText = 'position:fixed;left:120px;bottom:44px;width:16px;height:16px;z-index:2000009;background-color:#222;pointer-events:none;';
  try {   // checker pattern, painted exactly once — never repainted by the mode
    const c = ltCvShowEl.getContext('2d');
    for (let q = 0; q < 10; q++) { c.beginPath(); c.rect((q % 4) * 4, ((q / 4) | 0) * 4, 4, 4); c.fillStyle = (q & 1) ? '#3a6ea5' : '#e8e8e8'; c.fill(); }
  } catch (e) {}
  document.body.appendChild(ltCanvas); document.body.appendChild(ltTextEl); document.body.appendChild(ltWideEl);
  document.body.appendChild(ltDispEl); document.body.appendChild(ltDispSEl); document.body.appendChild(ltCvShowEl);
}
function ltMaxMs() { return (ltMode === 'scrub' || ltMode === 'scrubR' || ltMode === 'scrubT' || ltMode === 'sweep') ? Infinity : 25 * 60000; }   // scrub/sweep soaks run until clicked off
function ltStart(mode) {
  ltEnsureEls();
  if (ltTimer) { clearInterval(ltTimer); ltTimer = null; }
  const prevMode = ltMode, prevOps = ltOps;
  ltMode = mode; ltOps = 0; ltStartMs = Date.now();
  if (ltCvShowEl) ltCvShowEl.style.display = 'block';   // end any cvShow run visible, so the pattern-survival verdict can be read
  if (ltManyCvs && mode !== 'cvMany') for (const cv of ltManyCvs) cv.style.display = 'none';   // leaving cvMany → hide the big test canvases
  if (mode === 'scrub' || mode === 'scrubR' || mode === 'scrubT') { ltRand = ltMulberry(20260709); try { pause(); } catch (e) {} }   // fixed seed → reproducible jump sequence
  if (mode === 'sweep') { ltSweepDir = 1; ltSweepLast = 0; try { pause(); } catch (e) {} }
  console.error(`${TAG} LEAK TEST mode=${mode} rate=${LT_RATES[mode] || 0}/s${mode === 'off' && prevMode !== 'off' ? ` (ended ${prevMode} at ops=${prevOps} after ${Math.round((Date.now() - HB.t0) / 1000)}s uptime)` : ''}`);
  ltUpdatePanel();
  if (mode === 'off') {
    // Keep the ended run's final count on screen (the full time series is in UI.log's HB lines anyway).
    if (ltStatus && prevMode !== 'off') ltStatus.textContent = `off (${prevMode} ended: ops=${prevOps})`;
    return;
  }
  if (mode === 'scrubR') {   // rAF-paced twin of `scrub` (same seed/rate): isolates scheduler-context call
                             // pricing — timer-context draws measured ~1/call, rAF-context (real dragging) ~0.23.
    const tick = () => {
      if (ltMode !== 'scrubR') return;
      if (Date.now() - ltStartMs > ltMaxMs()) { ltStart('off'); return; }
      const due = ((Date.now() - ltStartMs) / 50) | 0;   // 20 ops/s wall-clock, paced inside animation frames
      if (ltOps < due) ltOp(ltOps++);                    // max ONE draw per animation frame, like real drag coalescing
      if (ltStatus) ltStatus.textContent = `${ltMode} ops=${ltOps}`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return;
  }
  if (mode === 'scrubT') {   // realistic drag emulator: drives the REAL input path (seeking flag +
                             // scheduleSeek/renderSeekTarget coalescing + release/re-grab gestures) with a
                             // seeded cursor random walk over the actual track — variable-speed sweeps,
                             // hold-still pauses, occasional releases (which fire the deferred ribbon
                             // rebinds exactly like a human letting go of the mouse).
    let phase = 'drag', phaseUntil = 0, x = 0, v = 0, last = 0;
    const trackBox = () => { try { return els.track.getBoundingClientRect(); } catch (e) { return null; } };
    const newSegment = (t) => {
      const r = ltRand();
      if (r < 0.70) { phase = 'drag'; v = (ltRand() < 0.5 ? -1 : 1) * (30 + ltRand() * 1170); phaseUntil = t + 300 + ltRand() * 2700; }
      else if (r < 0.90) { phase = 'pause'; v = 0; phaseUntil = t + 300 + ltRand() * 1700; }                     // still held down
      else { phase = 'released'; try { onSeekEnd({ clientX: x }); } catch (e) {} phaseUntil = t + 200 + ltRand() * 800; }
    };
    const tick = () => {
      if (ltMode !== 'scrubT') return;
      const t = Date.now();
      if (t - ltStartMs > ltMaxMs()) { try { onSeekEnd({ clientX: x }); } catch (e) {} ltStart('off'); return; }
      const box = trackBox();
      if (box && box.width > 0) {
        if (!last) { last = t; x = box.left + ltRand() * box.width; try { onSeekStart({ clientX: x, preventDefault: () => {} }); } catch (e) {} newSegment(t); }
        const dt = Math.min(100, t - last) / 1000; last = t;
        if (t >= phaseUntil) {
          if (phase === 'released') { try { onSeekStart({ clientX: x, preventDefault: () => {} }); } catch (e) {} }
          newSegment(t);
        }
        if (phase === 'drag') {
          x += v * dt;
          if (x < box.left) { x = box.left; v = Math.abs(v); }
          if (x > box.left + box.width) { x = box.left + box.width; v = -Math.abs(v); }
          onSeekMove({ clientX: x }); ltOps++;
        }
      }
      if (ltStatus) ltStatus.textContent = `${ltMode} ops=${ltOps}`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return;
  }
  const rate = LT_RATES[mode] || 0;
  ltTimer = setInterval(() => {
    if (Date.now() - ltStartMs > ltMaxMs()) { ltStart('off'); return; }   // auto-stop (scrub soaks: none — stop by clicking off)
    for (let i = 0; i < rate / 20; i++) ltOp(ltOps++);
    if (ltStatus) ltStatus.textContent = `${ltMode} ops=${ltOps}`;
  }, 50);
}
function ltUpdatePanel() {
  if (!ltPanel) return;
  for (const b of ltPanel.__btns) b.style.backgroundColor = (b.__mode === ltMode) ? '#3a6ea5' : '#333';
  if (ltStatus) ltStatus.textContent = `${ltMode} ops=${ltOps}`;
}
function ltEnsurePanel() {
  if (!LT_ENABLED) return;
  if (ltPanel) { ltPanel.style.display = 'flex'; return; }
  ltPanel = document.createElement('div');
  ltPanel.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:2000010;display:flex;flex-direction:row;gap:4px;align-items:center;background:rgba(16,22,34,0.9);border:1px solid #555;border-radius:4px;padding:4px 6px;pointer-events:auto;';
  const title = document.createElement('div');
  title.textContent = 'LEAK TEST:'; title.style.cssText = 'color:#aaa;font-size:11px;';
  ltPanel.appendChild(title);
  ltPanel.__btns = [];
  for (const mode of ['off', 'base', 'scrub', 'scrubR', 'scrubT', 'sweep', 'fillS', 'fillC', 'fillG', 'strk', 'clear', 'dstOut', 'putImg', 'text', 'width', 'disp', 'dispS', 'cvShow', 'cvMany', 'decay']) {
    const b = document.createElement('div');
    b.textContent = mode; b.__mode = mode;
    b.style.cssText = 'color:#eee;font-size:11px;padding:2px 7px;border-radius:3px;background-color:#333;cursor:pointer;';
    b.onclick = () => ltStart(mode);
    ltPanel.appendChild(b); ltPanel.__btns.push(b);
  }
  ltStatus = document.createElement('div');
  ltStatus.style.cssText = 'color:#7f7;font-size:11px;margin-left:6px;';
  ltStatus.textContent = 'off ops=0';
  ltPanel.appendChild(ltStatus);
  document.body.appendChild(ltPanel);
}
// === END TEMP LEAK-TEST HARNESS =========================================================================
try { if (LT_ENABLED) setInterval(() => { if (mapVisible || ltMode !== 'off') console.error(`[REWIND] HB up=${Math.round((Date.now() - HB.t0) / 1000)}s fog=${fogMode ? 1 : 0} draws=${HB.draws} spaints=${HB.spaints} walks=${HB.walks} fills=${HB.fills} strokes=${HB.strokes} subs=${HB.subs} marks=${HB.marks} moves=${HB.moves} mhides=${HB.mhides} ribs=${HB.ribs} rimg=${HB.rimg} tips=${HB.tips} test=${ltMode}:${ltOps}`); }, 5000); } catch (e) {}
function ensureMapRoot() {
  for (const L of LAYERS) {
    if (!L.el) {
      L.el = makeLayerEl(L);
      document.body.appendChild(L.el);
      try { L.ctx = L.el.getContext('2d'); if (L.ctx) instrumentCtx(L.ctx); } catch (e) { err(`canvas ctx ${L.id}: ${e}`); }
    }
  }
  for (const dom of [wonDom, dotDom]) {
    if (!dom.el) {
      const d = document.createElement('div'); d.id = dom.id;
      d.style.cssText = `position:fixed;overflow:hidden;z-index:${dom.z};opacity:${mapVisible ? 1 : 0};pointer-events:none;`;
      document.body.appendChild(d);
      dom.el = d;
    }
  }
  if (!unitDom.el) {
    const d = document.createElement('div'); d.id = unitDom.id;
    // pointer-events:auto = the map's cursor target (suppresses the live-map plot tooltip); overflow:hidden
    // clips edge markers to the map rect, matching the old canvas bounds. Hidden via OPACITY, not display —
    // a display cycle on the container would re-rasterize every visible marker child on reopen (~1 static
    // pool item each; see the units-layer note). pointer-events flips with visibility so the hidden
    // container doesn't eat the live game's clicks.
    d.style.cssText = `position:fixed;overflow:hidden;z-index:${unitDom.z};opacity:${mapVisible ? 1 : 0};pointer-events:${mapVisible ? 'auto' : 'none'};`;
    document.body.appendChild(d);
    unitDom.el = d;
  }
  mapRoot = bgLayer.el; mapCtx = bgLayer.ctx;
  return bgLayer.el;
}
function markBgDirty() { bgDirty = true; }
function setMapVisible(on) {
  mapVisible = on; ensureMapRoot();
  for (const L of LAYERS) if (L.el) L.el.style.display = on ? 'block' : 'none';
  syncLayerDisplays();                                                       // shown cached canvases follow visibility + their toggles
  if (dotDom.el) dotDom.el.style.opacity = on ? '1' : '0';
  if (wonDom.el) wonDom.el.style.opacity = on ? '1' : '0';
  if (unitDom.el) { unitDom.el.style.opacity = on ? '1' : '0'; unitDom.el.style.pointerEvents = on ? 'auto' : 'none'; }
  try { if (on) ltEnsurePanel(); else if (ltPanel && ltMode === 'off') ltPanel.style.display = 'none'; } catch (e) {}   // TEMP leak-test harness UI
  syncCheckbox(on);
}
// Keep the injected "Rewind" minimap checkbox in step with the map's visibility. Guarded so the
// programmatic attribute change doesn't loop back through our component-value-changed handler.
let suppressCheckbox = false;
function syncCheckbox(on) {
  const cb = els.rewindCheckbox;
  if (!cb) return;
  const want = on ? 'true' : 'false';
  if (cb.getAttribute('selected') === want) return;
  suppressCheckbox = true;
  try { cb.setAttribute('selected', want); } finally { suppressCheckbox = false; }
}
// Canvas renderer: terrain, per-turn state, per-age resources and natural wonders are drawn into the
// canvas layers above; man-made wonders, city dots and units are DOM markers. The canvases replace the
// old ~4k-div tile overlay, so idle/hover never re-lays-out a huge DOM, and a frame change is a small
// state repaint (often just the changed tiles) plus a marker diff.
let mapCtx = null;                  // 2D context of the map canvas
let mapDpr = 1;                     // device-pixel ratio the canvas backing store is sized for
let curFrame = null;                // last drawn frame Map

// neighbor (col,row) in our odd-r layout (odd rows shifted +x/2). Order: E,W,NE,NW,SE,SW
function neighborColRow(c, r) {
  const even = (r & 1) === 0;
  return [
    [c + 1, r], [c - 1, r],
    even ? [c, r + 1] : [c + 1, r + 1], even ? [c - 1, r + 1] : [c, r + 1],
    even ? [c, r - 1] : [c + 1, r - 1], even ? [c - 1, r - 1] : [c, r - 1],
  ];
}

function computeLayout(w, h, area) {
  const n = w * h;
  const colrow = new Array(n);
  maxCol = 0; maxRow = 0;
  for (let i = 0; i < n; i++) { const l = GameplayMap.getLocationFromIndex(i); colrow[i] = { c: l.x, r: l.y }; if (l.x > maxCol) maxCol = l.x; if (l.y > maxRow) maxRow = l.y; }
  const W = maxCol + 1;
  // Victories PANE (mid- OR end-game): the map + scrub bar together fill the pane, scrub directly below the
  // map (no overlap). Reserve the real scrub-panel height so the map is sized to the rest, and center the
  // (map + scrub) BLOCK as a unit (below) so there's no empty band. Same for both, so the layout is
  // identical whether or not the game is over. In the full-screen in-game overlay there's no pane, so the
  // fixed SCRUB_RESERVE bounds the scrub bar below the map.
  const sr = ps(SCRUB_RESERVE), pad = ps(LAYOUT_PAD);
  // The scrub panel reports 0 height via getBoundingClientRect in Gameface (its custom-element children
  // don't contribute layout height), so its height is COMPUTED from the pieces it's built from — vertical
  // padding + control row (button height, the tallest child) + gap + timeline track — which scales with
  // ps() on every display. Pane case fills SNUGLY (no inner pad, no MAX_FILL margin) so the map+scrub fills
  // the whole pane, bounded by width or height per the aspect ratio.
  const panelH = area.pane ? paneScrubReserve() : 0;
  const pad2 = area.pane ? 0 : pad;
  const fill2 = area.pane ? 1 : MAX_FILL;
  const scrubBandTop = area.pane ? (area.y + area.h - panelH) : (area.y + area.h - sr);
  const fitTop = area.y + pad2, fitBottom = scrubBandTop - pad2;
  const zoneH = Math.max(40, fitBottom - fitTop), zoneW = Math.max(40, area.w - 2 * pad2);
  // MAX_FILL (in-game only) leaves a margin so the map never fills edge-to-edge; the pane case fills fully.
  const fitH = zoneH * fill2, fitW = zoneW * fill2;
  let hw = fitW / (maxCol + 1.5);
  const totalH = maxRow * (hw * 1.1547 * 0.75) + hw * 1.1547;
  if (totalH > fitH) hw *= fitH / totalH;
  hw = Math.max(MIN_CW, Math.min(MAX_CW, hw));
  hexW = Math.round(hw); hexH = Math.round(hw * 1.1547); rowStep = hexH * 0.75;
  mapPxW = Math.ceil((maxCol + 1.5) * hexW); mapPxH = Math.ceil(maxRow * rowStep + hexH);
  mapX = Math.round(area.x + (area.w - mapPxW) / 2);                       // center horizontally in the area
  if (area.pane) {
    // Center the (map + scrub) block vertically in the pane; the scrub sits flush below the map.
    mapY = Math.round(area.y + Math.max(0, (area.h - mapPxH - panelH) / 2));
  } else {
    // In-game overlay: center the map rectangle in the (HUD-clear) area; the scrub floats below it.
    mapY = Math.round(area.y + Math.max(0, (area.h - mapPxH) / 2));
  }
  exitKeepoutX = area.exitLeft;                                           // positionPanel keeps the scrub left of this

  basePos = new Array(n);
  for (let i = 0; i < n; i++) { const { c, r } = colrow[i]; basePos[i] = { x: c * hexW + ((r & 1) ? hexW / 2 : 0), y: (maxRow - r) * rowStep }; }

  // adjacency (index -> [6 neighbor indices or -1]); columns wrap (cylinder), rows don't.
  idxByCR = new Int32Array(W * (maxRow + 1)).fill(-1); layoutW = W;   // kept for cursor→hex hit-testing
  for (let i = 0; i < n; i++) idxByCR[colrow[i].r * W + colrow[i].c] = i;
  neighborsByIndex = new Array(n);
  for (let i = 0; i < n; i++) {
    const { c, r } = colrow[i];
    neighborsByIndex[i] = neighborColRow(c, r).map(([nc, nr]) => {
      if (nr < 0 || nr > maxRow) return -1;
      const wc = ((nc % W) + W) % W;
      return idxByCR[nr * W + wc];
    });
  }

  // edge templates (box w=hexW,h=hexH), order E,W,NE,NW,SE,SW
  const wA = hexW, hA = hexH;
  EDGE = [
    { mx: wA, my: 0.5 * hA, a: 90 }, { mx: 0, my: 0.5 * hA, a: 90 },
    { mx: 0.75 * wA, my: 0.125 * hA, a: 30 }, { mx: 0.25 * wA, my: 0.125 * hA, a: -30 },
    { mx: 0.75 * wA, my: 0.875 * hA, a: -30 }, { mx: 0.25 * wA, my: 0.875 * hA, a: 30 },
  ];
  segLen = hexW * 0.66; borderT = Math.max(2, Math.round(hexW * 0.16)); outlineT = borderT + 2; dotR = Math.max(3, Math.round(hexW * 0.25));   // city-center dot

  ensureMapRoot();   // ensure the canvas exists before positionChrome sizes it
  positionChrome();
  log(`computeLayout: ${W}x${maxRow + 1}, hex ${hexW}x${hexH}, area ${area.w}x${area.h}@(${area.x},${area.y}) exit=${area.exitLeft},${area.exitTop}, map ${mapPxW}x${mapPxH} at (${mapX},${mapY})`);
}

// Size + place one layer's canvas. Backing store is in device pixels (crisp); CSS box = map px. The bottom
// (bg) layer carries the deep-ocean backfill (so undrawn deep-ocean tiles show through) + a thin frame;
// upper layers are transparent and identically sized so the frame shows around them. Setting .width/.height
// resets the context, so re-apply the DPR transform after.
function applyLayerBox(L) {
  const cv = L.el; if (!cv) return;
  cv.width = Math.max(1, Math.round(mapPxW * mapDpr)); cv.height = Math.max(1, Math.round(mapPxH * mapDpr));
  cv.style.left = mapX + 'px'; cv.style.top = mapY + 'px';
  cv.style.width = mapPxW + 'px'; cv.style.height = mapPxH + 'px';
  if (L === bgLayer) {
    cv.style.backgroundColor = `rgb(${TERRAIN_RGB[0][0]},${TERRAIN_RGB[0][1]},${TERRAIN_RGB[0][2]})`;
    cv.style.border = `${ps(1)}px solid #6a88bb`; cv.style.borderRadius = `${ps(5)}px`;
  }
  if (L.ctx) L.ctx.setTransform(mapDpr, 0, 0, mapDpr, 0, 0);
}
function applyUnitBox() {
  for (const dom of [unitDom, dotDom, wonDom]) {
    const d = dom.el; if (!d) continue;
    d.style.left = mapX + 'px'; d.style.top = mapY + 'px';
    d.style.width = mapPxW + 'px'; d.style.height = mapPxH + 'px';
  }
}
function positionChrome() {
  ensureMapRoot();
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
  mapDpr = dpr;
  for (const L of LAYERS) applyLayerBox(L);
  applyUnitBox();
  markBgDirty();     // the canvases were resized (which clears them) → the static bg must be repainted
  resetUnitDom(); resetDotDom(); resetWonDom();   // marker positions/sizes depend on the layout → re-place them on the next draw
  positionPanel();
}
// place the scrubber directly below the map, horizontally centered on it
// Fit the control row to the map-width panel. When the content fits, the row is full-width so the flex:1
// side groups spread it (checkboxes flush-left, buttons centered on the map, fog+speed flush-right). When
// it doesn't fit (a narrow map), collapse the row to its content width (a centered cluster) and uniformly
// scale it down so buttons/checkboxes/text shrink together. Needs the panel visible; reveal() re-runs it.
function fitControlRow(panelW) {
  const row = els.controlRow, p = els.panel;
  if (!UNIFY_PS_CHROME || !row || !p || p.style.display === 'none') return;
  const kids = row.children;
  // Spread across the panel: the flex:1 side halves keep the playback buttons centered on the map. Then
  // shrink whichever side group overflows its (equal) half so its content doesn't spill into the buttons —
  // "scale the checkboxes to the available space". (Coherent rejects width:max-content, so we don't
  // shrink-wrap the whole row to measure it; we measure each side group's content via scrollWidth instead.)
  row.style.transform = 'none';
  row.style.width = '100%';
  fitGroupToBox(kids[0], 'left');    // layer checkboxes (left-aligned)
  fitGroupToBox(kids[2], 'right');   // fog + speed (right-aligned)
}
function fitGroupToBox(g, origin) {
  if (!g) return;
  g.style.transform = 'none';
  const box = g.clientWidth, content = g.scrollWidth;   // flex-allocated half vs natural content
  if (box > 0 && content > box + 1) { g.style.transformOrigin = origin + ' center'; g.style.transform = `scale(${box / content})`; }
}
// Deterministic scrub-panel height (getBoundingClientRect returns 0 in Gameface). Built in buildPanel as:
// ps(10) vertical padding ×2 + control row (button box ps(BTN_H), the tallest child) + ps(6) gap +
// ps(18) timeline track. Scales with ps() so the map+scrub fills the pane snugly on any display.
function paneScrubReserve() { return ps(10) * 2 + ps(BTN_H) + ps(6) + ps(18); }
function positionPanel() {
  if (!els.panel) return;
  const cx = mapX + mapPxW / 2;
  const w = mapPxW;   // panel (dark rounded rect) spans the full map width; on the endgame screen the Exit
                      // button renders on top of it and the control widgets are kept clear of it (fitControlRow)
  els.panel.style.left = cx + 'px';
  els.panel.style.top = (mapY + mapPxH) + 'px';   // flush with the bottom of the map (no gap)
  els.panel.style.width = Math.round(w) + 'px';   // panel spans the map width (w); track fills it
  if (els.track) els.track.style.width = '100%';
  if (UNIFY_PS_CHROME) fitControlRow(w);           // uniformly scale the control cluster down to fit that width
  // (the turn pill is positioned on scrubber hover, not here)
}

// --- canvas draw ------------------------------------------------------------------------------------
// KNOWN ISSUE — Coherent canvas static-resource leak. Sustained scrubbing overflowed Coherent's
// 49152-item "static resource" pool and hard-crashed the game (Renderer.log: "PartitionedResourceList.
// AddStaticResource(), attempting to add more than 49152 items"). Isolated harness runs pinned the cause:
// EVERY canvas fill()/stroke() call permanently registers ~1 pool item (dense real workloads amortize to
// ~0.23/call via within-flush dedup), and NOTHING frees them — clearRect, canvas.width reset, element
// recreate, display cycling, idle time all measured non-reclaiming; the one release API
// (cohtml::View::QueueClearCaches) is C++-host-side and Civ 7 never exposes or calls it; there is no
// pixel API (putImageData/getImageData/ImageData all undefined) and drawImage from an unpainted canvas
// composites black. So the ONLY lever is issuing fewer paint calls. That shapes the whole renderer:
//   • per-tile VOLATILE content (units, city dots, wonders) lives in DOM markers — mutating retained divs
//     (position/color/opacity) is measured FREE; it never touches the pool.
//   • canvas layers paint only where recorded content changed: the state layer skips unchanged sequential
//     turns and otherwise repaints only the changed tiles' color groups (tryPartialState); bg/res/natw
//     paint once. Fills MUST stay batched — one beginPath/fill|stroke per color group, never per shape;
//     and subpaths within one path must not overlap in area (Cohtml fills EVEN-ODD → overlap punches
//     holes). A normal session stays far under the 49152 cap; there is no runtime crash guard.
// Abandoned fixes, for the record: a frame cache (blit each frame via drawImage — drawImage is broken as
// above), glyph sprite sheets (Cohtml won't rasterize an unpainted source canvas), and a per-layer LRU
// canvas cache (couldn't hold enough of a real game's states to matter, and added large complexity).
// DPR: applyLayerBox sets the device-pixel transform once per layout; it persists across clearRect.
// path builders (append to the CURRENT path; caller does beginPath/fill/stroke once per color)
function hexSubpath(i) {
  const p = basePos[i], x = p.x, y = p.y, w = hexW, h = hexH;
  mapCtx.moveTo(x + 0.5 * w, y); mapCtx.lineTo(x + w, y + 0.25 * h); mapCtx.lineTo(x + w, y + 0.75 * h);
  mapCtx.lineTo(x + 0.5 * w, y + h); mapCtx.lineTo(x, y + 0.75 * h); mapCtx.lineTo(x, y + 0.25 * h); mapCtx.closePath();
}
// NOTE (2026-07-10): the outset/overlap trick for closing carpet seams is DEAD — Cohtml fills paths with
// EVEN-ODD semantics, so overlapping subpaths within one path punch HOLES along every shared edge (the
// wider the overlap, the wider the visible gap). Carpets close their seams the proven way instead: exact
// hexes + a same-color 1px stroke (fill+stroke per color group — see renderBackground/drawStateLayer).
// A hexagon scaled about the tile center by factor s (<1 shrinks — resource overlay; >1 expands — outset fills).
function insetHexSubpath(i, s) {
  const p = basePos[i], cx = p.x + 0.5 * hexW, cy = p.y + 0.5 * hexH;
  for (let k = 0; k < 6; k++) { const v = hexVert(i, k), vx = cx + (v[0] - cx) * s, vy = cy + (v[1] - cy) * s; if (k === 0) mapCtx.moveTo(vx, vy); else mapCtx.lineTo(vx, vy); }
  mapCtx.closePath();
}
function hexVert(i, k) {   // hex vertex k: 0 top,1 upper-right,2 lower-right,3 bottom,4 lower-left,5 upper-left
  const p = basePos[i], x = p.x, y = p.y, w = hexW, h = hexH;
  switch (k) { case 0: return [x + 0.5 * w, y]; case 1: return [x + w, y + 0.25 * h]; case 2: return [x + w, y + 0.75 * h]; case 3: return [x + 0.5 * w, y + h]; case 4: return [x, y + 0.75 * h]; default: return [x, y + 0.25 * h]; }
}
const EDGE_VERTS = [[1, 2], [4, 5], [0, 1], [5, 0], [2, 3], [3, 4]];   // dir E,W,NE,NW,SE,SW -> hex vertex pair
function edgeSubpath(i, dir) { const vp = EDGE_VERTS[dir], a = hexVert(i, vp[0]), b = hexVert(i, vp[1]); mapCtx.moveTo(a[0], a[1]); mapCtx.lineTo(b[0], b[1]); }
function circleSubpath(cx, cy, r) { mapCtx.moveTo(cx + r, cy); mapCtx.arc(cx, cy, r, 0, 2 * Math.PI); }
const STAR_PTS = [[0.50, 0.00], [0.61, 0.35], [0.98, 0.35], [0.68, 0.57], [0.79, 0.91], [0.50, 0.70], [0.21, 0.91], [0.32, 0.57], [0.02, 0.35], [0.39, 0.35]];
function starSubpath(cx, cy, r) { const x0 = cx - r, y0 = cy - r, d = 2 * r; for (let k = 0; k < STAR_PTS.length; k++) { const px = x0 + STAR_PTS[k][0] * d, py = y0 + STAR_PTS[k][1] * d; if (k === 0) mapCtx.moveTo(px, py); else mapCtx.lineTo(px, py); } mapCtx.closePath(); }
function triSubpath(cx, cy, r) { const h = Math.round(2 * r * TRI_RATIO), top = cy - 2 * h / 3; mapCtx.moveTo(cx, top); mapCtx.lineTo(cx + r, top + h); mapCtx.lineTo(cx - r, top + h); mapCtx.closePath(); }
// Counter-clockwise twin: appended after a CW triangle in the same path it punches a HOLE (works under
// both winding rules), so the natural-wonder ring shows the live map through its center.
function triSubpathCCW(cx, cy, r) { const h = Math.round(2 * r * TRI_RATIO), top = cy - 2 * h / 3; mapCtx.moveTo(cx, top); mapCtx.lineTo(cx - r, top + h); mapCtx.lineTo(cx + r, top + h); mapCtx.closePath(); }
function pushGroup(map, key, val) { let g = map.get(key); if (!g) { g = []; map.set(key, g); } g.push(val); }
// collect a tile's border edges + center marker into color-keyed groups (drawn batched later); city-state
// ring edges go to edgesTop (a top layer) so they aren't overwritten at boundaries with other owners.
// --- conquest tracking (border edge ownership) ---------------------------------------------------------
// A tile is CONQUERED at frame F if it's urban (cls >= 1) and its owner differs from its FOUNDER — the
// owner at its most recent not-urban -> urban transition at or before F. Episodes are built in one pass
// over the recorded deltas (owner changes while urban = the conquest itself, founder unchanged; razing
// ends an episode; a snapshot where the tile was already urban CONTINUES the episode, so conquered status
// survives age transitions while ownership holds). Conquered tiles always draw their contested edges, so
// a captured city's whole perimeter rings uniformly in the conqueror's color.
let conquestEpisodes = null;   // plot -> [[startGi, founderOwner], ...] in gi order
function buildConquestEpisodes() {
  conquestEpisodes = new Map();
  const curCls = new Map();
  const startEp = (i, g, own) => { let a = conquestEpisodes.get(i); if (!a) { a = []; conquestEpisodes.set(i, a); } a.push([g, own]); };
  for (let g = 0; g < frames.length; g++) {
    const rec = readTurnCached(g); if (!rec || !rec.terr) continue;
    if (rec.s === 1) {
      const nCls = new Map();
      for (const pv of rec.terr) { const t = unpackTerr(pv); if (t[1] >= 0) { nCls.set(t[0], t[2]); if (t[2] >= 1 && !((curCls.get(t[0]) || 0) >= 1)) startEp(t[0], g, t[1]); } }
      curCls.clear(); for (const [i, cc] of nCls) curCls.set(i, cc);
    } else {
      for (const pv of rec.terr) {
        const t = unpackTerr(pv), i = t[0];
        if (t[1] < 0) { curCls.delete(i); continue; }
        if (t[2] >= 1 && !((curCls.get(i) || 0) >= 1)) startEp(i, g, t[1]);
        curCls.set(i, t[2]);
      }
    }
  }
}
function founderAt(i, F) {
  if (!conquestEpisodes) buildConquestEpisodes();
  const a = conquestEpisodes.get(i); if (!a) return -1;
  let f = -1;
  for (const [g, own] of a) { if (g <= F) f = own; else break; }
  return f;
}
function conqueredAt(i, owner) { const f = founderAt(i, pos); return f >= 0 && f !== owner; }

// Border strokes: normal edges, then city-state rings on top. Contested edges facing an enemy URBAN
// tile aren't double-drawn at all — the non-urban side SKIPS them (see collectTileBorders), so a captured
// district's ring (capturer's color) wins without any extra stroke tier.
function strokeBorderTiers(edges, edgesTop, stars, cx, cy) {
  mapCtx.lineCap = 'round';
  for (const tier of [edges, edgesTop]) {
    for (const [color, segs] of tier) { mapCtx.beginPath(); for (const [i, d] of segs) edgeSubpath(i, d); mapCtx.strokeStyle = color; mapCtx.lineWidth = borderT; mapCtx.stroke(); }
  }
  const sr = Math.round(dotR * 1.63);
  for (const [color, idxs] of stars) { mapCtx.beginPath(); for (const i of idxs) starSubpath(cx(i), cy(i), sr); mapCtx.fillStyle = color; mapCtx.fill(); }
}
function collectTileBorders(i, frame, edges, stars, edgesTop, vis) {
  const v = frame.get(i); if (v === undefined) return;
  const o = (v >> 3) & 63, c = v & 7, meta = ownerMeta(o);
  if (meta.kind === 'village') return;
  const nb = neighborsByIndex[i];
  const suz = (meta.kind === 'citystate' && c === 2 && (v >> 9)) ? (v >> 9) - 1 : -1;
  // Suzerained city-state center: fill with the suzerain's territory color (cellKeyFill) + a full ring in
  // the suzerain's border color (outline). The center DOT (city-state's own type color) is DOM — dotMapFor.
  if (suz >= 0) {
    const col = ownerColors(suz);
    for (let d = 0; d < 6; d++) pushGroup(edges, col.secondaryCss, [i, d]);
    return;
  }
  // City-state rings go in edgesTop (drawn AFTER major borders) so they're never overwritten where a
  // city-state abuts another owner — that overwrite is what left the reported gaps.
  let borderCol, centerDot, targetEdges;
  if (meta.kind === 'citystate') { borderCol = meta.dotType; centerDot = meta.dotType; targetEdges = edgesTop; }
  else { const col = ownerColors(o); borderCol = col.secondaryCss; centerDot = col.primaryCss; targetEdges = edges; }
  // Draw a border on every edge whose neighbor is a DIFFERENT owner (or unowned), in THIS tile's color —
  // one stroke per contested edge, owner-side deterministic: a CONQUERED urban tile (owner ≠ founder at
  // this frame) always draws, so a captured city's whole perimeter rings in the conqueror's color; among
  // equally-(un)conquered sides the HIGHER tile class draws (capital 4 > town 3 > center 2 > district 1 >
  // rural 0; recorder cls codes); full peers both draw (order decides). Majors only: city-state tiles
  // never skip (their edgesTop rings stay complete — the old gap fix). Never yield to a tile that won't
  // draw: villages draw no borders, and fog-hidden neighbors draw nothing.
  const selfConq = c >= 1 && meta.kind !== 'citystate' && conqueredAt(i, o);
  for (let d = 0; d < 6; d++) {
    const ni = nb[d]; if (ni >= 0 && !frame.has(ni)) { pushGroup(targetEdges, borderCol, [i, d]); continue; }
    const nv = ni >= 0 ? frame.get(ni) : undefined;
    const no = nv !== undefined ? ((nv >> 3) & 63) : -1;
    if (no === o) continue;   // same owner → interior edge, no border
    if (meta.kind !== 'citystate' && nv !== undefined && (!vis || vis[ni] !== 0) && ownerMeta(no).kind !== 'village') {
      const nConq = (nv & 7) >= 1 && conqueredAt(ni, no);
      if (nConq && !selfConq) continue;                     // conqueror always draws this edge
      if (nConq === selfConq && (nv & 7) > c) continue;     // tie → higher class draws
    }
    pushGroup(targetEdges, borderCol, [i, d]);
  }
  if (c === 4) pushGroup(stars, centerDot, i);        // major capital: star (city DOTS are DOM — dotMapFor)
}
// --- static background layer -------------------------------------------------
// (Re)draw the bg terrain; clearRect first. Redrawn only on a layout or fog change (ensureBackground
// gates on bgDirty / bgFog), so it stays out of the per-scrub path. Fog OFF: full static terrain. Fog ON:
// a single flat hidden-color fill (visible terrain is painted per position in the state layer, since
// visibility changes each turn).
function renderBackground() {
  if (!bgLayer.ctx || !basePos) return;
  mapCtx = bgLayer.ctx;
  mapCtx.clearRect(0, 0, mapPxW, mapPxH);
  if (fogMode) { mapCtx.fillStyle = FOG_HIDDEN; mapCtx.fillRect(0, 0, mapPxW, mapPxH); }
  else {
    const fills = new Map();
    for (let i = 0; i < basePos.length; i++) { if (terrain && terrain[i] === 0) continue; pushGroup(fills, terrainCss(i), i); }   // deep ocean shows via the canvas backfill
    for (const color of [...fills.keys()].sort()) { const idxs = fills.get(color); mapCtx.beginPath(); for (const i of idxs) hexSubpath(i); mapCtx.fillStyle = color; mapCtx.fill(); mapCtx.lineWidth = 1; mapCtx.strokeStyle = color; mapCtx.stroke(); }
  }
  bgDirty = false; bgFog = fogMode;
}
function ensureBackground() { if (bgDirty || bgFog !== fogMode) renderBackground(); }

// --- change detection ---------------------------------------------------------
// State-layer delta gate: on a SEQUENTIAL advance we can skip the whole state redraw when nothing that
// layer draws changed — read straight off the save's per-turn deltas (no hashing). Skipping leaves the
// canvas as-is (free re-composite) and issues no paint calls.
let lastStatePos = -2, lastStateSig = '', lastSuzeSig = '';
function stateSignature() { return `${showTerritory?1:0}${showBorders?1:0}${showResources?1:0}${showWonders?1:0}${fogMode?1:0}`; }
function suzeSig(t) { const m = readSuzerainTurn(t); if (!m || !m.size) return ''; const a = []; for (const [cs, s] of m) a.push(cs + ':' + s); a.sort(); return a.join(','); }
function stateUnchanged() {
  if (pos !== lastStatePos + 1) return false;              // only when we drew the immediately-previous turn
  const rec = readTurnCached(pos);
  if (!rec || rec.s === 1) return false;                   // snapshot / age boundary → full redraw
  if (rec.terr && rec.terr.length) return false;           // territory (fills + borders) changed
  if (fogMode && rec.vis && rec.vis.length) return false;  // fog visibility changed
  if (stateSignature() !== lastStateSig) return false;     // a layer toggle / fog / age changed
  if (suzeSig(pos) !== lastSuzeSig) return false;          // suzerainty changed (not delta-coded)
  return true;
}
let lastRecordingFp = null;

// --- layer-canvas machinery ------------------------------------------------------------------------
function curStateBoxKey() { return `${mapPxW}x${mapPxH}@${mapDpr}+${mapX},${mapY}`; }
function layerApplyBox(slot) {
  const cv = slot.el;
  cv.width = Math.max(1, Math.round(mapPxW * mapDpr)); cv.height = Math.max(1, Math.round(mapPxH * mapDpr));
  cv.style.left = mapX + 'px'; cv.style.top = mapY + 'px';
  cv.style.width = mapPxW + 'px'; cv.style.height = mapPxH + 'px';
  slot.ctx.setTransform(mapDpr, 0, 0, mapDpr, 0, 0);
  slot.box = curStateBoxKey();
}
function makeAgedSlot(L) {
  const cv = document.createElement('canvas');
  cv.style.cssText = `position:fixed;pointer-events:none;z-index:${L.z};display:none;`;
  document.body.appendChild(cv);
  let ctx = null; try { ctx = cv.getContext('2d'); if (ctx) instrumentCtx(ctx); } catch (e) { err(`${L.id} ctx: ${e}`); }
  return { el: cv, ctx, box: '', painted: false };
}
function agedSlotFor(L, key) {
  let w = L.byAge.get(key);
  if (!w) { w = L.spare.pop() || makeAgedSlot(L); L.byAge.set(key, w); }
  if (w.box !== curStateBoxKey()) { layerApplyBox(w); w.painted = false; }
  return w;
}
function showAgedSlot(L, w) {
  if (L.el && L.el !== w.el) L.el.style.display = 'none';
  L.el = w.el;
}
// Per-age resource canvas: painted once per age (fog OFF only — fog ON draws the vis-gated overlay in the
// state layer; see drawStateLayer).
function drawResAge() {
  const w = agedSlotFor(resLayer, frames[pos][0]);
  showAgedSlot(resLayer, w);
  if (w.painted || !w.ctx) return;
  HB.spaints++;   // HB: wholesale repaints
  mapCtx = w.ctx; mapRoot = bgLayer.el;
  mapCtx.clearRect(0, 0, mapPxW, mapPxH);
  paintResourcesForAge(frames[pos][0]);
  w.painted = true;
}
// Natural-wonder ring subpaths (CW outer + CCW inner hole) for the given tiles; one fill call.
// Ring thickness factor 0.30 (user preference — thicker than the original 0.22).
// NATW_DX: optical horizontal nudge (px) for natural-wonder rings. The triangle is geometrically centered
// on the hex center, but the un-rounded center sat up to 0.5px LEFT of the (rounded) man-made wonders, and
// an upward triangle reads a touch left-heavy; round the center to match man-made + this small right nudge.
function natWonderRings(vis, only) {
  const wr = Math.max(5, Math.round(hexW * 0.32)), yo = Math.round(hexH * 0.07), lw = Math.max(2, Math.round(wr * 0.30));
  const NATW_DX = Math.round(hexW * 0.03);
  let any = false;
  mapCtx.beginPath();
  for (const idx of naturalWonders) {
    if (!basePos[idx] || (vis && vis[idx] === 0)) continue;
    if (only && !only.has(idx)) continue;
    any = true;
    const cx = Math.round(basePos[idx].x + hexW / 2) + NATW_DX, cy = Math.round(basePos[idx].y + hexH / 2 + yo);
    triSubpath(cx, cy, wr);
    triSubpathCCW(cx, cy, wr - lw);
  }
  if (any) { mapCtx.fillStyle = '#101418'; mapCtx.fill(); }
}
// Fog OFF: the one-per-game natural-wonders canvas, painted once per layout.
function drawNatw() {
  const w = agedSlotFor(natwLayer, 0);
  showAgedSlot(natwLayer, w);
  if (w.painted || !w.ctx) return;
  HB.spaints++;   // HB: wholesale repaints
  mapCtx = w.ctx; mapRoot = bgLayer.el;
  mapCtx.clearRect(0, 0, mapPxW, mapPxH);
  natWonderRings(null);
  w.painted = true;
}
function syncLayerDisplays() {
  if (resLayer.el) resLayer.el.style.display = (mapVisible && showResources && !fogMode) ? 'block' : 'none';
  if (natwLayer.el) natwLayer.el.style.display = (mapVisible && showWonders && !fogMode) ? 'block' : 'none';
  if (wonDom.el) wonDom.el.style.display = (mapVisible && showWonders) ? 'block' : 'none';   // display cycles measured free
}
function recycleAllLayers() {   // layout changed / recording changed → per-age/static canvases stale
  for (const L of [resLayer, natwLayer]) {
    for (const [, w] of L.byAge) { w.el.style.display = 'none'; w.box = ''; w.painted = false; L.spare.push(w); }
    L.byAge.clear(); L.el = null;
  }
}
// Redraw the per-turn layers (state then units) over the static background. Background is (re)painted only
// when layout or fog changes, via ensureBackground.
function drawMap(frame) {
  if (!bgLayer.ctx || !stateLayer.ctx || !unitDom.el || !basePos || !frame) return;
  HB.draws++;   // HB counter
  ensureBackground();
  const vis = fogMode ? visForPos() : null;
  drawStateLayer(frame, vis);
  if (showResources && !fogMode && frames.length) drawResAge();
  if (showWonders && !fogMode) drawNatw();
  syncLayerDisplays();
  if (showWonders) drawWonderLayer(frame, vis);
  drawDotLayer(frame, vis);
  drawUnitLayer(frame, vis);
  curFrame = frame;
}
// --- partial state repaint ------------------------------------------------------------------------------
// Color-batched local repaint (user-designed): between the last-drawn position and the target, collect the
// CHANGED tiles from the recorded deltas, clear just those (pad by the border width — strokes straddle
// edges), and repaint only the local subset of each affected color group. Calls ∝ colors touched (~10-20)
// instead of a wholesale ~40-50. Bails to wholesale across snapshots (age identity/color swaps), on big
// change-sets, or when toggles/fog changed since the last draw.
function withNeighbors(S) { const D = new Set(S); for (const i of S) { const nb = neighborsByIndex[i]; if (nb) for (const ni of nb) if (ni >= 0) D.add(ni); } return D; }
// Fog dim is PRE-BLENDED into fill colors (memoized) instead of an alpha overlay: alpha hexes can't be
// seam-stroked (double-darkening), which left thin bright AA lines between dimmed tiles. Blended fills are
// ordinary opaque colors and get the standard fill+stroke seam treatment.
const dimCssCache = new Map();
function cssToRgb(c) {
  if (c.charCodeAt(0) === 35) return hexToRgb(c);
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (!m) return [128, 128, 128];
  const q = m[1].split(',');
  return [+q[0], +q[1], +q[2]];
}
function dimCss(c) { let d = dimCssCache.get(c); if (!d) { d = blendCss(cssToRgb(c), [4, 6, 10], 0.55); dimCssCache.set(c, d); } return d; }
// Tiered fill collection: city-center fills ('C'/'Z' keys) paint AFTER everything else so centers always
// own their shared edges — otherwise neighboring rural seam strokes encroach ~1px and centers look
// smaller with off-center stars/dots (user-observed).
function stateFillPush(i, frame, vis, base, top) {
  if (!basePos[i]) return;
  if (vis) { if (vis[i] === 0) return; }
  else if (terrain && terrain[i] === 0) return;
  const kf = cellKeyFill(i, frame);
  if (!vis && kf.key === 'T') return;   // fog off: unowned/plain-terrain tile is already on the bg layer
  const color = (vis && vis[i] === 1) ? dimCss(kf.fill) : kf.fill;
  const k0 = kf.key.charCodeAt(0);
  pushGroup((k0 === 67 || k0 === 90) ? top : base, color, i);   // 'C'/'Z' = centers → top tier
}
function paintFillTiers(base, top) {
  for (const groups of [base, top]) {
    for (const color of [...groups.keys()].sort()) { const idxs = groups.get(color); mapCtx.beginPath(); for (const i of idxs) hexSubpath(i); mapCtx.fillStyle = color; mapCtx.fill(); mapCtx.lineWidth = 1; mapCtx.strokeStyle = color; mapCtx.stroke(); }
  }
}
// What the canvas currently shows — retained so a partial can DIFF directly against the target frame.
// This works ACROSS AGES too (user insight: territory/border colors follow LEADERS, which persist across
// ages even though civs swap) — guarded by comparing the recorded identity colors between the two
// positions, so the rare genuine color change still falls back to wholesale.
let lastStateFrame = null, lastStateVis = null, lastStateIdent = null;
function noteStateDrawn(frame, vis) { lastStateFrame = frame; lastStateVis = vis; lastStateIdent = identityForPos(); }
function identColorsEqual(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, ea] of a) { const eb = b.get(k); if (!eb || ea[3] !== eb[3] || ea[4] !== eb[4]) return false; }
  return true;
}
function tryPartialState(frame, vis) {
  if (!lastStateFrame || lastStatePos < 0 || lastStatePos === pos) return false;
  if (stateSignature() !== lastStateSig) return false;                        // toggles/fog changed → wholesale
  if (!identColorsEqual(lastStateIdent, identityForPos())) return false;      // an owner's colors changed → wholesale
  const maxT = Math.max(60, basePos.length >> 3);
  const T = new Set();
  for (const [i, v] of frame) { if (lastStateFrame.get(i) !== v) { T.add(i); if (T.size > maxT) return false; } }   // changed/added (suze bits included via frameFor)
  for (const i of lastStateFrame.keys()) { if (!frame.has(i)) { T.add(i); if (T.size > maxT) return false; } }      // removed (tile became unowned)
  if (vis) {
    const lv = lastStateVis;
    if (!lv || lv.length !== vis.length) return false;
    for (let i = 0; i < vis.length; i++) { if (vis[i] !== lv[i]) { T.add(i); if (T.size > maxT) return false; } }
  }
  if (T.size === 0) return true;        // jump across turns where nothing this layer draws changed
  mapCtx = stateLayer.ctx; mapRoot = bgLayer.el;
  HB.walks++;   // HB: partial repaints
  const pad = borderT + 1;
  for (const i of T) { const p = basePos[i]; if (p) mapCtx.clearRect(p.x - pad, p.y - pad, hexW + 2 * pad, hexH + 2 * pad); }
  const R = withNeighbors(T);           // repaint set: changed tiles + fringe-damaged neighbors
  const fillsBase = new Map(), fillsTop = new Map();
  for (const i of R) stateFillPush(i, frame, vis, fillsBase, fillsTop);
  // CENTER tiles just OUTSIDE the repaint set: repaint them too (top tier) so R's seam strokes can't
  // encroach their edges — keeps center hexes full-size at partial boundaries. Centers only: repainting
  // ring-2 rural would merely push the same edge-flip one ring further out.
  for (const i of withNeighbors(R)) {
    if (R.has(i)) continue;
    const v = frame.get(i);
    if (v !== undefined && (v & 7) >= 2) stateFillPush(i, frame, vis, fillsTop, fillsTop);
  }
  paintFillTiers(fillsBase, fillsTop);
  // borders: rings change for tiles whose own/neighbor owner changed, and R's seam strokes clipped the
  // inner stroke halves of the NEXT ring out — redraw complete rings for R ∪ N(R) (idempotent overdraw).
  if (showBorders) {
    const cx = i => basePos[i].x + hexW / 2, cy = i => basePos[i].y + hexH / 2;
    const edges = new Map(), stars = new Map(), edgesTop = new Map();
    for (const i of withNeighbors(R)) { if (vis && vis[i] === 0) continue; collectTileBorders(i, frame, edges, stars, edgesTop, vis); }
    strokeBorderTiers(edges, edgesTop, stars, cx, cy);
  }
  // fog-only extras on the repainted tiles: resource hexes + natural-wonder rings live in this layer
  // when fog is on (fog off keeps them on their own canvases, untouched by these clears).
  if (showResources && vis && frames.length) {
    const res = resourcesForPos(), byColor = new Map();
    for (const i of R) { if (vis[i] === 0) continue; const code = res.get(i); if (code != null) pushGroup(byColor, RESOURCE_COLOR[code] || '#dddddd', i); }
    if (byColor.size) {
      mapCtx.lineJoin = 'round';
      const rw = Math.max(1, Math.round(hexW * 0.06));
      for (const [color, idxs] of byColor) { mapCtx.beginPath(); for (const i of idxs) insetHexSubpath(i, 0.85); mapCtx.strokeStyle = color; mapCtx.lineWidth = rw; mapCtx.stroke(); }
    }
  }
  if (showWonders && vis) natWonderRings(vis, R);
  return true;
}
// State layer: territory fills + fog dim + borders(+capital stars) — and, under fog only, the vis-gated
// resource overlay. Fills — fog ON: draw every VISIBLE tile (bg is flat black, so terrain must be painted
// here); fog OFF: draw only NON-terrain (owned) tiles — plain terrain already lives on the static bg
// layer. City dots, wonders and units are DOM layers above. Seams close with exact hexes + a same-color
// 1px stroke — never overlap subpaths in one path (Cohtml fills are EVEN-ODD; overlap punches holes).
function drawStateLayer(frame, vis) {
  if (stateUnchanged()) { lastStatePos = pos; noteStateDrawn(frame, vis); return; }   // unchanged since last turn → leave the canvas untouched
  if (tryPartialState(frame, vis)) { lastStatePos = pos; lastStateSig = stateSignature(); lastSuzeSig = suzeSig(pos); noteStateDrawn(frame, vis); return; }
  mapCtx = stateLayer.ctx; mapRoot = bgLayer.el;
  mapCtx.clearRect(0, 0, mapPxW, mapPxH);
  HB.spaints++;   // HB: wholesale repaints
  const cx = i => basePos[i].x + hexW / 2, cy = i => basePos[i].y + hexH / 2;
  // Tiered, dim-preblended fills (see stateFillPush): base tier then city centers, each fill + 1px
  // same-color seam stroke; fog dim is baked into the colors, so dimmed tiles seam like any others.
  const fillsBase = new Map(), fillsTop = new Map();
  for (let i = 0; i < basePos.length; i++) stateFillPush(i, frame, vis, fillsBase, fillsTop);
  paintFillTiers(fillsBase, fillsTop);
  // borders + capital stars (city dots are DOM)
  if (showBorders) {
    const edges = new Map(), stars = new Map(), edgesTop = new Map();
    for (const [i] of frame) { if (vis && vis[i] === 0) continue; collectTileBorders(i, frame, edges, stars, edgesTop, vis); }
    strokeBorderTiers(edges, edgesTop, stars, cx, cy);
  }
  // resource overlay under FOG only (vis-gated; fog off uses the per-age resource canvases instead)
  if (showResources && vis && frames.length) {
    const res = resourcesForPos(), byColor = new Map();
    for (const [i, code] of res) { if (!basePos[i] || vis[i] === 0) continue; pushGroup(byColor, RESOURCE_COLOR[code] || '#dddddd', i); }
    if (byColor.size) {
      mapCtx.lineJoin = 'round';
      const rw = Math.max(1, Math.round(hexW * 0.06));
      for (const [color, idxs] of byColor) { mapCtx.beginPath(); for (const i of idxs) insetHexSubpath(i, 0.85); mapCtx.strokeStyle = color; mapCtx.lineWidth = rw; mapCtx.stroke(); }
    }
  }
  // natural-wonder rings under FOG only (vis-gated; the hole shows the state fill painted above)
  if (showWonders && vis) natWonderRings(vis);
  lastStatePos = pos; lastStateSig = stateSignature(); lastSuzeSig = suzeSig(pos);
  noteStateDrawn(frame, vis);
}
// Resource overlay: a thin hollow hex, inset, tinted by class. Constant within an age → one canvas per age.
function paintResourcesForAge(ageId) {
  const res = readResourcesForAge(ageId), byColor = new Map();
  for (const [i, code] of res) { if (!basePos[i]) continue; pushGroup(byColor, RESOURCE_COLOR[code] || '#dddddd', i); }
  if (!byColor.size) return;
  mapCtx.lineJoin = 'round';
  const rw = Math.max(1, Math.round(hexW * 0.06));
  for (const [color, idxs] of byColor) { mapCtx.beginPath(); for (const i of idxs) insetHexSubpath(i, 0.85); mapCtx.strokeStyle = color; mapCtx.lineWidth = rw; mapCtx.stroke(); }
}
// Man-made wonders: DOM triangle markers (CSS border trick — zero-size div, transparent side borders,
// colored bottom border forms an upward triangle). The container sits UNDER the fog-mask canvas, so
// hidden/dimmed states come free. Same pooled-slot pattern as units/dots; recolors (conquest) are rare.
const wonSlots = [];
function resetWonDom() { for (const m of wonSlots) { m.geom = ''; m.x = -1; m.y = -1; m.col = ''; } }
function wonSlotAt(n) {
  let m = wonSlots[n];
  if (!m) {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;pointer-events:none;width:0;height:0;border-style:solid;border-top-width:0;border-left-color:transparent;border-right-color:transparent;';
    wonDom.el.appendChild(el);
    m = { el, op: 1, geom: '', x: -1, y: -1, col: '' };
    wonSlots[n] = m;
  }
  return m;
}
function placeWon(m, geom, wr, h, x, y, col) {
  if (m.geom !== geom) { m.geom = geom; m.el.style.borderLeftWidth = m.el.style.borderRightWidth = wr + 'px'; m.el.style.borderBottomWidth = h + 'px'; }
  if (m.x !== x) { m.el.style.left = x + 'px'; m.x = x; HB.moves++; }
  if (m.y !== y) { m.el.style.top = y + 'px'; m.y = y; HB.moves++; }
  if (m.col !== col) { m.el.style.borderBottomColor = col; m.col = col; HB.marks++; }
  if (!m.op) { m.el.style.opacity = '1'; m.op = 1; HB.mhides++; }
}
function drawWonderLayer(frame, vis) {
  if (!wonDom.el || !frames.length) return;
  const wr = Math.max(5, Math.round(hexW * 0.32)), yo = Math.round(hexH * 0.07), h = Math.round(2 * wr * TRI_RATIO), geom = 'w' + wr;
  let n = 0;
  for (const [idx, e] of wondersForPos()) {
    if (!basePos[idx] || (vis && vis[idx] === 0)) continue;
    const x = Math.round(basePos[idx].x + hexW / 2 - wr), y = Math.round(basePos[idx].y + hexH / 2 + yo - 2 * h / 3);
    placeWon(wonSlotAt(n++), geom, wr, h, x, y, ownerColors(e[0]).secondaryCss);
  }
  for (let s = n; s < wonSlots.length; s++) { const m = wonSlots[s]; if (m && m.op) { m.el.style.opacity = '0'; m.op = 0; } }   // spares: opacity-park
}
// Build this turn's visible unit set → Map(tile -> "ringColor|coreColor").
function unitMapFor(p, vis) {
  const m = new Map();
  if (!(showUnits && frames.length)) return m;
  const seen = new Set();
  for (const [idx, owner] of readUnitsTurn(p)) { if (seen.has(idx)) continue; if (vis && (vis[idx] || 0) !== 2) continue; seen.add(idx); m.set(idx, playerBorderColor(owner) + '|' + unitColor(owner)); }
  return m;
}
// Units layer (top): DOM marker divs in unitDom. A marker is TWO nested divs with plain background-color
// — outer = ring color, inner (inset by bw) = core color. NO border property and NO cssText rewrites
// (borders are generated images; wholesale style rewrites re-register them), and divs are never removed
// or recreated (DOM recreation re-registers static resources — the old leader-ribbon leak). Markers are a
// dense SLOT array: the i-th visible unit uses slot i, so a scrub tick mostly moves divs (left/top) and
// recolors them; per-slot caches skip writes for unchanged properties. Spare slots simply park at
// opacity:0 — hide/show cycling measured FREE at 150k styled-element cycles + 150k canvas cycles
// (harness disp/dispS/cvShow, 2026-07-10), which retired the earlier stacking-park workaround.
const unitSlots = [];      // [{ el, inner, op, geom, x, y, cols }] — cache mirrors the div's inline styles
function parkSlot(m) { if (m.op) { m.el.style.opacity = '0'; m.op = 0; } }
function resetUnitDom() {  // layout changed → drop the per-slot caches; the next draw re-places every marker
  for (const m of unitSlots) { m.geom = ''; m.x = -1; m.y = -1; m.cols = ''; }
}
function unitSlot(n) {
  let m = unitSlots[n];
  if (!m) {
    // Born painted: colors/position are written by the caller in the same pass. The first paint is this
    // element's one static registration (bounded by the peak simultaneous unit count).
    const el = document.createElement('div'), inner = document.createElement('div');
    el.style.cssText = 'position:absolute;pointer-events:none;';
    inner.style.cssText = 'position:absolute;';
    el.appendChild(inner); unitDom.el.appendChild(el);
    m = { el, inner, op: 1, geom: '', x: -1, y: -1, cols: '' };
    unitSlots[n] = m;
  }
  return m;
}
function placeSlot(m, geom, r, bw, x, y, cols) {
  if (m.geom !== geom) {   // size the square once per layout (outer 2r box; inner inset bw on each side)
    m.geom = geom;
    m.el.style.width = m.el.style.height = (2 * r) + 'px';
    m.inner.style.left = m.inner.style.top = bw + 'px';
    m.inner.style.width = m.inner.style.height = Math.max(1, 2 * (r - bw)) + 'px';
  }
  if (m.x !== x) { m.el.style.left = x + 'px'; m.x = x; HB.moves++; }
  if (m.y !== y) { m.el.style.top = y + 'px'; m.y = y; HB.moves++; }
  if (m.cols !== cols) {
    const k = cols.indexOf('|');
    m.el.style.backgroundColor = cols.slice(0, k);
    m.inner.style.backgroundColor = cols.slice(k + 1);
    m.cols = cols;
    HB.marks++;
  }
  if (!m.op) { m.el.style.opacity = '1'; m.op = 1; HB.mhides++; }   // unpark after an n=0 fallback (counted: leak-relevant)
}
function drawUnitLayer(frame, vis) {
  if (!unitDom.el) return;
  const r = Math.max(3, Math.round(hexW * 0.19)), bw = Math.max(2, Math.round(hexW * 0.07)), geom = r + '|' + bw;
  const newMap = unitMapFor(pos, vis);
  let n = 0;
  for (const [i, cols] of newMap) {
    const x = Math.round(basePos[i].x + hexW / 2 - r), y = Math.round(basePos[i].y + hexH / 2 - r);
    placeSlot(unitSlot(n++), geom, r, bw, x, y, cols);
  }
  for (let s = n; s < unitSlots.length; s++) if (unitSlots[s]) parkSlot(unitSlots[s]);   // spares: opacity-park (cycles measured free)
}
// --- city-dot layer (DOM, follows the Borders toggle) --------------------------------------------------
// City-center dots as pooled border-radius divs — the same certified-free slot pattern as the unit
// markers (position/color mutation; spares opacity-parked). Moving dots off the canvas means foundings/
// promotions never invalidate a cached borders canvas.
const dotSlots = [];
function resetDotDom() { for (const m of dotSlots) { m.geom = ''; m.x = -1; m.y = -1; m.col = ''; } }
function dotSlotAt(n) {
  let m = dotSlots[n];
  if (!m) {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;pointer-events:none;border-radius:50%;';
    dotDom.el.appendChild(el);
    m = { el, op: 1, geom: '', x: -1, y: -1, col: '' };
    dotSlots[n] = m;
  }
  return m;
}
// Tile -> dot color for the current frame: c===2 centers only (c===4 capitals get canvas stars); villages
// none; city-states (incl. suzerained) keep their type color; majors use their primary.
function dotMapFor(frame, vis) {
  const m = new Map();
  if (!(showBorders && frames.length)) return m;
  for (const [i, v] of frame) {
    if (!basePos[i]) continue;
    if (vis && vis[i] === 0) continue;
    if ((v & 7) !== 2) continue;
    const o = (v >> 3) & 63, meta = ownerMeta(o);
    if (meta.kind === 'village') continue;
    m.set(i, meta.kind === 'citystate' ? meta.dotType : ownerColors(o).primaryCss);
  }
  return m;
}
function placeDot(m, geom, r, x, y, col) {
  if (m.geom !== geom) { m.geom = geom; m.el.style.width = m.el.style.height = (2 * r) + 'px'; }
  if (m.x !== x) { m.el.style.left = x + 'px'; m.x = x; HB.moves++; }
  if (m.y !== y) { m.el.style.top = y + 'px'; m.y = y; HB.moves++; }
  if (m.col !== col) { m.el.style.backgroundColor = col; m.col = col; HB.marks++; }
  if (!m.op) { m.el.style.opacity = '1'; m.op = 1; HB.mhides++; }
}
function drawDotLayer(frame, vis) {
  if (!dotDom.el) return;
  const r = dotR, geom = 'd' + r;
  const newMap = dotMapFor(frame, vis);
  let n = 0;
  for (const [i, col] of newMap) {
    const x = Math.round(basePos[i].x + hexW / 2 - r), y = Math.round(basePos[i].y + hexH / 2 - r);
    placeDot(dotSlotAt(n++), geom, r, x, y, col);
  }
  for (let s = n; s < dotSlots.length; s++) { const m = dotSlots[s]; if (m && m.op) { m.el.style.opacity = '0'; m.op = 0; } }   // spares: opacity-park
}
function redraw() { if (curFrame) drawMap(curFrame); }
function terrainRgbArr(i) { return TERRAIN_RGB[(terrain && terrain[i] != null) ? terrain[i] : 8] || TERRAIN_RGB[8]; }
function terrainCss(i) { return rgbCss(terrainRgbArr(i)); }
function isWaterTile(i) { const t = terrain ? terrain[i] : 8; return t === 0 || t === 1 || t === 9 || t === 10; }   // deep ocean / coast / lake / navigable river

// Reset render state on a geometry change. The canvases are redrawn wholesale; the unit-marker divs are
// hidden into their pool (never removed) and re-placed on the next draw.
// cellByIndex is repurposed as a truthy "layout ready" sentinel (kept so existing checks still work).
function allocCells() {
  cellByIndex = basePos; curFrame = null; prebuilt = false; building = false; buildToken++;
  markBgDirty();                                                        // new geometry → repaint the static bg
  for (const L of LAYERS) if (L.ctx) L.ctx.clearRect(0, 0, mapPxW, mapPxH);
  lastStatePos = -2; lastStateSig = ''; lastSuzeSig = ''; lastStateFrame = null;   // force a full state repaint on the new layout
  recycleAllLayers();                                                  // new geometry → per-age canvases stale
  resetUnitDom(); resetDotDom(); resetWonDom();
  ribbonRows.clear(); ribbonSigLast = null;                           // drop reused ribbon rows so they rebuild at the new scale
  if (els.ribbon) els.ribbon.innerHTML = '';
  log(`allocCells: ${basePos ? basePos.length : 0} tiles (canvas)`);
}

// --- per-cell fill -----------------------------------------------------------
function cellKeyFill(i, frame) {
  const v = frame.get(i);
  let key, fill = null;
  if (v !== undefined && showTerritory) {   // territory off → owned tiles render as plain terrain
    const o = (v >> 3) & 63, c = v & 7, kind = ownerMeta(o).kind;
    if (kind === 'village') key = 'T';                                          // goodie hut: plain terrain
    else if (kind === 'citystate') {
      const suz = (c === 2 && (v >> 9)) ? (v >> 9) - 1 : -1;
      if (suz >= 0) { key = 'Z' + suz; fill = ownerColors(suz).primaryCss; }   // suzerained center → suzerain's territory fill
      else key = isWaterTile(i) ? 'T' : 'W';                                    // rest of city-state: white on land
    }
    else { const col = ownerColors(o);
      if (c >= 2) { key = 'C' + o; fill = col.secondaryCss; }                   // center: solid secondary
      else if (isWaterTile(i)) key = 'T';                                       // owned water: no tint
      else { key = 'F' + o; fill = col.primaryCss; } }                          // rural + non-center urban: solid primary
  } else key = 'T';                                                             // unowned: terrain
  if (key === 'T') fill = terrainCss(i);
  else if (key === 'W') fill = '#ffffff';
  return { key, fill };
}
// --- frame render (canvas) ---------------------------------------------------
function fullRender(frame) { drawMap(frame); }   // a "full render" is now one canvas draw
// Kept async so requestShow never blocks the tab click: draw on the next frame, then finalize/reveal.
function buildChunked(frame) {
  if (!mapCtx || !frame) return;
  const myToken = ++buildToken; building = true;
  const finish = () => {
    if (myToken !== buildToken) return;            // superseded by a newer build / layout change
    drawMap(frame);
    building = false; prebuilt = true; builtFrameCount = recordedFrameCount();   // remember which recording state this build covers
    if (revealWhenBuilt) { revealWhenBuilt = false; reveal(); hideLoading(); }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish); else finish();
}
function renderFrame(frame) { drawMap(frame); }
function repaintCells() { redraw(); }         // Territory toggle → one canvas redraw
function rebuildAllOverlays() { redraw(); }   // Borders toggle → one canvas redraw

// --- units layer (toggleable) — DOM marker divs, placed by drawUnitLayer; colors below ----------------
let showUnits = true;
function unitColor(owner) {
  const meta = ownerMeta(owner);
  if (meta.kind === 'citystate') return '#ffffff';   // independent powers: white interior (ring is the type color)
  if (meta.kind === 'village') return '#e23b3b';     // barbarian red
  return ownerColors(owner).primaryCss;
}
// the player's territory-border color (matches buildTileOverlays): secondary for majors, type color
// for city-states, a dark red for barbarians (which have no real territory border).
function playerBorderColor(owner) {
  const meta = ownerMeta(owner);
  if (meta.kind === 'citystate') return meta.dotType;
  if (meta.kind === 'village') return '#5a1010';
  return ownerColors(owner).secondaryCss;
}
function renderUnits() { redraw(); }   // toggling Units → one redraw (drawUnitLayer diffs the marker divs)

// --- wonders layer (toggleable) — drawn on the canvas in drawMap (man-made = solid triangle in the
// owner's secondary color; natural = dark triangle + inner tile-color triangle → a hollow ring). --------
let showWonders = true;
let naturalWonders = [];
const TRI_RATIO = 0.866;   // sqrt(3)/2 → equilateral (used by fillTriC)
function renderWonders() { redraw(); }

// --- controller --------------------------------------------------------------
// frames[gi] = [ageId, inAgeTurn, snap]; gi (the array index) is the global timeline position AND the
// storage key for every per-frame record. Ages are contiguous runs of frames.
let manifest = null, frames = [], pos = 0, playing = false, timer = null;
let lastOpenTurn = -1;   // the game turn the map was last auto-positioned for (see applyOpenPosition)
let prebuilt = false;   // map already built (possibly hidden) and valid for the current layout
let builtFrameCount = ''; // count + manifest rev the built/prebuilt map represents — so we can detect BOTH new frames and same-turn re-records (mid-turn record-on-open)
// Cheap peek straight from the manifest (no state mutation), used to decide whether a prebuilt map is stale.
function recordedFrameCount() {
  try { const m = readManifest(); return ((m && Array.isArray(m.frames)) ? m.frames.length : 0) + '@' + ((m && m.rev != null) ? m.rev : 0); } catch (e) { return '0@0'; }
}
function refresh() {
  manifest = readManifest();
  // Cross-open retention: only reset the derived state (record caches, per-age canvases, state gate,
  // conquest table) when the RECORDING actually changed — new game, new age, or new turns recorded. Same
  // fingerprint → reopening the map reuses every cached canvas.
  const framesNow = (manifest && Array.isArray(manifest.frames)) ? manifest.frames : [];
  const fp = `${manifest && manifest.rev != null ? manifest.rev : 0}|${framesNow.length}|${manifest ? manifest.w + 'x' + manifest.h : ''}|${framesNow.length ? framesNow[0][0] + ':' + framesNow[0][1] + '>' + framesNow[framesNow.length - 1][0] + ':' + framesNow[framesNow.length - 1][1] : ''}`;
  const recordingChanged = fp !== lastRecordingFp;
  lastRecordingFp = fp;
  if (recordingChanged) {
    turnCache.clear(); unitsCache.clear(); suzeCache.clear(); playersCache.clear(); ownerColorCache.clear(); resCache.clear(); curBuildingsPos = -2; curSettlementsPos = -2; curVisPos = -2; curIdentityPos = -2; curRelPos = -2; curWondersPos = -2; ribbonSigLast = null;   // records re-read fresh (cheap; cleared for new-game safety)
    recycleAllLayers(); lastStatePos = -2; lastStateSig = ''; lastSuzeSig = ''; lastStateFrame = null; conquestEpisodes = null;   // per-age canvases + state gate + conquest table hold frame-derived content → same new-game safety
  }
  frames = framesNow;   // already in chronological (gi) order
  if (pos >= frames.length) pos = Math.max(0, frames.length - 1);
  if (manifest) {
    // Re-layout when the map dims OR the available area change (e.g. in-game launcher vs Victories tab,
    // or a different resolution/aspect). Keep curFrame/prebuilt when the layout is unchanged so a
    // prebuilt (or previously opened) map can be revealed instantly instead of rebuilt.
    const area = measureArea();
    const key = `${manifest.w}x${manifest.h}|${area.key}`;
    if (key !== layoutDims || !cellByIndex) { try { computeLayout(manifest.w, manifest.h, area); terrain = readTerrain(); naturalWonders = readNatural(); allocCells(); layoutDims = key; curFrame = null; prebuilt = false; } catch (e) { err(`layout/build: ${e}`); } }
  }
  buildAgeBar();       // rebuild age sections for the (possibly new) frame count
  updateControls();   // refresh the timeline fill for the new frame count
}
function layoutStillValid() {
  if (!manifest || !cellByIndex) return false;
  try { const area = measureArea(); return layoutDims === `${manifest.w}x${manifest.h}|${area.key}`; } catch (e) { return false; }
}
function goToIndex(i) {
  if (!frames.length || !cellByIndex) return;
  pos = Math.max(0, Math.min(frames.length - 1, i));
  drawMap(frameFor(pos));
  updateControls();
  updateRibbon();
}
function stopTimer() { if (timer) { clearTimeout(timer); timer = null; } }
// Self-correcting scheduler: draw one turn, then schedule the next so the START-to-START interval tracks the
// target. Subtract the work we just did; floor at MIN_TURN_MS so a heavy turn runs closer to back-to-back
// (playback slows) instead of ever skipping a turn.
function playTick() {
  timer = null;
  if (!playing) return;
  if (pos >= frames.length - 1) { pause(); return; }
  const t0 = nowMs();
  goToIndex(pos + 1);
  if (!playing) return;                                  // pause() may have fired during the draw
  const delay = Math.max(MIN_TURN_MS, PLAY_SPEEDS[speedIdx] - (nowMs() - t0));
  timer = setTimeout(playTick, delay);
}
function startTimer() { stopTimer(); timer = setTimeout(playTick, PLAY_SPEEDS[speedIdx]); }
function play() { if (playing || !frames.length) return; if (pos >= frames.length - 1) pos = 0; playing = true; updateControls(); goToIndex(pos); startTimer(); }
function pause() { playing = false; stopTimer(); updateControls(); }
function cycleSpeed() { speedIdx = (speedIdx + 1) % PLAY_SPEEDS.length; if (els.speedBtn) els.speedBtn.setAttribute('caption', PLAY_SPEED_LABELS[speedIdx]); if (playing) startTimer(); }

// --- DOM UI ------------------------------------------------------------------
const els = {};
// timeline scrubbing: mouse drag on a div track (mirrors fxs-slider; native range fails in Gameface)
let seeking = false;
function trackFrac(clientX) {
  if (!els.track) return 0;
  const r = els.track.getBoundingClientRect();
  if (!r || r.width <= 0) return 0;
  return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
}
function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
// rAF-paced COALESCING for drag scrubbing: always render the LATEST cursor position on the next animation
// frame, and only arm the next render once the current one has run — so the rate self-limits to whatever
// THIS machine + map can draw (fast hardware → ~display refresh; slow/large → fewer frames, coalescing the
// rest). No fixed ms floor. NOTE: the static-resource leak that once capped hard scrubbing (see the KNOWN
// ISSUE at the canvas-draw section) came from the unit canvas, since replaced by DOM markers; the remaining
// per-scrub draws are the batched state-layer fills, which measured ~leak-free.
let seekPending = false, seekTargetX = 0, seekLastGi = -1;
function renderSeekTarget() {
  if (!frames.length) return;
  const gi = Math.round(trackFrac(seekTargetX) * (frames.length - 1));
  if (gi !== seekLastGi) { seekLastGi = gi; goToIndex(gi); }   // skip if the cursor stayed within the same turn
}
function scheduleSeek(clientX) {
  seekTargetX = clientX;
  if (seekPending) return;             // a render is already queued for the next frame; it'll pick up the latest x
  seekPending = true;
  const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  raf(() => { seekPending = false; renderSeekTarget(); });
}
function onSeekStart(e) { seeking = true; pause(); seekLastGi = -1; scheduleSeek(e.clientX); if (e.preventDefault) e.preventDefault(); }
function onSeekMove(e) { if (seeking) scheduleSeek(e.clientX); }
function onSeekEnd(e) { if (!seeking) return; seeking = false; seekTargetX = e.clientX; renderSeekTarget(); }   // settle on the final frame (ribbon icons already updated live during the drag)
// Scrubber hover tooltip: instead of an always-on counter, the turn-pill (els.label) shows the turn at the
// cursor's position on the track — a video-style scrub preview. Updated ONLY when the previewed frame
// changes (not on every pixel of movement) so it isn't churning the DOM/retained resources while scrubbing;
// it snaps to that frame's position on the track and sits just above it (the pill's transform centers+lifts).
let lastHoverGi = -2;
function onTrackHover(e) {
  if (!els.label || !els.track || !frames.length) return;
  const gi = Math.round(trackFrac(e.clientX) * (frames.length - 1));
  if (gi === lastHoverGi && els.label.style.display === 'block') return;
  lastHoverGi = gi;
  const f = frames[gi];
  els.label.textContent = f ? `Turn ${f[1]} (${gi + 1}/${frames.length})` : '';
  const r = els.track.getBoundingClientRect();
  els.label.style.left = (r.left + (frames.length > 1 ? gi / (frames.length - 1) : 0) * r.width) + 'px';
  els.label.style.top = (r.top - ps(6)) + 'px';
  els.label.style.display = 'block';
}
function onTrackLeave() { lastHoverGi = -2; if (els.label) els.label.style.display = 'none'; }

// --- hover tooltips ----------------------------------------------------------
// The unit-marker container (unitDom) is pointer-events:auto (so it's the cursor target over the map and
// suppresses the live-map plot tooltip). On mouse-move we find the hovered hex and render OUR OWN tooltip
// div (see onMapHover).
// Names are resolved live (owner id → player config), so no recorded data / version bump is needed.
function playerName(id) {
  try {
    // Prefer the recorded identity for this frame (age-correct civ); the fields are already composed.
    const id2 = identityForPos().get(id);
    if (id2 && (id2[0] || id2[1])) { const leader = id2[0] || '', civ = id2[1] || ''; return (leader && civ) ? `${leader} — ${civ}` : (leader || civ); }
    const cfg = (typeof Configuration !== 'undefined' && Configuration.getPlayer) ? Configuration.getPlayer(id) : null;
    const L = (s) => (s && typeof Locale !== 'undefined' && Locale.compose) ? Locale.compose(s) : (s || '');
    const leader = cfg ? L(cfg.leaderName) : '';
    const civ = cfg ? L(cfg.civilizationFullName || cfg.civilizationName) : '';
    if (leader && civ) return `${leader} — ${civ}`;
    return leader || civ || `Player ${id}`;
  } catch (e) { return `Player ${id}`; }
}
// Reverse the layout: cursor (client px) → plot index, or -1 if off-map. Checks the 3×3 candidate cells
// around the approximate col/row and picks the nearest hex center (fast; no full scan).
function hexAt(clientX, clientY) {
  if (!basePos || !idxByCR || !layoutW) return -1;
  const px = clientX - mapX, py = clientY - mapY;
  if (px < 0 || py < 0 || px > mapPxW || py > mapPxH) return -1;
  const rApprox = maxRow - py / rowStep;
  let best = -1, bestD = Infinity;
  for (let dr = -1; dr <= 1; dr++) {
    const r = Math.round(rApprox) + dr; if (r < 0 || r > maxRow) continue;
    const cApprox = (px - ((r & 1) ? hexW / 2 : 0)) / hexW;
    for (let dc = -1; dc <= 1; dc++) {
      let c = (Math.round(cApprox) + dc) % layoutW; c = (c + layoutW) % layoutW;
      const idx = idxByCR[r * layoutW + c]; if (idx < 0) continue;
      const p = basePos[idx], ex = px - (p.x + hexW / 2), ey = py - (p.y + hexH / 2), d = ex * ex + ey * ey;
      if (d < bestD) { bestD = d; best = idx; }
    }
  }
  const rad = hexW * 0.58;
  return (best >= 0 && bestD <= rad * rad) ? best : -1;
}
// Civilization adjective/demonym for a player (e.g. "Egyptian"), resolved live. civilizationAdjective
// lives on the Players object (not the Configuration player); fall back to the civ name if absent.
function civAdjective(id) {
  try {
    const id2 = identityForPos().get(id);   // recorded, age-correct adjective (already composed)
    if (id2 && id2[2]) return id2[2];
    const L = (s) => (s && typeof Locale !== 'undefined' && Locale.compose) ? Locale.compose(s) : (s || '');
    const p = (typeof Players !== 'undefined' && Players.get) ? Players.get(id) : null;
    if (p && p.civilizationAdjective) return L(p.civilizationAdjective);
    const cfg = (typeof Configuration !== 'undefined' && Configuration.getPlayer) ? Configuration.getPlayer(id) : null;
    if (cfg && (cfg.civilizationName || cfg.civilizationFullName)) return L(cfg.civilizationName || cfg.civilizationFullName);
    return `Player ${id}`;
  } catch (e) { return `Player ${id}`; }
}
// City-state / independent display name (e.g. "Carthage"). The RECORDED identity wins — a city-state
// dispersed/absorbed before the viewed frame has no live Players entry (its tooltip used to degrade to
// the bare "City-State" fallback while its units line still named it) — then live engine, then fallback.
function cityStateName(id) {
  try {
    const id2 = identityForPos().get(id);   // recorded [leader, civ, adj, ...] — composed at record time
    if (id2 && id2[1] && !/^LOC_/.test(id2[1])) return id2[1];
    const L = (s) => (s && typeof Locale !== 'undefined' && Locale.compose) ? Locale.compose(s) : (s || '');
    const p = (typeof Players !== 'undefined' && Players.get) ? Players.get(id) : null;
    const n = p && p.civilizationFullName ? L(p.civilizationFullName) : '';
    return (n && !/^LOC_/.test(n)) ? n : 'City-State';   // guard against an unresolved loc key
  } catch (e) { return 'City-State'; }
}
// Unit category labels by code (recorder: 0 military, 1 naval, 2 civilian, 3 air) — used only as a
// fallback if a unit type's name failed to resolve at record time.
const UNIT_CAT_LABEL = ['military', 'naval', 'civilian', 'air'];
// Exact unit name for a recorded type index, from the manifest's type table [hash, name, category].
function unitTypeName(idx) {
  const t = manifest && Array.isArray(manifest.unitTypes) ? manifest.unitTypes[idx] : null;
  if (!t) return 'Unit';
  return t[1] || UNIT_CAT_LABEL[t[2]] || 'Unit';
}
// Units on a tile → one line per owner: "<adjective> [count× ]Name, …" (e.g. "Egyptian 2× Warrior, Scout").
function unitsLinesForHex(i) {
  if (!frames.length) return [];
  const byOwner = new Map();   // owner -> Map(unitName -> count)
  for (const u of readUnitsTurn(pos)) {
    if (u[0] !== i) continue;
    const name = unitTypeName(u[2]);
    let m = byOwner.get(u[1]); if (!m) { m = new Map(); byOwner.set(u[1], m); }
    m.set(name, (m.get(name) || 0) + 1);
  }
  const lines = [];
  for (const [owner, counts] of byOwner) {
    const parts = [];
    for (const [name, n] of counts) parts.push(n > 1 ? `${n}× ${name}` : name);
    if (parts.length) lines.push(`${civAdjective(owner)} ${parts.join(', ')}`);
  }
  return lines;
}
function L(s) { return (s && typeof Locale !== 'undefined' && Locale.compose) ? Locale.compose(s) : (s || ''); }
// Constructibles on a tile → { buildings, improvement } lines ('' if none): "Buildings: …" (incl.
// fortifications) and "Improvement: …". Kept separate so the resource line can sit between them.
function buildingsLinesForHex(i) {
  const arr = buildingsForPos().get(i); if (!arr || !arr.length) return { buildings: '', improvement: '' };
  const table = (manifest && Array.isArray(manifest.buildingTypes)) ? manifest.buildingTypes : null;
  const buildings = [], improvements = [];
  for (const ti of arr) { const e = table ? table[ti] : null; if (!e) continue; (e[2] === 1 ? improvements : buildings).push(e[1] || 'Constructible'); }
  return {
    buildings: buildings.length ? 'Buildings: ' + buildings.join(', ') : '',
    improvement: improvements.length ? 'Improvement: ' + improvements.join(', ') : '',
  };
}
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// Settlement (major city/town) line: "**Name (pop), Type**" (whole line bold) for the settlement's CENTER
// tile, else ''. The entire string goes in ONE <b> — Gameface renders <b> as a block, so a partial bold
// would push the rest (", Type") onto its own line; wrapping it all keeps it one bold line. Returns
// RAW_MARK-flagged HTML so the bold tags survive tipHtml (dynamic parts escaped).
function settlementLineForHex(i) {
  try {
    if (!frames.length) return '';
    const s = settlementsForPos().get(i); if (!s) return '';   // [name, pop, type, yields]
    const name = s[0] || 'Settlement', type = s[2] || '';
    const body = `${escHtml(name)} (${s[1] | 0})` + (type ? `, ${escHtml(type)}` : '');
    return RAW_MARK + `<b>${body}</b>`;
  } catch (e) { return ''; }
}
// Recorded per-settlement yields (same fixed order as the recorder's YIELD_KEYS). Rendered as inline
// yield font-icons + value via Locale.stylize (e.g. "🍞3 ⚙5 💰4 …"); zero yields are skipped to stay
// compact. Returns STYLIZED HTML (already contains markup) → the caller flags it raw so tipHtml won't
// escape it.
const YIELD_ICONS = ['YIELD_FOOD', 'YIELD_PRODUCTION', 'YIELD_GOLD', 'YIELD_SCIENCE', 'YIELD_CULTURE', 'YIELD_HAPPINESS', 'YIELD_DIPLOMACY'];
function yieldsLineForHex(i) {
  try {
    if (!frames.length) return '';
    const s = settlementsForPos().get(i); if (!s) return '';
    const y = s[3]; if (!Array.isArray(y) || !y.length) return '';
    const parts = [];
    for (let k = 0; k < y.length && k < YIELD_ICONS.length; k++) { if (!y[k]) continue; parts.push(`[icon:${YIELD_ICONS[k]}]${y[k]}`); }
    if (!parts.length) return '';
    return (typeof Locale !== 'undefined' && Locale.stylize) ? Locale.stylize(parts.join(' ')) : '';
  } catch (e) { return ''; }
}
// Man-made wonder name (baked in at record time via the wonder-type table), or ''.
function manMadeWonderName(i) {
  try {
    if (!frames.length) return '';
    const e = wondersForPos().get(i); if (e) return wonderNameByIdx(e[1]) || '';
  } catch (e) {}
  return '';
}
// Natural wonder name — resolved live from the (static) map feature at the plot, or ''.
function naturalWonderName(i) {
  try {
    const loc = GameplayMap.getLocationFromIndex(i);
    if (!GameplayMap.isNaturalWonder(loc.x, loc.y)) return '';
    const d = GameInfo.Features.lookup(GameplayMap.getFeatureType(loc.x, loc.y));
    return d && d.Name ? L(d.Name) : '';
  } catch (e) { return ''; }
}
function wonderNameForHex(i) { return manMadeWonderName(i) || naturalWonderName(i); }
// Resource name at a plot — resolved live from the (static) map, or ''.
function resourceNameForHex(i) {
  try {
    const loc = GameplayMap.getLocationFromIndex(i);
    const rt = GameplayMap.getResourceType(loc.x, loc.y);
    if (rt == null || (typeof ResourceTypes !== 'undefined' && rt === ResourceTypes.NO_RESOURCE)) return '';
    const def = GameInfo.Resources.lookup(rt);
    return def && def.Name ? L(def.Name) : '';
  } catch (e) { return ''; }
}
// Tooltip text for a hex ('' = none). Top: settlement (name/pop/type) + wonder name (where present),
// then territory owner (major leader/civ; city-state name + suzerain), then a line per unit-owner.
function tooltipForHex(i) {
  if (!curFrame) return '';
  // Fog gating: hidden tile → no tooltip at all; revealed-but-unseen → keep terrain/settlement/owner but
  // hide the units line (don't leak positions the map itself is hiding). In-LOS → full tooltip.
  let fogHideUnits = false;
  if (fogMode) { const vis = visForPos(); const st = (vis && i < vis.length) ? (vis[i] || 0) : 0; if (st === 0) return ''; fogHideUnits = st !== 2; }
  const lines = [];
  const settle = settlementLineForHex(i); if (settle) lines.push(settle);
  const wonder = wonderNameForHex(i); if (wonder) lines.push(wonder);
  const v = curFrame.get(i);
  if (v !== undefined) {
    const owner = (v >> 3) & 63, meta = ownerMeta(owner);
    if (meta.kind === 'major') {
      lines.push(playerName(owner));
      const yl = yieldsLineForHex(i); if (yl) lines.push(RAW_MARK + yl);   // yields line, directly under the owner name
    }
    else if (meta.kind === 'citystate') {
      const csName = meta.typeLabel ? `${cityStateName(owner)} (${meta.typeLabel})` : cityStateName(owner);
      lines.push(RAW_MARK + `<b>${escHtml(csName)}</b>`);   // top line: name (type), bold like settlements
      const suz = frames.length ? readSuzerainTurn(pos).get(owner) : null;
      lines.push((suz != null && suz >= 0) ? `Suzerain: ${playerName(suz)}` : 'Suzerain: None');
    }
  }
  const cons = buildingsLinesForHex(i);
  if (cons.buildings) lines.push(cons.buildings);
  const res = resourceNameForHex(i); if (res) lines.push('Resource: ' + res);   // just above the improvement that works it
  if (cons.improvement) lines.push(cons.improvement);
  if (!fogHideUnits) for (const ul of unitsLinesForHex(i)) lines.push(ul);
  return lines.join('[N]');
}
// We render OUR OWN tooltip rather than the game's: the native controller keys on the element under the
// cursor, so with our single canvas it caches content and add/remove of data-tooltip-content flashes it
// hide/show. Our div updates content IN PLACE (no flash) and follows the cursor, styled to look native.
function ensureTip() {
  if (!els.tip) {
    els.tip = document.createElement('div'); els.tip.className = 'font-body';
    // font-size matches the native tooltip (rem, so it scales with the game's UI, not our px scale).
    els.tip.style.cssText = `position:fixed;z-index:2000005;pointer-events:none;display:none;max-width:${ps(320)}px;padding:${ps(5)}px ${ps(9)}px;background:rgba(16,22,34,0.95);border:${ps(1)}px solid #6a88bb;border-radius:${ps(6)}px;color:#eef3fb;font-size:calc(1rem - 0.111rem);line-height:1.35;white-space:normal;box-shadow:0 ${ps(2)}px ${ps(10)}px rgba(0,0,0,0.55);`;
    document.body.appendChild(els.tip);
  }
  return els.tip;
}
// Lines prefixed with RAW_MARK are already stylized HTML (e.g. the yields line's icon markup) and must
// bypass escaping; all other lines are plain text and get HTML-escaped.
const RAW_MARK = '';
function tipHtml(text) {   // one <div> per line (robust newlines in Coherent)
  return text.split('[N]').map((s) => s.charCodeAt(0) === 1 ? `<div>${s.slice(1)}</div>` : `<div>${escHtml(s)}</div>`).join('');
}
function positionTip(tip, e) {   // follow the cursor, clamped to the viewport
  const off = ps(16), vw = (window.innerWidth || 1920), vh = (window.innerHeight || 1080), r = tip.getBoundingClientRect();
  let x = e.clientX + off, y = e.clientY + off;
  if (x + r.width > vw) x = e.clientX - off - r.width;
  if (y + r.height > vh) y = e.clientY - off - r.height;
  tip.style.left = Math.max(0, x) + 'px'; tip.style.top = Math.max(0, y) + 'px';
}
// Instantaneous tooltip (the 100ms hover-intent delay was removed once instrumentation exonerated the
// tooltip from the static-resource leak — tips measured 0-16/session while crashes raged elsewhere).
// Content is rebuilt only when the hovered target changes; within a target the tip just follows the cursor.
let ribbonHoverPid = null;
let lastHoverIdx = -2, lastTipText = '';
function hideTip() { if (lastHoverIdx !== -2 || lastTipText) { lastHoverIdx = -2; lastTipText = ''; if (els.tip) els.tip.style.display = 'none'; } }
function onMapHover(e) {
  if (!mapVisible || !mapRoot) return;
  const x = e.clientX, y = e.clientY;
  // 1) Leader-ribbon hover takes precedence: show leader/civ + victory points, and swap other leaders'
  // civ icons for their relationship-to-the-hovered-leader icons.
  if (showLeaders) {
    const row = ribbonRowAtPoint(x, y);
    if (row) {
      if (row.__pid !== ribbonHoverPid) { ribbonHoverPid = row.__pid; applyRelationshipIcons(ribbonHoverPid); }
      lastHoverIdx = -2;   // force a map-tip refresh when the cursor moves back onto the map
      const text = ribbonTipText(row.__pid), tip = ensureTip();
      if (text) { tip.innerHTML = tipHtml(text); lastTipText = text; tip.style.display = 'block'; positionTip(tip, e); HB.tips++; }
      else { lastTipText = ''; tip.style.display = 'none'; }
      return;
    }
  }
  if (ribbonHoverPid != null) { ribbonHoverPid = null; clearRelationshipIcons(); }   // left the ribbon → restore civ icons
  // 2) Fog checkbox is disabled in multiplayer: show the lock reason via OUR tooltip (z 2000005), which
  // renders ABOVE the map/scrub layers — the game's native data-tooltip-content sits behind them, so only
  // the text spilling past the map edge showed. Checked before the panel-suppress below since the fog
  // control lives inside the panel.
  if (fogLocked && els.fogToggleWrap && pointInRect(x, y, els.fogToggleWrap.getBoundingClientRect())) {
    const tip = ensureTip();
    if (lastTipText !== FOG_LOCK_TIP) { tip.innerHTML = tipHtml(FOG_LOCK_TIP); lastTipText = FOG_LOCK_TIP; lastHoverIdx = -2; HB.tips++; }
    tip.style.display = 'block'; positionTip(tip, e);
    return;
  }
  // 3) The scrubber panel overlaps the top edge of the map; suppress the map tooltip when over it (hexAt
  // is coordinate-based and would otherwise show the tile hidden beneath the panel).
  if (els.panel && els.panel.style.display !== 'none' && pointInRect(x, y, els.panel.getBoundingClientRect())) { hideTip(); return; }
  // 3) Map tooltip for the hovered tile.
  const idx = hexAt(x, y);
  if (idx !== lastHoverIdx) {   // hex changed → update content in place (no hide/show)
    lastHoverIdx = idx;
    lastTipText = idx >= 0 ? tooltipForHex(idx) : '';
    if (lastTipText) { ensureTip().innerHTML = tipHtml(lastTipText); HB.tips++; }   // HB counter
    else if (els.tip) els.tip.style.display = 'none';
  }
  if (!lastTipText) return;
  const tip = ensureTip(); tip.style.display = 'block';
  positionTip(tip, e);
}
function clearHover() { lastHoverIdx = -2; lastTipText = ''; ribbonHoverPid = null; try { if (els.tip) els.tip.style.display = 'none'; } catch (e) {} }
try { window.addEventListener('mousemove', onSeekMove); window.addEventListener('mouseup', onSeekEnd); window.addEventListener('mousemove', onMapHover); } catch (e) {}
// Reverted to native Civ components per request (the plain-div experiment didn't fix the lag, which
// points at low framerate / render throughput rather than the fxs hover reflow).
// The button's decorative frame is a border-image on the INNER .fxs-button__bg element (border-image-width/
// outset authored in rem), which an inline style on the host can't reach — so inject one scoped rule
// restating it in ps() px, kept proportional to the px box. Re-set each build so it tracks the resolution.
function ensureChromeStyle() {
  if (!UNIFY_PS_CHROME) return;
  let st = document.getElementById('rewind-chrome-style');
  if (!st) { st = document.createElement('style'); st.id = 'rewind-chrome-style'; document.head.appendChild(st); }
  st.textContent = `.rewind-fxsbtn .fxs-button__bg { border-image-width: ${ps(BTN_FRAME_V)}px ${ps(BTN_FRAME_H)}px !important; border-image-outset: ${ps(BTN_OUT_V)}px ${ps(BTN_OUT_H)}px !important; }`;
}
function mkFxsBtn(caption, onClick) {
  const b = document.createElement('fxs-button');
  b.setAttribute('caption', caption);
  b.classList.add('mx-1');
  // fxs-button ships with px-4 (1rem each side) and no min-width, so short captions (◀ ▶ 1x…) leave the
  // button mostly padding. Inline styles override the utility class → tighten to fit the text. Also pin a
  // FIXED height so every button is the same height regardless of its glyph.
  b.style.boxSizing = 'border-box';
  b.style.paddingLeft = ps(8) + 'px'; b.style.paddingRight = ps(8) + 'px';
  b.style.paddingTop = b.style.paddingBottom = '0';
  // Uniform frame height. The frame is a border-image (default.css .fxs-button__bg): border-image-width is
  // 1.3333rem top/bottom, 2.7777rem left/right. When a button is narrower than left+right (2*2.7777 =
  // 5.5555rem) — e.g. the single-triangle ◀ ▶ captions — Coherent shrinks the WHOLE border-image, height
  // included, so those frames render shorter. So pin a min-width past that threshold and a height past the
  // vertical border-image (2*1.3333 = 2.6666rem). A fixed line-height LENGTH (not the font-dependent unitless
  // `leading-none`) keeps a tall-metric glyph caption from growing the box.
  if (UNIFY_PS_CHROME) {
    // Resolution (ps) sizing at the checkbox/label scale (BTN_* constants), so the button tracks the
    // slider/turn text (not the Interface Scale) and doesn't dwarf the toggles. The frame is restated in px
    // by ensureChromeStyle so it stays proportional to the box → uniform, full frames on every button.
    b.classList.add('rewind-fxsbtn');
    ensureChromeStyle();
    const h = ps(BTN_H);
    b.style.minWidth = ps(BTN_MINW) + 'px';
    b.style.lineHeight = h + 'px';
    b.style.height = b.style.minHeight = b.style.maxHeight = h + 'px';
    b.style.fontSize = ps(BTN_FONT) + 'px';         // match the turn label; overrides the rem `text-base`
  } else {
    b.style.minWidth = '5.7rem';
    b.style.lineHeight = '2.7rem';
    b.style.height = b.style.minHeight = b.style.maxHeight = '2.7rem';
  }
  b.addEventListener('action-activate', (e) => { e.stopPropagation(); try { onClick(); } catch (e2) { err(`btn ${caption}: ${e2}`); } });
  return b;
}
// The play button's caption toggles Play↔Pause; "Pause" is wider, so with only a min-width the button grows
// when clicked. Measure the WIDER caption with a hidden probe (matching the button's font/spacing/uppercase)
// and pin the button to that fixed width so it never resizes. Called once the button is in the DOM.
function pinPlayButtonWidth() {
  const b = els.playBtn; if (!b || !UNIFY_PS_CHROME) return;
  try {
    const cs = getComputedStyle(b);
    const probe = document.createElement('div');
    probe.style.cssText = `position:fixed;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};letter-spacing:${cs.letterSpacing};text-transform:${cs.textTransform};`;
    probe.textContent = 'Pause';   // the wider caption (text-transform makes it PAUSE, matching the button)
    document.body.appendChild(probe);
    const w = Math.ceil(probe.getBoundingClientRect().width + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0));
    probe.remove();
    const fixed = Math.max(ps(BTN_MINW), w);
    b.style.width = b.style.minWidth = b.style.maxWidth = fixed + 'px';
  } catch (e) {}
}
function mkToggle(labelText, initialOn, onChange) {
  const wrap = document.createElement('div'); wrap.className = 'flex flex-row items-center'; wrap.style.marginRight = ps(10) + 'px';
  if (UNIFY_PS_CHROME) wrap.style.flexShrink = '0';   // keep natural size so the group's overflow is measurable (fitControlRow scales the group to fit)
  const cb = document.createElement('fxs-checkbox'); cb.classList.add('mr-2'); cb.setAttribute('selected', initialOn ? 'true' : 'false');
  // fxs-checkbox sizes its host with the `size-8` class (→ 64px at high Interface Scale) and fills it with an
  // img-checkbox background. Pin a fixed ps() width/height (inline beats the class) so the box tracks
  // resolution like the slider/turn text and stays a consistent size on every screen.
  if (UNIFY_PS_CHROME) { cb.style.width = cb.style.height = ps(18) + 'px'; cb.style.flex = '0 0 auto'; }
  cb.addEventListener('component-value-changed', (e) => { try { onChange(!!(e.detail && e.detail.value)); } catch (e2) { err(`toggle ${labelText}: ${e2}`); } });
  // Label text: when unifying, drop the rem `text-base` (Interface Scale) and size in ps() like the turn
  // label; else keep the native rem sizing. (The checkbox BOX itself is still native/rem — that's item 5.)
  const lbl = document.createElement('div');
  lbl.className = UNIFY_PS_CHROME ? 'text-accent-2 font-body pointer-events-auto' : 'text-accent-2 text-base font-body pointer-events-auto';
  lbl.textContent = labelText;
  if (UNIFY_PS_CHROME) { lbl.style.fontSize = ps(13) + 'px'; lbl.style.whiteSpace = 'nowrap'; }
  wrap.append(cb, lbl); return wrap;
}
// Progress shown as the WIDTH of a solid child fill — NOT a per-frame CSS gradient. A linear-gradient is a
// generated texture; reassigning it every frame on the (immortal) track element leaked one texture per frame,
// which the fast rAF scrubber overflowed into the 49152 pool (worse with fog off, where cheaper frames scrub
// faster). A width change on a solid-color div allocates nothing.
function ensureTrackFill() {
  if (!els.track) return null;
  if (!els.trackFill) {
    els.trackFill = document.createElement('div');
    els.trackFill.style.cssText = `position:absolute;z-index:-1;left:0;top:0;bottom:0;width:0;background-color:#6a88bb;pointer-events:none;`;
  }
  if (els.trackFill.parentNode !== els.track) els.track.appendChild(els.trackFill);   // buildAgeBar clears the track; re-attach
  return els.trackFill;
}
function updateControls() {
  if (els.playBtn) { const cap = playing ? 'LOC_REWIND_PAUSE' : 'LOC_REWIND_PLAY'; if (cap !== els.playBtn.__cap) { els.playBtn.setAttribute('caption', cap); els.playBtn.__cap = cap; } }   // only on change
  const fill = ensureTrackFill();
  if (fill) fill.style.width = (frames.length > 1 ? (pos / (frames.length - 1)) * 100 : (frames.length ? 100 : 0)) + '%';
}
// --- leader ribbon (top-right, over the map) ---------------------------------
// A compact stack of the major players present at the current frame: leader portrait + name + civ, in the
// player's (age-correct) colors — a lightweight "legend". Leaders persist across ages so the portrait is
// read live; the name/civ/colors come from the recorded per-frame identity, so it tracks civ swaps.
function ensureRibbon() {
  if (!els.ribbon) {
    els.ribbon = document.createElement('div'); els.ribbon.id = 'rewind-ribbon';
    els.ribbon.style.cssText = 'position:fixed;z-index:99996;display:none;flex-direction:row;flex-wrap:wrap;justify-content:center;align-items:flex-start;max-width:90vw;pointer-events:none;';
    document.body.appendChild(els.ribbon);
  }
  return els.ribbon;
}
function positionRibbon() {   // horizontal row, centered over the TOP of the map (overlapping it)
  const r = ensureRibbon();
  r.style.top = (mapY + ps(6)) + 'px';
  r.style.left = (mapX + mapPxW / 2) + 'px';
  r.style.right = 'auto';
  r.style.transform = 'translateX(-50%)';
}
function ribbonMajors() {   // [ [pid, identity], … ] for the MAJORS to show at the current frame
  const out = [];
  const met = fogMode ? metForPos() : null;   // fog: only leaders met BY THIS FRAME (history-aware)
  for (const [pid, e] of identityForPos()) {
    // Positively require isMajor (Players.get can be null for removed/independent players; ownerMeta would
    // then default to 'major' and leak city-states / dead players into the ribbon).
    let isMajor = false;
    try { const p = Players.get(pid); isMajor = !!(p && p.isMajor); } catch (e2) {}
    if (!isMajor) continue;
    if (met && !met.has(pid)) continue;   // recorded met-state (recorder includes the local observer)
    out.push([pid, e]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}
function ribbonSig() { return ribbonMajors().map(([pid, e]) => `${pid}:${e[3]}:${e[4]}:${e[5] || ''}`).join('|'); }
// Each row is the leader portrait + civ symbol icon (in the player's colors); names + victory info live in
// the hover tooltip. Rows are pointer-events:auto so they can be hovered (the container isn't).
// Rows are created ONCE and reused forever, and HIDDEN (not removed) when a leader isn't shown at the current
// frame — so fog/history membership changes (leaders appearing/disappearing as you scrub) are just a display
// toggle, allocating nothing. Static styles (incl. box-shadow) are set once at creation and never re-parsed;
// only the dynamic color/image bits are updated, via individual properties. The old version tore the ribbon
// down (innerHTML='') and recreated every row each rebuild — those images + box-shadows were retained
// Gameface "static resources" that were never freed, so scrubbing across ages overflowed the 49152 pool.
let ribbonRows = new Map();   // pid -> row element, created once and reused
function buildRibbon() {
  const r = ensureRibbon(); ribbonHoverPid = null;
  const desired = ribbonMajors();
  const shown = new Set();
  for (const [pid, e] of desired) {
    shown.add(pid);
    const col = ownerColors(pid);
    const bgc = `rgba(${col.primary[0]},${col.primary[1]},${col.primary[2]},0.9)`, border = col.secondaryCss;
    let leaderType = null;
    try { const p = Players.get(pid); if (p) leaderType = p.leaderType; } catch (e2) {}
    const civId = e[5] || '';
    let row = ribbonRows.get(pid);
    const isNew = !row;
    if (isNew) {
      row = document.createElement('div'); row.__pid = pid;
      row.style.cssText = `display:flex;align-items:center;margin:0 ${ps(3)}px ${ps(4)}px;border:${ps(1)}px solid #000;border-radius:${ps(16)}px;padding:${ps(2)}px ${ps(7)}px ${ps(2)}px ${ps(2)}px;pointer-events:auto;box-shadow:0 ${ps(1)}px ${ps(4)}px rgba(0,0,0,0.5);`;
      const pic = document.createElement('div');
      pic.style.cssText = `flex:0 0 auto;width:${ps(28)}px;height:${ps(28)}px;border-radius:50%;border:${ps(1)}px solid #000;background-color:#0b0f18;background-size:cover;background-position:center;`;
      const sym = document.createElement('div');
      sym.style.cssText = `flex:0 0 auto;width:${ps(22)}px;height:${ps(22)}px;margin-left:${ps(6)}px;background-size:contain;background-position:center;background-repeat:no-repeat;`;
      row.__pic = pic; row.__sym = sym; row.append(pic, sym);
      row.__leaderKey = row.__civKey = undefined; row.__bgc = row.__border = null; row.__civSymUrl = '';   // force first apply
      ribbonRows.set(pid, row);
      // Insert in pid order at creation so we NEVER have to move a row afterward — re-appending an existing
      // row re-registers its box-shadow (a static resource) in Coherent, which overflowed the 49152 pool
      // under aggressive scrubbing. Rows persist (hidden when unshown), so this insert happens once per leader.
      let before = null;
      for (const ch of r.children) { if (ch.__pid != null && ch.__pid > pid) { before = ch; break; } }
      r.insertBefore(row, before);
    }
    const pic = row.__pic, sym = row.__sym;
    // Assigning an element's background-IMAGE binds a texture that is freed only when the element is destroyed
    // — and these rows live forever (hide-not-remove). Each rebind leaks, so we (re)bind only on a TRUE change:
    // buildRibbon itself runs only when the ribbon signature (which includes each civ id) changes, and the
    // per-row leaderType/civId guards below skip rows that didn't change — so a normal drag binds at most once
    // per player per age boundary it actually crosses. The AUTOMATED harness stress-scrubs (ltMode) are the
    // one case that can rack up thousands of boundary crossings, so those still defer rebinds; real user drags
    // update live. Membership (display) and the SOLID colors below are free regardless.
    const bindImg = isNew || !(ltMode === 'scrub' || ltMode === 'scrubR');
    if (bindImg && leaderType !== row.__leaderKey) {
      row.__leaderKey = leaderType; row.__leaderType = leaderType;
      setPicCss(pic, leaderPortraitCss(leaderType, null));   // neutral expression; hover swaps it (applyRelationshipIcons)
      HB.rimg++;   // HB counter: each image rebind = a texture bind, freed only on element destruction
    }
    if (bindImg && civId !== row.__civKey) {
      row.__civKey = civId;
      const symbol = civSymbolFor(civId);
      row.__civSymUrl = symbol;
      sym.style.backgroundImage = symbol ? `url("${symbol}")` : '';
      HB.rimg++;   // HB counter
    }
    if (bgc !== row.__bgc) { row.style.backgroundColor = bgc; row.__bgc = bgc; }
    if (border !== row.__border) { row.style.borderColor = border; pic.style.borderColor = border; row.__border = border; }
    if (row.style.display === 'none') { row.style.display = 'flex'; HB.ribs++; }   // HB counter: re-shows re-register the row
  }
  for (const [pid, row] of ribbonRows) { if (!shown.has(pid) && row.style.display !== 'none') row.style.display = 'none'; }   // hide (don't remove) leaders not met at this frame — rows stay in their inserted pid order
}
// Memoized civ-symbol lookup — like the portrait, Icon.getCivSymbolFromCivilizationType registers a static
// resource per call, so we fetch each civ's symbol from the engine at most once.
const _civSymbolCache = new Map();   // civId -> symbol url
function civSymbolFor(civId) {
  if (!civId) return '';
  const hit = _civSymbolCache.get(civId);
  if (hit !== undefined) return hit;
  let s = '';
  try { s = Icon.getCivSymbolFromCivilizationType(civId) || ''; } catch (e) {}
  if (s) _civSymbolCache.set(civId, s);   // cache successes only (retry if not yet loaded)
  return s;
}
// Relationship icons keyed by our broad code (recorder: 0 neutral / 1 up / 2 down / 3 alliance / 4 war).
const REL_ICON = { 0: 'PLAYER_RELATIONSHIP_NEUTRAL', 1: 'PLAYER_RELATIONSHIP_FRIENDLY', 2: 'PLAYER_RELATIONSHIP_HOSTILE', 3: 'PLAYER_RELATIONSHIP_ALLIANCE', 4: 'PLAYER_RELATIONSHIP_AT_WAR' };
const _relIconCache = new Map();     // code -> url (memoized; only ~5 codes, and each getIconURL call registers a resource)
function relIconUrl(code) {
  const hit = _relIconCache.get(code);
  if (hit !== undefined) return hit;
  const id = REL_ICON[code];
  let out = '';
  if (id) {
    try { if (typeof UI !== 'undefined' && UI.getIconURL) { const u = UI.getIconURL(id, 'PLAYER_RELATIONSHIP'); if (u) out = u; } } catch (e) {}
    if (!out) { try { if (typeof UI !== 'undefined' && UI.getIcon) { const u = UI.getIcon(id, 'PLAYER_RELATIONSHIP'); if (u) out = u; } } catch (e) {} }
  }
  if (out) _relIconCache.set(code, out);
  return out;
}
function setSymIcon(symEl, url) { if (symEl) symEl.style.backgroundImage = url ? `url("${url}")` : ''; }
function setPicCss(picEl, css) { if (picEl) picEl.style.backgroundImage = css || ''; }
// Leader portrait as a CSS background-image, with a facial-expression CONTEXT (LEADER_HAPPY for friendly/
// alliance, LEADER_ANGRY for hostile/war, default/neutral otherwise) — the same mechanism fxs-icon uses:
// UI.getIconCSS(leaderTypeString, context). Falls back to the neutral portrait if the expression is missing.
// Memoized by (leaderType, expression): the engine icon lookup (UI.getIconCSS) registers a static resource on
// EVERY call, so scrubbing back and forth across an age would re-register the same portraits forever and
// overflow the 49152 pool. Caching the RESULT means each distinct portrait is fetched from the engine once.
const _portraitCache = new Map();   // "leaderType|code" -> CSS
function leaderPortraitCss(leaderType, code) {
  if (leaderType == null) return '';
  const key = leaderType + '|' + (code == null ? '' : code);
  const hit = _portraitCache.get(key);
  if (hit !== undefined) return hit;
  let ctx;
  if (code === 1 || code === 3) ctx = 'LEADER_HAPPY';
  else if (code === 2 || code === 4) ctx = 'LEADER_ANGRY';
  let out = '';
  try {
    const def = GameInfo.Leaders.lookup(leaderType), lt = def && def.LeaderType;
    if (lt && typeof UI !== 'undefined' && UI.getIconCSS) { const css = UI.getIconCSS(lt, ctx); if (css) out = css; }
  } catch (e) {}
  if (!out) { try { const u = Icon.getLeaderPortraitIcon(leaderType); if (u) out = `url("${u}")`; } catch (e) {} }   // neutral fallback
  if (out) _portraitCache.set(key, out);   // cache successes only, so a not-yet-loaded portrait can retry
  return out;
}
// While hovering leader `hoverPid`, every OTHER leader shows its reaction toward the hovered one — the
// facial expression on its portrait (via the LEADER_HAPPY/LEADER_ANGRY icon context) AND its civ icon
// swapped for the relationship icon. The hovered leader stays neutral. Pairs are symmetric (a<b key).
// No hover → everyone neutral (clearRelationshipIcons).
function applyRelationshipIcons(hoverPid) {
  const rel = relationshipForPos(), kids = els.ribbon ? els.ribbon.children : [];
  for (let k = 0; k < kids.length; k++) {
    const row = kids[k], pid = row.__pid; if (pid == null) continue;
    if (pid === hoverPid) { setSymIcon(row.__sym, row.__civSymUrl); setPicCss(row.__pic, leaderPortraitCss(row.__leaderType, null)); continue; }
    const code = rel.get(Math.min(hoverPid, pid) + ',' + Math.max(hoverPid, pid));
    setSymIcon(row.__sym, (code != null ? relIconUrl(code) : '') || row.__civSymUrl);   // unmet pair → keep civ icon
    setPicCss(row.__pic, leaderPortraitCss(row.__leaderType, code != null ? code : 0));  // reaction expression (neutral if unknown)
  }
}
function clearRelationshipIcons() {
  const kids = els.ribbon ? els.ribbon.children : [];
  for (let k = 0; k < kids.length; k++) { setSymIcon(kids[k].__sym, kids[k].__civSymUrl); setPicCss(kids[k].__pic, leaderPortraitCss(kids[k].__leaderType, null)); }
}
// Hit-test by COORDINATES (rect), not event.target — Gameface reports the map canvas as the mousemove
// target even when the cursor is over UI overlapping it, so e.target can't tell us what's really hovered.
function pointInRect(x, y, r) { return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
function ribbonRowAtPoint(x, y) {
  if (!els.ribbon || els.ribbon.style.display === 'none') return null;
  const kids = els.ribbon.children || [];
  for (let k = 0; k < kids.length; k++) { const row = kids[k]; if (row && row.__pid != null && pointInRect(x, y, row.getBoundingClientRect())) return row; }
  return null;
}
// Hover tooltip text for a ribbon leader: "Leader — Civ" (bold) then victory points by category (Military/
// Economic/Cultural/Scientific/Score) — labels from manifest.victoryTypes, scores from the frame's vp.
function ribbonTipText(pid) {
  const id2 = identityForPos().get(pid);
  const leader = id2 ? (id2[0] || '') : '', civ = id2 ? (id2[1] || '') : '';
  const head = leader && civ ? `${leader} — ${civ}` : (leader || civ || `Player ${pid}`);
  const lines = [RAW_MARK + `<b>${escHtml(head)}</b>`];
  const rec = frames.length ? readPlayersRec(pos) : null;
  const labels = (manifest && Array.isArray(manifest.victoryTypes)) ? manifest.victoryTypes : [];
  if (rec && Array.isArray(rec.vp) && labels.length) {
    const entry = rec.vp.find((v) => v[0] === pid);
    const scores = entry && Array.isArray(entry[1]) ? entry[1] : [];
    for (let k = 0; k < labels.length; k++) lines.push(`${labels[k]}: ${scores[k] || 0}`);
  }
  return lines.join('[N]');
}
let ribbonSigLast = null;
function updateRibbon() {
  const r = ensureRibbon();
  if (!showLeaders || !mapVisible || !frames.length) { r.style.display = 'none'; return; }
  const sig = ribbonSig();   // safe to rebuild live now — rows are reused/hidden/inserted-in-order, so this allocates nothing on a membership change
  if (sig !== ribbonSigLast) { buildRibbon(); ribbonSigLast = sig; }
  positionRibbon();
  r.style.display = 'flex';
}
function buildPanel() {
  const p = document.createElement('div'); p.id = 'rewind-panel';
  p.style.cssText = `position:fixed;left:50%;top:0px;transform:translateX(-50%);box-sizing:border-box;z-index:99998;display:none;flex-direction:column;${UNIFY_PS_CHROME ? 'align-items:center;' : ''}gap:${ps(6)}px;padding:${ps(10)}px ${ps(12)}px;background:rgba(16,22,34,0.94);border:${ps(1)}px solid #6a88bb;border-radius:${ps(8)}px;color:#fff;pointer-events:auto;`;
  // Control row spans the panel: layer checkboxes flush-LEFT, playback buttons CENTERED (the equal flex:1
  // side groups grow to keep the center group on the map center), Fog + speed flush-RIGHT. If the content
  // can't fit the map width, fitControlRow() collapses it to a content-width cluster and scales it down.
  const controlRow = document.createElement('div'); els.controlRow = controlRow;
  controlRow.style.cssText = 'display:flex;align-items:center;width:100%;flex-wrap:nowrap;';
  const terr = mkToggle('Territory', showTerritory, (on) => { showTerritory = on; redraw(); });
  const bord = mkToggle('Borders', showBorders, (on) => { showBorders = on; redraw(); });
  const unit = mkToggle('Units', showUnits, (on) => { showUnits = on; redraw(); });
  const wond = mkToggle('Wonders', showWonders, (on) => { showWonders = on; redraw(); });
  const fog = mkToggle('Fog', fogMode, (on) => { if (suppressFog || fogLocked) return; fogMode = on; markBgDirty(); redraw(); updateRibbon(); });
  els.fogToggleCb = fog.querySelector('fxs-checkbox');
  els.fogToggleWrap = fog;
  const lead = mkToggle('Leaders', showLeaders, (on) => { showLeaders = on; updateRibbon(); });
  const rsrc = mkToggle('Resources', showResources, (on) => { showResources = on; redraw(); });
  const leftGroup = document.createElement('div'); leftGroup.style.cssText = `flex:1 1 0;min-width:0;display:flex;align-items:center;justify-content:flex-start;`;
  leftGroup.append(terr, bord, unit, wond, lead, rsrc);   // Fog lives in the right group (next to the speed button)
  const centerGroup = document.createElement('div'); centerGroup.style.cssText = `flex:0 0 auto;display:flex;align-items:center;justify-content:center;padding:0 ${ps(10)}px;`;
  els.toStart = mkFxsBtn('LOC_REWIND_TO_START', () => { pause(); goToIndex(0); });
  els.prev = mkFxsBtn('LOC_REWIND_PREV', () => { pause(); goToIndex(pos - 1); });
  els.playBtn = mkFxsBtn('LOC_REWIND_PLAY', () => { playing ? pause() : play(); });
  els.next = mkFxsBtn('LOC_REWIND_NEXT', () => { pause(); goToIndex(pos + 1); });
  els.toEnd = mkFxsBtn('LOC_REWIND_TO_END', () => { pause(); goToIndex(frames.length - 1); });
  centerGroup.append(els.toStart, els.prev, els.playBtn, els.next, els.toEnd);
  const rightGroup = document.createElement('div'); rightGroup.style.cssText = `flex:1 1 0;min-width:0;display:flex;align-items:center;justify-content:flex-end;`;
  els.speedBtn = mkFxsBtn(PLAY_SPEED_LABELS[speedIdx], cycleSpeed);   // cycles 1x → 2x → 4x → 0.5x
  rightGroup.append(fog, els.speedBtn);   // Fog toggle sits just left of the speed button
  controlRow.append(leftGroup, centerGroup, rightGroup);
  // Timeline track: a flex row of per-age sections (centered age name + divider) laid OVER a gradient
  // progress fill on the track background — age info is embedded in the seek bar, no extra height.
  els.track = document.createElement('div');
  els.track.style.cssText = `position:relative;display:flex;align-items:stretch;width:100%;height:${ps(18)}px;box-sizing:border-box;background-color:#223049;border:${ps(1)}px solid #6a88bb;border-radius:${ps(8)}px;overflow:hidden;cursor:pointer;pointer-events:auto;`;
  els.track.addEventListener('mousedown', onSeekStart);
  els.track.addEventListener('mousemove', onTrackHover);   // scrub-preview tooltip (turn at cursor)
  els.track.addEventListener('mouseleave', onTrackLeave);
  p.append(controlRow, els.track); document.body.appendChild(p); els.panel = p;
  // Turn pill: shown only while hovering the scrubber (onTrackHover), floating just above the track at the
  // cursor. z above the panel (99998) so it isn't hidden behind the controls.
  els.label = document.createElement('div'); els.label.id = 'rewind-turnlabel'; els.label.className = 'font-title';
  els.label.style.cssText = `position:fixed;z-index:99999;display:none;transform:translate(-50%,-100%);white-space:nowrap;pointer-events:none;background:rgba(16,22,34,0.85);border:${ps(1)}px solid #6a88bb;border-radius:${ps(6)}px;padding:${ps(2)}px ${ps(12)}px;font-size:${ps(13)}px;color:#fff;box-shadow:0 ${ps(1)}px ${ps(5)}px rgba(0,0,0,0.5);`;
  document.body.appendChild(els.label);
  buildAgeBar();
  pinPlayButtonWidth();   // lock the play button to the wider "Pause" width so it doesn't resize when toggled
}
// Populate the track with one flex section per age (sized by turn count) — centered age name + a
// divider between ages. Sections are pointer-events:none so clicks pass through to the track (seek).
function buildAgeBar() {
  if (!els.track) return;
  els.track.innerHTML = '';
  const ages = (manifest && Array.isArray(manifest.ages)) ? manifest.ages : [];   // [[startGi, ageId, name], ...]
  const n = frames.length;
  if (!n) return;
  const sections = [];
  for (let a = 0; a < ages.length; a++) {
    const startGi = ages[a][0], name = ages[a][2] || '';
    const endGi = (a + 1 < ages.length) ? ages[a + 1][0] : n;
    const count = Math.max(0, Math.min(n, endGi) - startGi);
    if (count > 0) sections.push({ count, name });
  }
  if (!sections.length) sections.push({ count: n, name: ages.length ? (ages[0][2] || '') : '' });
  for (let s = 0; s < sections.length; s++) {
    const sec = document.createElement('div');
    sec.className = 'font-title';   // match the native buttons' font
    sec.style.cssText = `flex:${sections[s].count} 1 0;display:flex;align-items:center;justify-content:center;font-size:${ps(11)}px;color:#eef3fb;white-space:nowrap;overflow:hidden;pointer-events:none;${s > 0 ? `border-left:${ps(2)}px solid #cdddff;` : ''}`;
    sec.textContent = sections[s].name;
    els.track.append(sec);
  }
}
// endgameMode = shown via the Victories tab (the tab handles closing, so hide our X); false = in-game launcher.
let endgameMode = false;
// Fog-of-war defaults ON at every map open — in-game AND at the endgame Victories screen (user request:
// the checkbox always starts checked; at endgame it can still be unchecked to reveal everything). In a
// MULTIPLAYER game, while the game is still IN PROGRESS, fog is additionally LOCKED on (checkbox disabled
// + native tooltip) so the replay can't scout other players — via EITHER the in-game minimap checkbox OR
// the mid-game Victories→Rewind tab (endgameMode is true there, so we gate on isLocalGameOver(), not it).
// Once the game is genuinely over the lock lifts. Sets the flags + syncs the toggle (suppressed so it
// doesn't re-fire), but does NOT repaint — call this BEFORE a build so the first draw is already correct.
const FOG_LOCK_TIP = "Can't disable fog in multiplayer!";
function setFogFromContext() {
  fogMode = true;
  fogLocked = isMultiplayerGame() && !isLocalGameOver();
  const cb = els.fogToggleCb;
  if (cb) {
    suppressFog = true;
    try { cb.setAttribute('selected', fogMode ? 'true' : 'false'); } finally { suppressFog = false; }
    cb.setAttribute('disabled', fogLocked ? 'true' : 'false');
  }
  // The lock-reason tooltip is shown via OUR own tooltip in onMapHover (z 2000005, above the map/scrub) —
  // NOT the native data-tooltip-content, which renders behind our high-z layers and gets clipped.
}
// Reveal an already-built map: one container toggle + show the scrubber. Cheap, never blocks. Only repaints
// if the built/prebuilt image doesn't already match the desired fog state (fresh in-game builds already do).
// "Rewind" open behavior: the FIRST time the map is opened on a given game turn, jump to the most recent
// frame (freshest state); reopening within the same game turn returns to wherever you left the scrubber.
function applyOpenPosition() {
  if (!frames.length) return;
  let curTurn = -1;
  try { curTurn = (typeof Game !== 'undefined' && Game.turn != null) ? Game.turn : -1; } catch (e) {}
  if (curTurn !== lastOpenTurn) { pos = frames.length - 1; lastOpenTurn = curTurn; }   // new game turn → latest frame
  else pos = Math.max(0, Math.min(frames.length - 1, pos));                              // same turn → keep position
}
// Score-tab backdrop (bg-panel-iceland @ 20%) shown behind the ENDGAME map, sized to the Victories pane, so
// the margins around the (opaque) map match the other victory tabs. z below the map so the map covers center.
function showIcelandBg() {
  let d = els.icelandBg;
  if (!d) {
    d = document.createElement('div'); d.id = 'rewind-iceland-bg';
    d.style.cssText = `position:fixed;z-index:99980;display:none;background-image:url(bg-panel-iceland);background-size:cover;background-position:center;background-repeat:no-repeat;opacity:0.2;pointer-events:none;border-radius:${ps(8)}px;`;
    document.body.appendChild(d); els.icelandBg = d;
  }
  try { const a = measureArea(); d.style.left = a.x + 'px'; d.style.top = a.y + 'px'; d.style.width = a.w + 'px'; d.style.height = a.h + 'px'; d.style.display = 'block'; }
  catch (e) { d.style.display = 'none'; }
}
function hideIcelandBg() { if (els.icelandBg) els.icelandBg.style.display = 'none'; }
function reveal() {
  if (!els.panel) buildPanel();
  positionPanel();
  if (endgameMode) showIcelandBg(); else hideIcelandBg();   // score-tab backdrop, endgame only
  // Lay the panel out but keep it INVISIBLE (visibility:hidden still measures; display:none wouldn't), so we
  // can read its real height and re-center the map+scrub block BEFORE anything is shown — no visible jump.
  els.panel.style.visibility = 'hidden';
  els.panel.style.display = 'flex';
  // Scale the control cluster to fit the map width. Setting display:flex forces a synchronous layout, so we
  // can measure + apply the scale RIGHT NOW, in the same frame — this avoids the glitch where a rAF-only fit
  // set the transform but it wasn't painted until the next repaint (a mouse-move), leaving controls briefly
  // full-size. The rAF/timeout re-runs are backups in case fonts/metrics settle a frame later. (Idempotent.)
  const fit = () => { try { fitControlRow(mapPxW); } catch (e) {} };
  fit();
  els.panel.style.visibility = '';   // reveal the scrub panel
  try { requestAnimationFrame(() => { fit(); requestAnimationFrame(fit); }); } catch (e) {}
  try { setTimeout(fit, 130); } catch (e) {}
  if (els.label) els.label.style.display = 'none';   // turn pill shows only on scrubber hover
  setMapVisible(true);
  applyOpenPosition();
  drawMap(frameFor(pos));   // draw the chosen frame (also applies current fog / corrects a prebuilt map opened at a new position)
  pause();
  updateControls();
  updateRibbon();
}
// "Loading map…" placard for the in-game launcher (the endgame tab shows its own native loading text).
function showLoading() {
  if (!els.loading) { els.loading = document.createElement('div'); document.body.appendChild(els.loading); }
  const a = measureArea();
  els.loading.style.cssText = `position:fixed;left:${a.x + a.w / 2}px;top:${a.y + a.h / 2}px;transform:translate(-50%,-50%);z-index:99999;font-family:monospace;font-size:${ps(22)}px;color:#cdddff;background:rgba(16,22,34,0.9);padding:${ps(12)}px ${ps(24)}px;border-radius:${ps(8)}px;pointer-events:none;display:block;`;
  els.loading.textContent = 'Loading map…';
}
function hideLoading() { if (els.loading) els.loading.style.display = 'none'; }
function nextPaint(fn) {   // run after a paint, so the tab transition animates before any work
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(fn));
  else setTimeout(fn, 48);
}
// Show the map without ever blocking the caller (the tab click): reveal a prebuilt map next frame,
// wait on an in-flight build, or kick off a fresh chunked (non-blocking) build.
function requestShow(usePlacard) {
  // Record the CURRENT in-progress turn as the newest frame ("show me now"): the last recorded frame is
  // otherwise the start-of-turn state, which reads as stale mid-turn. record() dedupes by (age, turn) and
  // the end-of-turn recording overwrites this partial frame with the resolved one, so the convention
  // self-heals. Must run BEFORE refresh() reads the manifest. (No-op in the shell scope / safe mode.)
  try { if (typeof window.RewindRecordFinal === 'function') window.RewindRecordFinal(); } catch (e) {}
  if (!els.panel) buildPanel();
  setFogFromContext();   // set fog default BEFORE any build so the first draw is already correct (no second redraw)
  if (usePlacard) showLoading();
  // A map built (or endgame-prebuilt) before the turn advanced would otherwise be revealed as-is, showing
  // stale turns (e.g. "Turn 1/1" after turn 2 was recorded). Re-check the recorded turn count and rebuild
  // if it grew.
  if (prebuilt && recordedFrameCount() !== builtFrameCount) prebuilt = false;
  if (prebuilt && layoutStillValid()) { nextPaint(() => { reveal(); hideLoading(); }); }
  else if (building) { revealWhenBuilt = true; }
  else {
    refresh();
    applyOpenPosition();   // pick the open frame BEFORE building so the build renders the right one
    if (frames.length && cellByIndex) { revealWhenBuilt = true; buildChunked(frameFor(pos)); }
    else { hideLoading(); updateControls(); }
  }
}
function closePanel() {
  revealWhenBuilt = false;
  pause();
  if (els.panel) els.panel.style.display = 'none';
  if (els.ribbon) els.ribbon.style.display = 'none';
  if (els.label) els.label.style.display = 'none';
  hideIcelandBg();
  setMapVisible(false);
  hideLoading();
  clearHover();
}
// Background prebuild on Victories mount: chunked + hidden, so selecting the Rewind tab just reveals.
function prebuild() {
  if ((prebuilt && layoutStillValid()) || building) return;
  if (!els.panel) buildPanel();   // build the scrub panel first so computeLayout can measure its height for the pane reserve
  // Endgame safety net: make sure the final resolved world state is recorded (e.g. after the local
  // player's elimination, when no further turn events fire) BEFORE refresh() reads the manifest.
  try { if (typeof window.RewindRecordFinal === 'function') window.RewindRecordFinal(); } catch (e) {}
  refresh();
  if (frames.length && cellByIndex) { buildChunked(frameFor(pos)); log('prebuild started (chunked, hidden)'); }
}

// External control hook — the endgame Victories tab binds the map to its tab selection. (The in-game
// minimap checkbox isn't shown on the Victories screen, so there's nothing to toggle there.)
try {
  window.RewindReplay = {
    prebuild() { try { prebuild(); } catch (e) { err(`prebuild: ${e}`); } },     // build hidden in the background (on mount)
    show() { endgameMode = true; requestShow(false); },   // tab shows its own native "Loading map"
    hide() { closePanel(); },                             // tab deselected / closed: hide the map
  };
} catch (e) { err(`expose RewindReplay: ${e}`); }

// In-game entry point: a native fxs-checkbox injected into the minimap's lens/visibility panel, right
// next to "Show Minimap". Checking it shows the replay map; unchecking removes it. (Replaces the old
// bottom-left "Rewind" launcher button.)
function ensureRewindCheckbox() {
  try {
    if (document.getElementById('rewind-cb')) return;                      // already injected
    const smLabel = document.querySelector('[data-l10n-id="LOC_UI_SHOW_MINIMAP"]');
    if (!smLabel) return;                                                  // minimap lens panel not built yet
    const smContainer = smLabel.parentElement;                            // Show Minimap's checkbox+label row
    if (!smContainer) return;
    // The row is a half-width flex-row; widen it and append our controls so we sit to the RIGHT of
    // "Show Minimap" (the vslot parent would otherwise drop a sibling onto its own line below).
    try { smContainer.classList.remove('w-1\\/2'); smContainer.classList.add('w-full'); } catch (e) { }
    const cb = document.createElement('fxs-checkbox');
    cb.id = 'rewind-cb';
    cb.classList.add('mr-2', 'ml-6');                                      // ml-6 separates it from the Show Minimap label
    cb.setAttribute('selected', mapVisible ? 'true' : 'false');
    cb.setAttribute('data-audio-group-ref', 'audio-panel-mini-map');
    cb.addEventListener('component-value-changed', (e) => {
      if (suppressCheckbox) return;                                        // ignore our own programmatic sync
      const on = !!(e.detail && e.detail.value);
      if (on) { endgameMode = false; requestShow(true); } else { closePanel(); }
    });
    const lbl = document.createElement('div');
    lbl.setAttribute('role', 'paragraph');
    lbl.className = 'text-accent-2 text-base font-body pointer-events-auto';
    lbl.textContent = 'Rewind';
    smContainer.appendChild(cb);
    smContainer.appendChild(lbl);
    els.rewindCheckbox = cb;
    log('Rewind checkbox injected beside Show Minimap');
  } catch (e) { err(`ensureRewindCheckbox: ${e}`); }
}

// --- lifecycle ---------------------------------------------------------------
// Watch the DOM so we inject the *instant* the minimap panel (with its Show Minimap checkbox) mounts,
// rather than waiting for the next poll tick. Disconnects itself once we're in; re-armed by the poll
// if the panel is ever rebuilt (e.g. age transition removes our checkbox).
let cbObserver = null;
function armCheckboxObserver() {
  if (cbObserver || !document.body || typeof MutationObserver === 'undefined') return;
  cbObserver = new MutationObserver(() => {
    ensureRewindCheckbox();
    if (document.getElementById('rewind-cb')) { cbObserver.disconnect(); cbObserver = null; }
  });
  cbObserver.observe(document.body, { childList: true, subtree: true });
}
// The in-game map is a very-high z-index overlay, so the pause menu (Escape) would open *behind* it,
// hiding its own controls. Close the map when the pause-menu view takes over. (Endgame tab is exempt —
// its visibility is driven by the tab, not by in-game views.)
function onViewChanged() {
  try {
    if (!mapVisible || endgameMode) return;
    const v = ViewManager && ViewManager.current;
    if (v && typeof v.getName === 'function' && v.getName() === 'PauseMenu') {
      closePanel();
      log('map closed — pause menu opened');
    }
  } catch (e) { }
}
let cbPollStarted = false;
function onEnterGame(evt) {
  log(`playback UI: '${evt}' — injecting Rewind minimap checkbox`);
  ensureRewindCheckbox();                                                  // maybe already present
  armCheckboxObserver();                                                   // catch it the moment it mounts
  // Fallback / rebuild recovery (cheap; also covers hosts without MutationObserver).
  if (!cbPollStarted) {
    cbPollStarted = true;
    setInterval(() => { ensureRewindCheckbox(); if (!document.getElementById('rewind-cb')) armCheckboxObserver(); }, 1000);
  }
}
// Safe mode (main-menu toggle): keep the mod loaded but inert (no launcher / map UI), so saves still load.
function rewindDisabled() { try { return UI.getOption('user', 'Interface', 'RewindDisabled') == 1; } catch (e) { return false; } }
if (rewindDisabled()) {
  log('safe mode ON — playback UI inert');
} else {
  log('playback UI module loaded — binding lifecycle events');
  engine.on('GameStarted', () => onEnterGame('GameStarted'));
  engine.on('LoadComplete', () => onEnterGame('LoadComplete'));
  try { window.addEventListener('view-changed', onViewChanged); } catch (e) { }
  try { if (typeof UI !== 'undefined' && UI.isInGame && UI.isInGame()) onEnterGame('module-load'); } catch (e) { }
}
