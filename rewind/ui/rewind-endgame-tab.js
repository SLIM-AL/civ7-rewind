/**
 * Civilization VII Rewind — endgame Victories tab
 *
 * Adds a native "Rewind" tab to the end-game Victories screen by re-registering the ui-next
 * "VictoriesScreen" component with a higher overridePriority. ComponentRegistry wraps each
 * component in a stable dispatcher whose `.factory` is swapped to the highest-priority
 * registration, and the screen's legacy element captured that wrapper — so our override takes
 * effect regardless of which module loads first, and ours (100) always beats base (0). We never
 * call the base factory; we reproduce the base render (so all victory tabs stay intact) and add
 * one extra Tab.Item.
 *
 * The extra tab drives the replay map via window.RewindReplay (rewind-playback.js): prebuild on
 * mount, show/hide on tab change; its native body is a "Loading map…" placard the opaque map
 * overlay simply covers once revealed.
 *
 * NOTE: this is a faithful copy of base-standard/ui-next/screens/victories/victories-screen.js's
 * VictoriesScreenComponent — if the base screen changes in a patch, this copy may need updating.
 */
import { template, insert, className } from '/core/vendor/solid-js/web/dist/web.js';
import { untrack, createMemo, onMount, onCleanup, createComponent, createRenderEffect, mergeProps, Show } from '/core/vendor/solid-js/dist/solid.js';
import { DisplayQueueManager } from '/core/ui/context-manager/display-queue-manager.js';
import { InputEngineEventName, NavigateInputEventName } from '/core/ui/input/input-support.js';
import { InterfaceMode } from '/core/ui/interface-modes/interface-modes.js';
import { Button } from '/core/ui-next/components/button.js';
import { L10n } from '/core/ui-next/components/l10n.js';
import { Tab } from '/core/ui-next/components/tab.js';
import { useAudio } from '/core/ui-next/services/audio-support.js';
import { ComponentRegistry } from '/core/ui-next/services/component-registry.js';
import { useIsSmallScreen, LayoutModel } from '/core/ui-next/utilities/layout-utilities.js';
import TutorialManager from '/base-standard/ui/tutorial/tutorial-manager.js';
import { ScreenFrame } from '/base-standard/ui-next/components/screen-frame.js';
import { CultureVictoryTab } from '/base-standard/ui-next/screens/victories/culture-victory-tab.js';
import { EconomicVictoryTab } from '/base-standard/ui-next/screens/victories/economic-victory-tab.js';
import { MilitaryVictoryTab } from '/base-standard/ui-next/screens/victories/military-victory-tab.js';
import { ScienceVictoryTab } from '/base-standard/ui-next/screens/victories/science-victory-tab.js';
import { ScoreVictoryTab } from '/base-standard/ui-next/screens/victories/score-victory-tab.js';
import { VictoriesSummary } from '/base-standard/ui-next/screens/victories/summary-victory-tab.js';
import { createVictoriesScreenModel, VictoriesScreenContext } from '/base-standard/ui-next/screens/victories/victories-screen-model.js';
import style from '/base-standard/ui-next/screens/victories/victories-screen.scss.js';

const TAG = '[REWIND]';
const DEBUG = false;   // set true to re-enable the mod's [REWIND] informational logging
function log(m) { if (DEBUG) console.warn(`${TAG} ${m}`); }
function err(m) { console.error(`${TAG} ${m}`); }

const _tmpl$ = template(`<div><div class="absolute inset-0 bottom-0 filigree-inner-frame-top"></div><div class="absolute inset-0 bottom-0 filigree-inner-frame-bottom"></div></div>`);
const _tmpl$2 = template(`<div class="absolute bottom-10 right-10 flex flow-row"></div>`);

// --- faithful copy of VictoriesScreenComponent, plus the extra "rewind" Tab.Item -------------
const VictoriesScreenWithRewind = (props) => {
  const isSmallScreen = useIsSmallScreen();
  const endGameScreen = untrack(() => props.endGameScreen);
  const allowOneMoreTurn = untrack(() => props.allowOneMoreTurn);
  const showNextTurnButton = untrack(() => props.showNextTurnButton);
  const model = createVictoriesScreenModel(endGameScreen, allowOneMoreTurn, showNextTurnButton);
  const defaultTab = createMemo(() => {
    return props.activeTabId?.() ?? void 0;
  });
  const audio = useAudio("VictoryScreen");
  onMount(() => {
    audio("popup-open");
    window.addEventListener(InputEngineEventName, handleWindowEngineInput);
    window.addEventListener(NavigateInputEventName, handleWindowEngineInput);
    // Build the replay map hidden in the background now (pane is measurable on mount), so selecting
    // the Rewind tab later reveals it instantly. Delayed so it doesn't stutter the screen appearing.
    setTimeout(() => { try { window.RewindReplay?.prebuild?.(); } catch (e) {} }, 800);
  });
  onCleanup(() => {
    window.removeEventListener(InputEngineEventName, handleWindowEngineInput);
    window.removeEventListener(NavigateInputEventName, handleWindowEngineInput);
    try { window.RewindReplay?.hide(); } catch (e) {}   // screen closing: make sure the map is hidden
  });
  const handleOnClosing = () => {
    if (!props.endGameScreen) {
      audio("popup-close");
    }
  };
  const handleWindowEngineInput = (inputEvent) => {
    if (inputEvent.detail.status == InputActionStatuses.FINISH) {
      switch (inputEvent.detail.name) {
        case "shell-action-1":
          model.onGamepadInspectButton();
          inputEvent.preventDefault();
          inputEvent.stopImmediatePropagation();
          break;
        case "shell-action-3":
          if (!TutorialManager.isShowing()) {
            model.onGamepadInfoButton();
          }
          break;
        case "sys-menu":
        case "accept":
          if (props.endGameScreen) {
            inputEvent.preventDefault();
            inputEvent.stopImmediatePropagation();
          }
          break;
      }
    }
  };
  const justOneMoreTurn = () => {
    const args = {};
    const result = Game.PlayerOperations.canStart(GameContext.localPlayerID, PlayerOperationTypes.EXTEND_GAME, args, false);
    if (result.Success) {
      Game.PlayerOperations.sendRequest(GameContext.localPlayerID, PlayerOperationTypes.EXTEND_GAME, args);
      DisplayQueueManager.closeMatching("EndgameScreen");
      InterfaceMode.switchToDefault();
    }
  };
  const advanceToNextPlayer = () => {
    GameContext.sendTurnComplete();
    DisplayQueueManager.closeMatching("EndgameScreen");
    InterfaceMode.switchToDefault();
  };
  return createComponent(VictoriesScreenContext.Provider, {
    value: model,
    get children() {
      return createComponent(ScreenFrame, {
        name: "Victories-Screen",
        panelContext: "screen-victory-progress",
        audioContext: "VictoryScreen",
        title: "LOC_UI_VICTORY_PROGRESS",
        get ornatePanelData() {
          return model.data.ornatePanelData;
        },
        onClosing: handleOnClosing,
        get hideClose() {
          return props.endGameScreen;
        },
        addYieldBar: false,
        get children() {
          return [createComponent(Tab, {
            "class": "victories-tab-bar w-full flex flex-col flex-auto pointer-events-auto mx-5",
            get defaultTab() {
              return createMemo(() => !!defaultTab())() ? defaultTab() : model.data.defaultTab;
            },
            onTabChanged: (tabProps) => {
              if (tabProps) {
                model.tabChanged(tabProps.name);
                try {
                  if (tabProps.name === "rewind") window.RewindReplay?.show();   // show our map overlay
                  else window.RewindReplay?.hide();                              // any other tab: hide it
                } catch (e) {}
              }
            },
            get children() {
              return [createComponent(Tab.TabList, {
                "class": "victories-tab-width self-center text-base font-base",
                nextHotkey: "nav-next",
                previousHotkey: "nav-previous",
                get titleClass() {
                  return `${LayoutModel.get().screenWidthDownScaled() < 1600 ? "text-2xs ml-2" : `${LayoutModel.get().screenWidthDownScaled() <= 1920 ? "text-xs ml-2" : ""}`}`;
                }
              }), (() => {
                var _el$ = _tmpl$(), _el$2 = _el$.firstChild, _el$3 = _el$2.nextSibling;
                insert(_el$, createComponent(Tab.Output, {}), null);
                createRenderEffect(() => className(_el$, `${isSmallScreen() ? "mt-2" : "mt-8"} flex flex-col flex-auto bg-accent-6 items-center mb-5 pl-8 pr-8 pt-8 relative victories-panel-container`));
                _el$.id = "rewind-panel-container";   // measured by the playback layout
                return _el$;
              })(), createComponent(Tab.Item, {
                name: "summary",
                title: () => "LOC_PEDIA_PAGE_CHAPTER_SUMMARY_TITLE",
                body: () => createComponent(VictoriesSummary, {})
              }), createComponent(Tab.Item, {
                name: "cultural",
                title: () => "LOC_VICTORY_CULTURE_MODERN_NAME",
                body: () => createComponent(CultureVictoryTab, mergeProps(() => model.data.cultureDetails))
              }), createComponent(Tab.Item, {
                name: "economic",
                title: () => "LOC_VICTORY_ECONOMIC_MODERN_NAME",
                body: () => createComponent(EconomicVictoryTab, {})
              }), createComponent(Tab.Item, {
                name: "military",
                title: () => "LOC_VICTORY_MILITARY_MODERN_NAME",
                body: () => createComponent(MilitaryVictoryTab, {})
              }), createComponent(Tab.Item, {
                name: "scientific",
                title: () => "LOC_VICTORY_SCIENCE_MODERN_NAME",
                body: () => createComponent(ScienceVictoryTab, mergeProps(() => model.data.scienceDetails))
              }), createComponent(Tab.Item, {
                name: "score",
                title: () => "LOC_VICTORY_SCORE_NAME",
                body: () => createComponent(ScoreVictoryTab, {})
              }), createComponent(Tab.Item, {
                name: "rewind",
                title: () => "Rewind",
                // Native "Loading map…" content: renders instantly when the tab is selected (so the tab
                // transition is never gated on our work). Our map overlay is opaque and sits on top, so
                // it simply covers this text once it's revealed — no coordination needed.
                body: () => {
                  const d = document.createElement("div");
                  d.style.cssText = "display:flex;flex:1 1 auto;align-items:center;justify-content:center;min-height:240px;font-family:monospace;font-size:26px;letter-spacing:2px;color:#cdddff;text-transform:uppercase;";
                  d.textContent = "Loading map…";
                  return d;
                }
              })];
            }
          }), createComponent(Show, {
            get when() {
              return props.endGameScreen;
            },
            get children() {
              var _el$4 = _tmpl$2();
              _el$4.id = "rewind-endgame-buttons";   // measured by the playback layout (Exit-button keep-out)
              // Raise ONLY the z-index (the element is already position:absolute bottom-right via its class —
              // do NOT set position, that removes right-10 and dumps it to the left) so this Exit button stays
              // above our full-width control panel (z 99998) instead of being covered by it.
              _el$4.style.zIndex = "100001";
              insert(_el$4, createComponent(Show, {
                get when() {
                  return props.allowOneMoreTurn;
                },
                get children() {
                  return createComponent(Button, {
                    onActivate: () => {
                      justOneMoreTurn();
                    },
                    hotkeyAction: "nav-shell-previous",
                    navTrayText: "LOC_END_GAME_CONTINUE",
                    "class": "mr-8",
                    get children() {
                      return createComponent(L10n.Compose, {
                        text: "LOC_END_GAME_CONTINUE"
                      });
                    }
                  });
                }
              }), null);
              insert(_el$4, createComponent(Show, {
                get when() {
                  return !props.showNextTurnButton;
                },
                get children() {
                  return createComponent(Button, {
                    onActivate: () => {
                      engine.call("exitToMainMenu");
                    },
                    hotkeyAction: "nav-shell-next",
                    navTrayText: "LOC_END_GAME_EXIT",
                    get children() {
                      return createComponent(L10n.Compose, {
                        text: "LOC_END_GAME_EXIT"
                      });
                    }
                  });
                }
              }), null);
              insert(_el$4, createComponent(Show, {
                get when() {
                  return props.showNextTurnButton;
                },
                get children() {
                  return createComponent(Button, {
                    onActivate: () => {
                      advanceToNextPlayer();
                    },
                    hotkeyAction: "nav-shell-next",
                    navTrayText: "LOC_ACTION_PANEL_NEXT_TURN",
                    get children() {
                      return createComponent(L10n.Compose, {
                        text: "LOC_ACTION_PANEL_NEXT_TURN"
                      });
                    }
                  });
                }
              }), null);
              return _el$4;
            }
          })];
        }
      });
    }
  });
};

// Safe mode (main-menu toggle): skip the VictoriesScreen override entirely. This is the riskiest
// piece (it replaces a base screen), so the escape hatch must neutralize it.
function rewindDisabled() { try { return UI.getOption('user', 'Interface', 'RewindDisabled') == 1; } catch (e) { return false; } }
if (rewindDisabled()) {
  log('safe mode ON — skipping VictoriesScreen override');
} else {
  try {
    ComponentRegistry.register({
      name: "VictoriesScreen",
      styles: [style],
      overridePriority: 100,
      createInstance: VictoriesScreenWithRewind
    });
    log('endgame tab: registered VictoriesScreen override (+Rewind tab)');
  } catch (e) { err(`endgame tab register failed: ${e}`); }
}
