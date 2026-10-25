#!/bin/sh
# Links the Morsel control surface into Live's User Library, so edits here are what Live loads.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/Music/Ableton/User Library/Remote Scripts"
mkdir -p "$dest"
for script in Morsel Morsel_Keys; do
  ln -sfn "$here/$script" "$dest/$script"
  echo "Linked $dest/$script -> $here/$script"
done
echo "Restart Live, then Settings > Link, Tempo & MIDI: Control Surface Morsel (DAW ports) and Morsel_Keys (MIDI Out)."
