import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      "#transport": fileURLToPath(
        new URL(
          mode === "browser"
            ? "./src/transport/browser.ts"
            : "./src/transport/native.ts",
          import.meta.url,
        ),
      ),
    },
  },
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7878",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (request) =>
            request.setHeader("origin", "http://127.0.0.1:7878"),
          );
        },
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 650,
    outDir: mode === "browser" ? "dist-browser" : "dist",
  },
  worker: { format: "es" },
}));
