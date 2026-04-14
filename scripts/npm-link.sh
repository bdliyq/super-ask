#!/bin/bash
# 将 super-ask 链接为全局命令（npm link）
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "构建 Server..."
cd "$PROJECT_DIR/server"
npm run build

echo "链接为全局命令..."
npm link

echo "✅ super-ask 已可用为全局命令"
echo "   验证: super-ask status"
