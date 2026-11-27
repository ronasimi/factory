#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${FACTORY_INSTALL_DIR:-$HOME/.local/share/factory}"
BIN_DIR="${FACTORY_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${FACTORY_STATE_DIR:-$HOME/.factory}"
PURGE_STATE="${1:-}"

rm -f "$BIN_DIR/factory"
rm -rf "$INSTALL_DIR"

echo "Removed factory launcher ($BIN_DIR/factory) and app dir ($INSTALL_DIR)."
if [[ "$PURGE_STATE" == "--purge-state" ]]; then
  rm -rf "$STATE_DIR"
  echo "Purged factory state dir ($STATE_DIR)."
else
  echo "Preserved state dir ($STATE_DIR). Pass --purge-state to remove it."
fi
