#!/usr/bin/env bash
# Deploy the Civ 7 Rewind mod into the Mods folder as a REAL directory copy.
#
# This machine runs Civ 7 under Proton, so the live user-data dir is the WINDOWS
# layout inside the Proton prefix (AppData\Local\Firaxis Games\...), NOT the native
# ~/My Games path (that one is a stale leftover). We auto-detect the active install
# by picking the candidate with the most recently modified Mods.sqlite.
#
# We copy rather than symlink because the mod scanner doesn't reliably follow
# symlinked dirs. Re-run after every edit, then fully restart Civ 7 to rescan.
#
# Usage:
#   scripts/deploy.sh            # deploy the Rewind mod (rewind/)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PFX="$HOME/.steam/debian-installation/steamapps/compatdata/1295660/pfx/drive_c/users/steamuser"
# Candidate user-data roots, in rough order of likelihood.
CANDIDATES=(
  "$PFX/AppData/Local/Firaxis Games/Sid Meier's Civilization VII"
  "$PFX/Documents/My Games/Sid Meier's Civilization VII"
  "$HOME/My Games/Sid Meier's Civilization VII"
)

# Pick the active root = the one whose Mods.sqlite was modified most recently.
DATA_DIR=""
best_mtime=0
for c in "${CANDIDATES[@]}"; do
  db="$c/Mods.sqlite"
  if [[ -f "$db" ]]; then
    m=$(stat -c '%Y' "$db")
    if (( m > best_mtime )); then best_mtime=$m; DATA_DIR="$c"; fi
  fi
done

if [[ -z "$DATA_DIR" ]]; then
  echo "ERROR: could not locate an active Civ 7 data dir (no Mods.sqlite found)." >&2
  printf '  checked:\n'; printf '    %s\n' "${CANDIDATES[@]}" >&2
  exit 1
fi

MODS_DIR="$DATA_DIR/Mods"
mkdir -p "$MODS_DIR"
echo "Active install: $DATA_DIR"
echo "  (Mods.sqlite last modified: $(stat -c '%y' "$DATA_DIR/Mods.sqlite" | cut -d. -f1))"

# copy_mod <source-dir> <dest-folder-name>
copy_mod() {
  local src="$1" dest="$MODS_DIR/$2"
  rm -rf "$dest"
  mkdir -p "$dest"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$src"/ "$dest"/
  else
    cp -a "$src"/. "$dest"/
  fi
  echo "Deployed: $src/  ->  $dest/"
  find "$dest" -type f -printf '    %P\n'
}

copy_mod "$REPO_DIR/rewind" "rewind_map_history"

# The mod's id/folder was renamed (civ7-rewind -> rewind_map_history); remove the old deployment so the
# game doesn't load two copies. (Old test saves referenced the old id and won't load — they were throwaway.)
if [[ -e "$MODS_DIR/civ7-rewind" ]]; then
  rm -rf "$MODS_DIR/civ7-rewind"
  echo "Removed old deployment: $MODS_DIR/civ7-rewind"
fi

# Clean up any stale copies left in the native ~/My Games path from earlier attempts.
for name in civ7-rewind civ7-rewind-poc; do
  STALE="$HOME/My Games/Sid Meier's Civilization VII/Mods/$name"
  if [[ "$MODS_DIR" != "$HOME/My Games/Sid Meier's Civilization VII/Mods" && ( -e "$STALE" || -L "$STALE" ) ]]; then
    rm -rf "$STALE"; echo "Removed stale copy at: $STALE"
  fi
done

echo
echo "LOGS for this install: $DATA_DIR/Logs/UI.log  (grep '[REWIND]')"
echo "Now FULLY restart Civ 7 (quit to desktop, relaunch), then check Add-Ons."
