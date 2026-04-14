#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VSIX_PATH="$SCRIPT_DIR/super-ask-vscode-1.0.2.vsix"

code --uninstall-extension leoli.super-ask 2>/dev/null
code --install-extension "$VSIX_PATH" --force
