#!/bin/bash
# 卸载 super-ask launchd 服务
PLIST_NAME="com.super-ask.server"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

launchctl bootout gui/$(id -u) "$PLIST_PATH" 2>/dev/null || true
rm -f "$PLIST_PATH"

echo "✅ super-ask launchd 服务已卸载"
