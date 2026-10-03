import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY ?? "http://127.0.0.1:3001",
        timeout: 180_000,
        proxyTimeout: 180_000,
      },
      "/a2ui": {
        target: process.env.VITE_API_PROXY ?? "http://127.0.0.1:3001",
      },
    },
  },
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
  },
});
