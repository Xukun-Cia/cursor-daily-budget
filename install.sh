#!/bin/bash
# Install / sync Cursor Daily Budget extension to local Cursor
for ver in 0.1.0 0.2.0 0.3.0 0.3.1 0.4.0 0.5.0 0.5.1 0.5.2 0.5.3 0.5.4 0.6.0 0.6.1 0.6.2 0.6.3; do
  [ -d "$HOME/.cursor/extensions/local.cursor-daily-budget-$ver" ] && \
    rm -rf "$HOME/.cursor/extensions/local.cursor-daily-budget-$ver"
done
EXT_DIR="$HOME/.cursor/extensions/local.cursor-daily-budget-0.6.4"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$EXT_DIR/lib"
cp "$SRC_DIR/package.json" "$EXT_DIR/"
cp "$SRC_DIR/extension.js" "$EXT_DIR/"
cp "$SRC_DIR/lib/"*.js "$EXT_DIR/lib/"
cp "$SRC_DIR/lib/"*.json "$EXT_DIR/lib/"

echo "✓ Synced to $EXT_DIR"
echo "  Please reload Cursor window (Ctrl+Shift+P → Developer: Reload Window)"
