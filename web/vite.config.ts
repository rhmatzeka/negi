import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  server: {
    // `pnpm dev` talks to a negi already running on its default port.
    proxy: { "/api": { target: "http://127.0.0.1:8791", ws: true } },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
