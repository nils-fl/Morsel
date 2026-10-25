#!/bin/sh
# Links the Morsel control surface into Live's User Library, so edits here are what Live loads.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/Music/Ableton/User Library/Remote Scripts"
mkdir -p "$dest"
ln -sfn "$here/Morsel" "$dest/Morsel"
echo "Linked $dest/Morsel -> $here/Morsel"
echo "Restart Live, then Settings > Link, Tempo & MIDI > Control Surface: Morsel."
