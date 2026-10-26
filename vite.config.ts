import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** 端口与 Tauri 约定保持一致；移动端调试时通过 TAURI_DEV_HOST 暴露。 */
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    chunkSizeWarningLimit: 1500,
  },
});
