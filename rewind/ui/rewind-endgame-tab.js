/**
 * Civilization VII Rewind — endgame Victories tab
 *
 * Adds a native "Rewind" tab to the Victories screen without copying VictoriesScreenComponent:
 * we wrap the ui-next "Tab" component in ComponentRegistry (capturing its previous factory) and,
 * only when rendered inside VictoriesScreenContext on the main `.victories-tab-bar`, append one
 * extra Tab.Item ("rewind") and hook onTabChanged / mount / cleanup to drive window.RewindReplay.
 *
 * Because the base VictoriesScreen stays completely intact, any future game patches (new ages,
 * victory tabs, disabled-victory logic, audio, layout changes) are inherited automatically.
 */
import { createComponent, mergeProps, onCleanup, onMount, useContext } from '/core/vendor/solid-js/dist/solid.js';
import { Tab } from '/core/ui-next/components/tab.js';
import { ComponentRegistry } from '/core/ui-next/services/component-registry.js';
import { VictoriesScreenContext } from '/base-standard/ui-next/screens/victories/victories-screen-model.js';

const TAG = '[REWIND]';
const DEBUG = false;   // set true to re-enable the mod's [REWIND] informational logging
function log(m) { if (DEBUG) console.warn(`${TAG} ${m}`); }
function err(m) { console.error(`${TAG} ${m}`); }

function createRewindLoadingBody() {
  // Native "Loading map…" content: renders instantly when the tab is selected (so the tab
  // transition is never gated on our work). Our map overlay is opaque and sits on top, so
  // it simply covers this text once it's revealed — no coordination needed.
  const d = document.createElement('div');
  d.style.cssText = 'display:flex;flex:1 1 auto;align-items:center;justify-content:center;min-height:240px;font-family:monospace;font-size:26px;letter-spacing:2px;color:#cdddff;text-transform:uppercase;';
  d.textContent = 'Loading map…';
  return d;
}

function tagVictoriesChrome(tabRoot) {
  try {
    if (!tabRoot) return;
    const pane = tabRoot.querySelector('.victories-panel-container');
    if (pane && pane.id !== 'rewind-panel-container') {
      pane.id = 'rewind-panel-container';   // measured by the playback layout
    }
    const parent = tabRoot.parentElement;
    if (parent) {
      const eb = parent.querySelector('.bottom-10.right-10');
      if (eb) {
        if (eb.id !== 'rewind-endgame-buttons') eb.id = 'rewind-endgame-buttons';   // Exit-button keep-out
        // Raise ONLY the z-index so the Exit/Continue buttons stay above our full-width control panel (z 99998).
        eb.style.zIndex = '100001';
      }
    }
  } catch (e) {}
}

try {
  const origTab = Tab.factory();
  const TabWithRewind = (props) => {
    const inVictories = !!useContext(VictoriesScreenContext);
    const isVictoriesMainTab = inVictories && String(props.class || '').includes('victories-tab-bar');
    if (!isVictoriesMainTab) return origTab(props);

    let tabRoot = null;
    let prebuildTimer = null;

    const wrappedProps = mergeProps(props, {
      onTabChanged: (tabProps) => {
        props.onTabChanged?.(tabProps);
        tagVictoriesChrome(tabRoot);
        if (tabProps) {
          try {
            if (tabProps.name === 'rewind') window.RewindReplay?.show();
            else window.RewindReplay?.hide();
          } catch (e) {}
        }
      },
      get children() {
        const base = props.children;
        const rewindItem = createComponent(Tab.Item, {
          name: 'rewind',
          title: () => 'Rewind',
          body: createRewindLoadingBody
        });
        return Array.isArray(base) ? [...base, rewindItem] : [base, rewindItem];
      }
    });

    tabRoot = origTab(wrappedProps);

    onMount(() => {
      tagVictoriesChrome(tabRoot);
      // Build the replay map hidden in the background now (pane is measurable on mount), so selecting
      // the Rewind tab later reveals it instantly. Delayed so it doesn't stutter the screen appearing.
      prebuildTimer = setTimeout(() => {
        prebuildTimer = null;
        tagVictoriesChrome(tabRoot);
        try { window.RewindReplay?.prebuild?.(); } catch (e) {}
      }, 800);
    });

    onCleanup(() => {
      if (prebuildTimer != null) { clearTimeout(prebuildTimer); prebuildTimer = null; }
      try { window.RewindReplay?.hide(); } catch (e) {}   // screen closing: make sure the map is hidden
    });

    return tabRoot;
  };

  ComponentRegistry.register('Tab', TabWithRewind, (Tab.overridePriority ?? 0) + 1);
  log('endgame tab: wrapped Tab for VictoriesScreen (+Rewind tab)');
} catch (e) { err(`endgame tab register failed: ${e}`); }
