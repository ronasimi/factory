#!/usr/bin/env bash
set -euo pipefail

# Conflict-free installer for factory.
# Keeps all files isolated from stock `pi` (~/.pi, `pi` binary):
#   - Binary:  ${FACTORY_BIN_DIR:-$HOME/.local/bin}/factory
#   - App dir: ${FACTORY_INSTALL_DIR:-$HOME/.local/share/factory}
#   - State:   ${FACTORY_STATE_DIR:-$HOME/.factory}

REPO_URL="${FACTORY_REPO_URL:-https://github.com/ronasimi/factory.git}"
INSTALL_DIR="${FACTORY_INSTALL_DIR:-$HOME/.local/share/factory}"
BIN_DIR="${FACTORY_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${FACTORY_STATE_DIR:-$HOME/.factory}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_SOURCE="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js >= 22.19.0 is required." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 19) )); then
  echo "Error: Node.js >= 22.19.0 is required (found $(node -v))." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$BIN_DIR" "$STATE_DIR"

if [[ -f "$LOCAL_SOURCE/package.json" ]] && grep -q '"@ronasimi/factory"' "$LOCAL_SOURCE/package.json"; then
  echo "Installing factory from local source: $LOCAL_SOURCE -> $INSTALL_DIR"
  rm -rf "$INSTALL_DIR/bin" "$INSTALL_DIR/src" "$INSTALL_DIR/dist" "$INSTALL_DIR/scripts"
  cp -a "$LOCAL_SOURCE/package.json" "$LOCAL_SOURCE/tsconfig.json" "$INSTALL_DIR/"
  [[ -f "$LOCAL_SOURCE/package-lock.json" ]] && cp -a "$LOCAL_SOURCE/package-lock.json" "$INSTALL_DIR/"
  [[ -f "$LOCAL_SOURCE/README.md" ]] && cp -a "$LOCAL_SOURCE/README.md" "$INSTALL_DIR/"
  cp -a "$LOCAL_SOURCE/bin" "$LOCAL_SOURCE/src" "$LOCAL_SOURCE/scripts" "$INSTALL_DIR/"
  [[ -d "$LOCAL_SOURCE/dist" ]] && cp -a "$LOCAL_SOURCE/dist" "$INSTALL_DIR/"
else
  echo "Cloning $REPO_URL -> $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
if [[ ! -d "$INSTALL_DIR/node_modules" ]]; then
  if [[ -f "$INSTALL_DIR/package-lock.json" ]]; then
    npm ci
  else
    npm install
  fi
fi

if [[ ! -f "$INSTALL_DIR/dist/bin/factory.js" ]]; then
  npm run build
fi

LAUNCHER="$BIN_DIR/factory"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export FACTORY_STATE_DIR="\${FACTORY_STATE_DIR:-$STATE_DIR}"
exec node "$INSTALL_DIR/dist/bin/factory.js" "\$@"
EOF
chmod +x "$LAUNCHER"

echo ""
echo "Installed factory successfully (isolated from stock pi):"
echo "  Launcher: $LAUNCHER"
echo "  App dir:  $INSTALL_DIR"
echo "  State:    $STATE_DIR"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo ""
  echo "Note: $BIN_DIR is not in your PATH. Add:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
fi

echo ""
"$LAUNCHER" --version >/dev/null && echo "Verified: $LAUNCHER --version -> $("$LAUNCHER" --version)"
