/**
 * Civilization VII Rewind — Options-menu integration.
 *
 * Adds a "Rewind" section under the Game options category with three checkboxes:
 *   • Disable Rewind (safe mode)        -> user option Interface/RewindDisabled  (was the main-menu button)
 *   • Auto-delete replay data each turn -> user option Interface/RewindAutoDelete
 *   • Show recorder timing badge        -> user option Interface/RewindShowLoadBadge
 *
 * Both persist via UI.setOption("user", ...) — player settings, never stored in a save. This script is
 * loaded in BOTH the shell (main-menu Options) and game (in-game Options) scopes so the section shows up
 * either way; the shell copy keeps the safe-mode toggle reachable even if an in-game bug blocks a load.
 */

import { Options, OptionType, CategoryType } from '/core/ui/options/model-options.js';

const TAG = '[REWIND]';
const DEBUG = false;   // set true to re-enable the mod's [REWIND] informational logging
function log(m) { if (DEBUG) console.warn(`${TAG} ${m}`); }

// Read a user-option flag (0/1) into the checkbox's current value.
function initFlag(o) {
  try { const v = UI.getOption(o.optionSet, o.optionType, o.optionName); o.currentValue = Boolean(typeof v === 'number' ? v : 0); }
  catch (e) { o.currentValue = false; }
}
// Persist the checkbox value back to the user-option flag.
function updateFlag(o, value) {
  try { UI.setOption(o.optionSet, o.optionType, o.optionName, value ? 1 : 0); }
  catch (e) { log(`setOption ${o.optionName} failed: ${e}`); }
}

function addRewindOptions() {
  Options.addOption({
    category: CategoryType.Game,
    group: 'rewind',
    type: OptionType.Checkbox,
    id: 'rewind-disable',
    initListener: initFlag,
    updateListener: updateFlag,
    label: 'LOC_OPTIONS_REWIND_DISABLE',
    description: 'LOC_OPTIONS_REWIND_DISABLE_DESCRIPTION',
    optionSet: 'user', optionType: 'Interface', optionName: 'RewindDisabled',
  });
  Options.addOption({
    category: CategoryType.Game,
    group: 'rewind',
    type: OptionType.Checkbox,
    id: 'rewind-autodelete',
    initListener: initFlag,
    updateListener: updateFlag,
    label: 'LOC_OPTIONS_REWIND_AUTODELETE',
    description: 'LOC_OPTIONS_REWIND_AUTODELETE_DESCRIPTION',
    optionSet: 'user', optionType: 'Interface', optionName: 'RewindAutoDelete',
  });
  Options.addOption({
    category: CategoryType.Game,
    group: 'rewind',
    type: OptionType.Checkbox,
    id: 'rewind-loadbadge',
    initListener: initFlag,
    updateListener: updateFlag,
    label: 'LOC_OPTIONS_REWIND_LOADBADGE',
    description: 'LOC_OPTIONS_REWIND_LOADBADGE_DESCRIPTION',
    optionSet: 'user', optionType: 'Interface', optionName: 'RewindShowLoadBadge',
  });
}

// Insertion order into the Options map drives BOTH the category-tab order and the option order within a
// category. Registering via addInitCallback runs before the base game's (lazily-registered) callback, so
// our Game options would be added first — bumping the Game tab to the front and putting Rewind at the top.
// Instead, wrap Options.init() to append our section AFTER the base callbacks have populated the map: the
// Game tab keeps its original position and the Rewind section lands at the bottom of Game.
try {
  if (!Options.__rewindPatched) {
    Options.__rewindPatched = true;
    const origInit = Options.init.bind(Options);
    Options.init = function () {
      origInit();                                   // base + others populate the map first
      try { addRewindOptions(); Options.updateHiddenOptions(); }
      catch (e) { console.error(`${TAG} addRewindOptions: ${e}`); }
    };
    log('Options.init wrapped — Rewind section appended last (Game > Rewind)');
  }
} catch (e) { console.error(`${TAG} options patch failed: ${e}`); }
