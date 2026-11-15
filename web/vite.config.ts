import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      manifest: {
        id: "/",
        name: "negi",
        short_name: "negi",
        description: "tmux and your Mac's screen, on your phone",
        start_url: "/",
        scope: "/",
        display: "standalone",
        // The splash shows before the page picks its theme; dark is the gentler guess.
        background_color: "#1b1d20",
        theme_color: "#1b1d20",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          // The face sits inside the middle 80 %, so a launcher's circle or squircle keeps it.
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Not the page: the server writes its build into it. It comes from the network, and
        // from the cache only when the Mac cannot be reached.
        globPatterns: ["**/*.{js,css,woff2,avif,png,webp,svg}"],
        // Scripts other than Latin load from the server when a pane prints them.
        globIgnores: ["**/sn-pro-{cyrillic,cyrillic-ext,latin-ext,vietnamese}-*"],
        navigateFallback: null,
        runtimeCaching: [
          {
            urlPattern: ({ request, url }) => request.mode === "navigate" && !url.pathname.startsWith("/api/"),
            handler: "NetworkFirst",
            options: { cacheName: "page", expiration: { maxEntries: 4 } },
          },
        ],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  server: {
    // `pnpm dev` talks to a negi already running on its default port.
    proxy: { "/api": { target: "http://127.0.0.1:8791", ws: true } },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
