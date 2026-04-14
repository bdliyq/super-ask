import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Vite 配置：React、@shared 别名、开发代理到 super-ask Server、构建输出到 server 静态目录
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 与 tsconfig paths 一致，便于从 UI 引用共享类型
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  server: {
    // 本地 Server 默认 127.0.0.1:19960；WebSocket 走 /ws 时需 ws: true
    proxy: {
      "/super-ask": {
        target: "http://127.0.0.1:19960",
        changeOrigin: true,
      },
      "/health": {
        target: "http://127.0.0.1:19960",
        changeOrigin: true,
      },
      "/ws": {
        target: "http://127.0.0.1:19960",
        ws: true,
        changeOrigin: true,
      },
      "/api": {
        target: "http://127.0.0.1:19960",
        changeOrigin: true,
      },
      "/uploads": {
        target: "http://127.0.0.1:19960",
        changeOrigin: true,
      },
    },
  },
  build: {
    // 产物供 Go/Node 等静态托管，与 API 同源便于 /ws
    outDir: path.resolve(__dirname, "../server/static"),
    emptyOutDir: true,
  },
});
