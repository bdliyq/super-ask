#!/bin/bash
# super-ask 一键构建与启动脚本（后台守护模式）
set -e
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-19960}"
LOG_FILE="$SCRIPT_DIR/server/super-ask.log"
# 与 server/src/pidManager.ts 保持一致，统一使用 ~/.super-ask/super-ask.pid
PID_FILE="$HOME/.super-ask/super-ask.pid"

echo "========================================="
echo "  Super Ask - 一键构建与启动"
echo "========================================="
echo ""

# 检测 Node.js 版本
NODE_BIN="node"
if command -v /usr/local/bin/node &>/dev/null; then
  NODE_VERSION=$(/usr/local/bin/node -e "console.log(process.versions.node.split('.')[0])")
  if [ "$NODE_VERSION" -ge 18 ] 2>/dev/null; then
    NODE_BIN="/usr/local/bin/node"
  fi
fi

CURRENT_VERSION=$($NODE_BIN -e "console.log(process.versions.node)" 2>/dev/null || echo "unknown")
echo "[1/7] Node.js: $CURRENT_VERSION ($NODE_BIN)"

MAJOR=$($NODE_BIN -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo "0")
if [ "$MAJOR" -lt 18 ] 2>/dev/null; then
  echo "❌ 需要 Node.js >= 18，当前为 v${CURRENT_VERSION}"
  exit 1
fi
echo "  ✅ 版本满足要求"
echo ""

# 停止已有进程
echo "[2/7] 停止旧进程..."

# 1) 通过 PID 文件停止（与 server 内部 pidManager 一致）
OLD_PID=""
if [ -f "$PID_FILE" ]; then
  # PID 文件是 JSON 格式，提取 pid 字段
  OLD_PID=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['pid'])" "$PID_FILE" 2>/dev/null) || OLD_PID=""
fi
if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
  echo "  ⏳ 停止旧进程 (PID: $OLD_PID) ..."
  kill "$OLD_PID" 2>/dev/null
  sleep 2
fi

# 2) 兜底：通过端口查找并杀掉所有占用进程
LISTEN_PIDS=$(lsof -ti:"$PORT" 2>/dev/null) || LISTEN_PIDS=""
if [ -n "$LISTEN_PIDS" ]; then
  echo "  ⏳ 端口 $PORT 仍被占用，强制清理..."
  echo "$LISTEN_PIDS" | xargs kill 2>/dev/null
  sleep 2
fi

# 3) 清理 PID 文件，防止新 server 启动时误判
rm -f "$PID_FILE"

# 4) 最终确认端口已释放
REMAINING=$(lsof -ti:"$PORT" 2>/dev/null) || REMAINING=""
if [ -n "$REMAINING" ]; then
  echo "  ⏳ 端口 $PORT 仍有残留进程，发送 SIGKILL..."
  echo "$REMAINING" | xargs kill -9 2>/dev/null
  sleep 1
fi
FINAL_PIDS=$(lsof -ti:"$PORT" 2>/dev/null) || FINAL_PIDS=""
if [ -n "$FINAL_PIDS" ]; then
  echo "  ⚠️  端口 $PORT 仍被占用，启动可能失败；请根据上述警告手动处理或更换端口。"
else
  echo "  ✅ 端口 $PORT 已释放"
fi
echo ""

# 安装 Server 依赖
echo "[3/7] 安装 Server 依赖..."
cd "$SCRIPT_DIR/server"
npm install --silent || { echo "❌ Server 依赖安装失败"; exit 1; }
echo "  ✅ Server 依赖安装完成"
echo ""

# 安装 UI 依赖
echo "[4/7] 安装 UI 依赖..."
cd "$SCRIPT_DIR/ui"
npm install --silent || { echo "❌ UI 依赖安装失败"; exit 1; }
echo "  ✅ UI 依赖安装完成"
echo ""

# 构建 UI（输出到 server/static/）
echo "[5/7] 构建 UI..."
cd "$SCRIPT_DIR/ui"
$NODE_BIN ./node_modules/.bin/vite build || { echo "❌ UI 构建失败"; exit 1; }
echo "  ✅ UI 构建完成 → server/static/"
echo ""

# 构建 Server
echo "[6/7] 构建 Server..."
cd "$SCRIPT_DIR/server"
npm run build || { echo "❌ Server 构建失败"; exit 1; }
echo "  ✅ Server 构建完成 → server/dist/"
echo ""

# 后台启动 Server
echo "[7/7] 后台启动 Server (端口: $PORT) ..."
cd "$SCRIPT_DIR/server"

if [ -s "$LOG_FILE" ]; then
  mv "$LOG_FILE" "${LOG_FILE%.log}.prev.log" 2>/dev/null || true
fi

nohup $NODE_BIN dist/index.js start --port "$PORT" \
  > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# 等待 server 启动完成（最多 10 秒），通过检查端口和 health 接口
echo "  ⏳ 等待 Server 启动..."
for i in $(seq 1 10); do
  sleep 1
  if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    break
  fi
done

if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
  # 从 server 写入的 PID 文件读取实际 PID（server 内部管理）
  ACTUAL_PID=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['pid'])" "$PID_FILE" 2>/dev/null || echo "$SERVER_PID")
  echo ""
  echo "========================================="
  echo "  ✅ Super Ask 已在后台运行！"
  echo "  PID:  $ACTUAL_PID"
  echo "  端口: $PORT"
  echo "  日志: $LOG_FILE"
  echo "  浏览器: http://127.0.0.1:$PORT"
  echo "========================================="
  echo ""
  echo "管理命令:"
  echo "  查看日志: tail -f $LOG_FILE"
  echo "  停止服务: kill $ACTUAL_PID"
  echo "  重启服务: bash $SCRIPT_DIR/install.sh $PORT"
  echo ""
  set +e
  open "http://127.0.0.1:$PORT" 2>/dev/null
  [ $? -ne 0 ] && xdg-open "http://127.0.0.1:$PORT" 2>/dev/null
  set -e
else
  echo "❌ Server 启动失败，查看日志:"
  echo "---"
  tail -20 "$LOG_FILE"
  echo "---"
  exit 1
fi
