# REWIND: Civ 7 Replay Map History

REWIND is a Civilization VII replay mod that records your game turn-by-turn and lets you replay your map history as an animated timelapse. View the endgame map replay in a new Rewind tab on the Victories screen, or mid-game from a checkbox near the minimap. Territory, borders, cities, units, wonders, resources, and leader relationships are supported. Fog of war can be toggled, and is on by default to avoid spoiling the map. Enabling/disabling this mod does not impact your ability to load old saves.

## Install

**Steam Workshop:** subscribe at https://steamcommunity.com/sharedfiles/filedetails/?id=3759409080

**CivMods:** download at https://civmods.com/install?modCfId=32874

**Manual:** copy the `rewind/` folder into your Civilization VII `Mods` directory, e.g.

- Windows: `%LOCALAPPDATA%\Firaxis Games\Sid Meier's Civilization VII\Mods\`
- Linux (Proton): `…/compatdata/1295660/pfx/.../AppData/Local/Firaxis Games/Sid Meier's Civilization VII/Mods/`

then fully restart the game and enable it in **Add-Ons**.

## Notes

Previous versions of this mod were save affecting, but is no longer the case. This means enabling/disabling this mod will no longer impact your ability to load old saves.

## Development

The shipped mod lives in `rewind/`. `scripts/deploy.sh` copies it into the active Civ VII
`Mods` folder (auto-detects the Proton prefix on Linux); re-run it after edits and fully restart
the game.

## License

[MIT](LICENSE) © 2026 SLIM_AL
