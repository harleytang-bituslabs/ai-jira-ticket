import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// root = web/（npm scripts 里以 `vite <cmd> web` 调用）；产物 web/dist 由 Express 托管。
export default defineConfig({
  plugins: [react()],
  server: {
    // 本地开发：vite 起前端热更新，API 透传给 tsx 起的后端
    proxy: { "/api": "http://localhost:9300" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
