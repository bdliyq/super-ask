#!/bin/bash
# 安装 super-ask 到 macOS launchd（开机自启动）
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLIST_NAME="com.super-ask.server"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"
TSX_BIN="$PROJECT_DIR/server/node_modules/.bin/tsx"
ENTRY="$PROJECT_DIR/server/src/index.ts"
LOG_DIR="$HOME/.super-ask/logs"

# 检测 Node.js 是否可用
if ! "$NODE_BIN" --version &>/dev/null; then
  echo "❌ Node.js 不可用: $NODE_BIN"
  exit 1
fi

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PLIST_PATH")"

cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_NAME</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$TSX_BIN</string>
    <string>$ENTRY</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/launchd-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/launchd-stderr.log</string>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR/server</string>
</dict>
</plist>
PLIST

# 卸载旧服务（如存在）
launchctl bootout gui/$(id -u) "$PLIST_PATH" 2>/dev/null || true

# 加载新服务
launchctl bootstrap gui/$(id -u) "$PLIST_PATH"

echo "✅ super-ask 已注册为 launchd 服务"
echo "   plist: $PLIST_PATH"
echo "   状态: launchctl print gui/$(id -u)/$PLIST_NAME"
echo "   日志: $LOG_DIR/"
