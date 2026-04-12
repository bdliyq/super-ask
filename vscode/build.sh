#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

VERSION=$(node -p "require('./package.json').version")
VSIX_NAME="super-ask-vscode-${VERSION}.vsix"

if [ ! -d "node_modules" ]; then
  echo "[1/3] Installing dependencies..."
  npm install
else
  echo "[1/3] Dependencies exist, skipping (delete node_modules to reinstall)"
fi

echo "[2/3] Building..."
npm run build

echo "[3/3] Packaging VSIX..."
if ! command -v vsce &> /dev/null; then
  echo "  Installing @vscode/vsce..."
  npm install -g @vscode/vsce
fi
vsce package --no-dependencies -o "$VSIX_NAME"

echo ""
echo "Done: $(pwd)/${VSIX_NAME}"
echo ""
echo "Install to VSCode:"
echo "  code --install-extension ${VSIX_NAME}"
echo ""
echo "Install to Cursor (WebView only, Tool API not supported):"
echo "  cursor --install-extension ${VSIX_NAME}"
