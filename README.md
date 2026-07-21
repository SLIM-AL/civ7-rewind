# REWIND: Replay Map History

A **Sid Meier's Civilization VII** mod that records your game turn-by-turn and replays it
as an animated hex-map timelapse — territory, borders, cities, units, wonders and resources
across the whole game.

Watch it in a new **Rewind** tab on the end-game Victories screen, or live in-game from a
checkbox next to the minimap (with or without fog of war).

## Features

- **Turn-by-turn timelapse** of the whole map, reconstructed from a compact recording.
- **Toggleable layers**: territory fills, borders, city/capital markers, units, wonders, resources.
- **Fog of war** toggle — history-aware (leaders and tiles appear only once you'd met/seen them).
- **Playback controls**: play/pause, step, 0.5×/1×/2×/4× speed, and a draggable scrubber with a
  per-turn tooltip.
- **Leader ribbon** showing the players present each turn, in their (age-correct) civ colors.

## Install

**Steam Workshop:** subscribe to the item at https://steamcommunity.com/sharedfiles/filedetails/?id=3759409080.

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
